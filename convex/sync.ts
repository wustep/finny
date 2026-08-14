"use node";

// The Plaid -> Notion sync engine.
//
// A sync for one bank connection runs as a chain of actions so large
// backfills never hit action time limits:
//
//   runForConnection            (bank connection page, accounts, balances,
//                                holdings + securities)
//     -> transactionsBatch      (one transactions/sync page per invocation,
//                                reschedules itself while has_more)
//     -> investmentsBatch       (one page of investment transactions per
//                                invocation, reschedules itself)
//     -> finishRun
//
// Every Notion row is keyed through the notionPageMap table (providerId ->
// Notion page id), which makes all steps idempotent: reruns update pages
// in place instead of duplicating them.
//
// The whole chain runs under one exclusive lease per connection
// (bankConnections.syncLockExpiresAt / activeRunId), taken by
// syncData.beginRun, heartbeated by each hop, and released by
// syncData.finishRun — which is therefore on every exit path.

import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import type {
  CreditCardLiability,
  Security,
  Transaction,
} from "plaid";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalAction, type ActionCtx } from "./_generated/server";
import {
  P,
  accountTitle,
  archivePage,
  categoryName,
  createPage,
  externalIcon,
  fileUploadIcon,
  findPageByText,
  setPageIcon,
  titleCase,
  todayUTC,
  updatePage,
  uploadDataUri,
} from "./notionApi";
import { plaidClient } from "./plaidClient";
import {
  accountProperties,
  balanceForNotion,
  investmentTransactionProperties,
  transactionIcon,
  transactionProperties,
} from "./syncMappers";

const TXN_BATCH_SIZE = 100;
const INV_BATCH_SIZE = 100;

// How many runs may fail on the same transactions/sync page before its
// unwritable rows are abandoned and the cursor moves on.
const MAX_CURSOR_ATTEMPTS = 3;

interface SyncContext {
  connection: Doc<"bankConnections">;
  notion: Doc<"notionConnections">;
  accounts: Doc<"accounts">[];
}

async function loadContext(
  ctx: ActionCtx,
  connectionId: Id<"bankConnections">,
): Promise<SyncContext | null> {
  const context = await ctx.runQuery(internal.syncData.getContext, {
    connectionId,
  });
  if (!context || !context.notion?.databases) {
    return null;
  }
  return context as SyncContext;
}

// ---------- triggers ----------

export const triggerManual = action({
  args: { connectionId: v.id("bankConnections") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not signed in");
    }
    const hasAccess = await ctx.runQuery(internal.access.hasAccessInternal, {
      userId,
    });
    if (!hasAccess) {
      throw new Error("Access password required");
    }
    const context = await ctx.runQuery(internal.syncData.getContext, {
      connectionId: args.connectionId,
    });
    if (!context || context.connection.userId !== userId) {
      throw new Error("Connection not found");
    }
    if (!context.notion?.databases) {
      throw new Error("Set up the Notion destination first");
    }
    await ctx.scheduler.runAfter(0, internal.sync.runForConnection, {
      connectionId: args.connectionId,
      trigger: "manual",
    });
  },
});

// Rebuild everything from scratch: forget every Notion page id this app has
// recorded, rewind the transactions cursors, and start a fresh sync for each
// connection.
//
// Delete the rows in Notion *before* running this. Nothing here touches
// Notion, so any rows left behind stay behind, and the rebuild writes new
// ones alongside them. Categories are the exception — those are matched back
// up by their ID property (see ensureCategoryPage).
export const resetAndResync = action({
  args: {},
  handler: async (ctx): Promise<{ connections: number }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not signed in");
    }
    const hasAccess = await ctx.runQuery(internal.access.hasAccessInternal, {
      userId,
    });
    if (!hasAccess) {
      throw new Error("Access password required");
    }
    return await resetUser(ctx, userId);
  },
});

// Same thing for `npx convex run`, which has no signed-in user to read.
export const resetAndResyncByEmail = internalAction({
  args: { email: v.string() },
  handler: async (ctx, args): Promise<{ connections: number }> => {
    const userId = await ctx.runQuery(internal.syncData.getUserIdByEmail, {
      email: args.email,
    });
    if (!userId) {
      throw new Error(`No user with email ${args.email}`);
    }
    return await resetUser(ctx, userId);
  },
});

async function resetUser(
  ctx: ActionCtx,
  userId: Id<"users">,
): Promise<{ connections: number }> {
  while (await ctx.runMutation(internal.syncData.clearMapEntries, { userId })) {
    // Batched; keep going until the table is empty for this user.
  }
  const connectionIds = await ctx.runMutation(internal.syncData.clearCursors, {
    userId,
  });
  for (const connectionId of connectionIds) {
    await ctx.scheduler.runAfter(0, internal.sync.runForConnection, {
      connectionId,
      trigger: "manual",
    });
  }
  return { connections: connectionIds.length };
}

// ---------- stage 1: connection, accounts, balances, holdings ----------

export const runForConnection = internalAction({
  args: {
    connectionId: v.id("bankConnections"),
    trigger: v.union(
      v.literal("initial"),
      v.literal("webhook"),
      v.literal("manual"),
      v.literal("cron"),
    ),
  },
  handler: async (ctx, args) => {
    const context = await loadContext(ctx, args.connectionId);
    if (!context) {
      console.log("sync skipped: no Notion destination", args.connectionId);
      return;
    }
    const { connection, notion, accounts } = context;
    // Exactly one run per connection at a time, whatever triggered it: the
    // Plaid cursor and the Notion page map are both shared mutable state.
    // A webhook that loses the race queues itself a retry from inside the
    // same mutation rather than being dropped.
    const lease = await ctx.runMutation(internal.syncData.beginRun, {
      userId: connection.userId,
      connectionId: connection._id,
      trigger: args.trigger,
    });
    if (!lease.acquired) {
      console.log("sync skipped: connection is already syncing", connection._id);
      return;
    }
    const runId = lease.runId;

    try {
      const client = plaidClient(connection.plaidEnv ?? "production");
      const databases = notion.databases!;
      const token = notion.accessToken;
      const enabled = accounts.filter((account) => account.syncEnabled);
      const enabledIds = new Set(enabled.map((a) => a.plaidAccountId));
      const customNames = new Map(
        accounts
          .filter((a) => a.customName)
          .map((a) => [a.plaidAccountId, a.customName as string]),
      );

      const icon = institutionIcon(ctx, connection, token);

      // 1. Bank Connection page
      const connectionPageId = await upsertMapped(ctx, connection.userId, {
        kind: "bankConnection",
        providerId: connection.plaidItemId,
        token,
        databaseId: databases.bankConnections,
        properties: {
          Name: P.title(connection.institutionName),
          ID: P.text(connection.plaidItemId),
          Status: P.select(
            connection.status === "active"
              ? "Active"
              : connection.status === "error"
                ? "Error"
                : "Pending expiration",
          ),
          "Last Update": P.date(new Date().toISOString()),
        },
        runId,
        icon,
      });

      // 2. Accounts (+ credit liabilities when available)
      const balances = await client.accountsGet({
        access_token: connection.accessToken,
      });
      let credit: Record<string, CreditCardLiability> = {};
      if (balances.data.accounts.some((a) => a.type === "credit")) {
        try {
          const liabilities = await client.liabilitiesGet({
            access_token: connection.accessToken,
          });
          credit = Object.fromEntries(
            (liabilities.data.liabilities.credit ?? []).map((entry) => [
              entry.account_id ?? "",
              entry,
            ]),
          );
        } catch (error) {
          console.log("liabilities unavailable for item", error);
        }
      }

      const accountPages: Record<string, string> = {};
      for (const account of balances.data.accounts) {
        if (!enabledIds.has(account.account_id)) {
          continue;
        }
        const pageId = await upsertMapped(ctx, connection.userId, {
          kind: "account",
          providerId: account.account_id,
          token,
          databaseId: databases.accounts,
          properties: accountProperties(
            connection.institutionName,
            account,
            credit[account.account_id],
            connectionPageId,
            customNames.get(account.account_id),
          ),
          runId,
          icon,
        });
        accountPages[account.account_id] = pageId;

        // 3. Daily balance snapshot (one row per account per day)
        if (notion.modules.balances && databases.balanceHistory) {
          const day = todayUTC();
          await upsertMapped(ctx, connection.userId, {
            kind: "balanceSnapshot",
            providerId: `${account.account_id}|${day}`,
            token,
            databaseId: databases.balanceHistory,
            properties: {
              Summary: P.title(
                `${day} · ${accountTitle(
                  connection.institutionName,
                  account,
                  customNames.get(account.account_id),
                )}`,
              ),
              Account: P.relation(pageId),
              Balance: P.number(balanceForNotion(account)),
              Date: P.date(day),
            },
            runId,
          });
        }
      }

      // 4. Holdings + securities
      if (
        notion.modules.investments &&
        databases.holdings &&
        balances.data.accounts.some(
          (a) => a.type === "investment" && enabledIds.has(a.account_id),
        )
      ) {
        await syncHoldings(ctx, {
          context,
          runId,
          accountPages,
        });
      }

      // 5. Hand off to the transaction chain
      if (notion.modules.spending && databases.transactions) {
        await ctx.scheduler.runAfter(0, internal.sync.transactionsBatch, {
          connectionId: connection._id,
          runId,
        });
      } else if (notion.modules.investments && databases.investmentTransactions) {
        await ctx.scheduler.runAfter(0, internal.sync.investmentsBatch, {
          connectionId: connection._id,
          runId,
          offset: 0,
        });
      } else {
        await ctx.runMutation(internal.syncData.finishRun, {
          runId,
          status: "success",
        });
      }
    } catch (error) {
      console.error("sync failed", error);
      await ctx.runMutation(internal.syncData.finishRun, {
        runId,
        status: "error",
        error: String(error),
      });
    }
  },
});

// ---------- stage 2: transactions (self-rescheduling) ----------

export const transactionsBatch = internalAction({
  args: {
    connectionId: v.id("bankConnections"),
    runId: v.id("syncRuns"),
  },
  handler: async (ctx, args) => {
    const context = await loadContext(ctx, args.connectionId);
    if (!context) {
      return;
    }
    const { connection, notion, accounts } = context;
    if (!(await heartbeat(ctx, args.connectionId, args.runId))) {
      return;
    }
    const databases = notion.databases!;
    const token = notion.accessToken;
    const userId = connection.userId;

    try {
      const client = plaidClient(connection.plaidEnv ?? "production");
      const response = await client.transactionsSync({
        access_token: connection.accessToken,
        cursor: connection.transactionsCursor,
        count: TXN_BATCH_SIZE,
        options: { include_original_description: true },
      });
      const { added, modified, removed, next_cursor, has_more } = response.data;

      const enabledIds = new Set(
        accounts.filter((a) => a.syncEnabled).map((a) => a.plaidAccountId),
      );
      const startDate = notion.startDate;
      const inScope = (txn: Transaction) =>
        enabledIds.has(txn.account_id) &&
        (!startDate || txn.date >= startDate);

      const accountPages = await ctx.runQuery(
        internal.syncData.getAllMapEntries,
        { userId, kind: "account" },
      );
      const categoryPages = await ctx.runQuery(
        internal.syncData.getAllMapEntries,
        { userId, kind: "category" },
      );
      const txnIds = [
        ...added.map((t) => t.transaction_id),
        ...added.map((t) => t.pending_transaction_id).filter(Boolean),
        ...modified.map((t) => t.transaction_id),
        ...removed.map((t) => t.transaction_id ?? ""),
      ].filter(Boolean) as string[];
      const txnPages = await ctx.runQuery(internal.syncData.getMapEntries, {
        userId,
        kind: "transaction",
        providerIds: txnIds,
      });

      let stats = { added: 0, modified: 0, removed: 0 };
      // Plaid never re-sends a page once its cursor is consumed, so a row we
      // could not write is a row lost forever unless the cursor stays put.
      let failures = 0;
      const newEntries: Array<{ providerId: string; notionPageId: string }> =
        [];

      const ensureCategory = async (txn: Transaction) => {
        const pfc = txn.personal_finance_category;
        if (!pfc?.detailed || !databases.categories) {
          return null;
        }
        if (categoryPages[pfc.detailed]) {
          return categoryPages[pfc.detailed];
        }
        const pageId = await ensureCategoryPage(ctx, {
          userId,
          token,
          databaseId: databases.categories,
          detailed: pfc.detailed,
          primary: pfc.primary,
          iconUrl: txn.personal_finance_category_icon_url ?? undefined,
        });
        if (pageId) {
          categoryPages[pfc.detailed] = pageId;
        }
        return pageId;
      };

      for (const txn of added) {
        if (!inScope(txn)) {
          continue;
        }
        const accountPage = accountPages[txn.account_id];
        if (!accountPage) {
          // The account page is made in stage 1; missing means that failed.
          console.error("no account page for transaction", txn.transaction_id);
          failures++;
          continue;
        }
        try {
          const categoryPage = await ensureCategory(txn);
          const properties = transactionProperties(txn, accountPage, categoryPage);
          // Merchant logos ride along in the request we are already making,
          // so keeping them current costs no extra calls.
          const icon = transactionIcon(txn);
          const existing = txnPages[txn.transaction_id];
          const pendingPage = txn.pending_transaction_id
            ? txnPages[txn.pending_transaction_id]
            : undefined;
          if (existing) {
            await updatePage(token, existing, properties, icon);
            stats.modified++;
          } else if (pendingPage) {
            // Pending -> posted: update the page we made for the pending
            // transaction and re-key its mapping to the posted id.
            await updatePage(token, pendingPage, properties, icon);
            await ctx.runMutation(internal.syncData.rekeyMapEntry, {
              userId,
              kind: "transaction",
              fromProviderId: txn.pending_transaction_id!,
              toProviderId: txn.transaction_id,
            });
            txnPages[txn.transaction_id] = pendingPage;
            delete txnPages[txn.pending_transaction_id!];
            stats.modified++;
          } else {
            const page = await createPage(
              token,
              databases.transactions,
              properties,
              icon,
            );
            newEntries.push({
              providerId: txn.transaction_id,
              notionPageId: page.id,
            });
            txnPages[txn.transaction_id] = page.id;
            stats.added++;
          }
        } catch (error) {
          console.error("failed to sync transaction", txn.transaction_id, error);
          failures++;
        }
      }

      for (const txn of modified) {
        if (!inScope(txn)) {
          continue;
        }
        const pageId = txnPages[txn.transaction_id];
        const accountPage = accountPages[txn.account_id];
        if (!accountPage) {
          console.error("no account page for transaction", txn.transaction_id);
          failures++;
          continue;
        }
        try {
          const categoryPage = await ensureCategory(txn);
          const properties = transactionProperties(txn, accountPage, categoryPage);
          const icon = transactionIcon(txn);
          if (pageId) {
            await updatePage(token, pageId, properties, icon);
            stats.modified++;
          } else {
            const page = await createPage(
              token,
              databases.transactions,
              properties,
              icon,
            );
            newEntries.push({
              providerId: txn.transaction_id,
              notionPageId: page.id,
            });
            stats.added++;
          }
        } catch (error) {
          console.error("failed to update transaction", txn.transaction_id, error);
          failures++;
        }
      }

      const removedIds: string[] = [];
      for (const entry of removed) {
        const id = entry.transaction_id;
        if (!id) {
          continue;
        }
        const pageId = txnPages[id];
        if (!pageId) {
          continue;
        }
        try {
          await archivePage(token, pageId);
          removedIds.push(id);
          stats.removed++;
        } catch (error) {
          console.error("failed to archive transaction", id, error);
          failures++;
        }
      }

      if (newEntries.length > 0) {
        await ctx.runMutation(internal.syncData.putMapEntries, {
          userId,
          kind: "transaction",
          entries: newEntries,
        });
      }
      if (removedIds.length > 0) {
        await ctx.runMutation(internal.syncData.deleteMapEntries, {
          userId,
          kind: "transaction",
          providerIds: removedIds,
        });
      }
      // Consuming the cursor tells Plaid this page landed. Do it only when
      // it did: otherwise stop here and let the next run replay the page.
      // Rows already in notionPageMap replay as updates, not duplicates.
      const attempt = (connection.cursorFailures ?? 0) + 1;
      const abandonPage = failures > 0 && attempt >= MAX_CURSOR_ATTEMPTS;
      await ctx.runMutation(internal.syncData.addRunStats, {
        runId: args.runId,
        ...stats,
        skipped: abandonPage ? failures : 0,
      });

      if (failures > 0 && !abandonPage) {
        await ctx.runMutation(internal.syncData.recordCursorFailure, {
          connectionId: connection._id,
        });
        await ctx.runMutation(internal.syncData.finishRun, {
          runId: args.runId,
          status: "error",
          error:
            `${failures} transaction(s) failed to reach Notion (attempt ` +
            `${attempt} of ${MAX_CURSOR_ATTEMPTS}). Leaving the Plaid cursor ` +
            `in place so the next run retries this page.`,
        });
        return;
      }

      await ctx.runMutation(internal.syncData.setCursor, {
        connectionId: connection._id,
        cursor: next_cursor,
      });

      if (abandonPage) {
        // A row Notion will never accept — a rejected select option, a
        // deleted database — would otherwise block this Item's whole
        // transaction stream. Move past it and say so on the run.
        await ctx.runMutation(internal.syncData.finishRun, {
          runId: args.runId,
          status: "error",
          error:
            `Gave up on ${failures} transaction(s) after ${attempt} attempts ` +
            `and advanced the Plaid cursor past them. They will not be ` +
            `retried; check the logs for the underlying Notion error.`,
        });
        return;
      }

      if (has_more) {
        await ctx.scheduler.runAfter(0, internal.sync.transactionsBatch, {
          connectionId: connection._id,
          runId: args.runId,
        });
      } else if (
        notion.modules.investments &&
        databases.investmentTransactions
      ) {
        await ctx.scheduler.runAfter(0, internal.sync.investmentsBatch, {
          connectionId: connection._id,
          runId: args.runId,
          offset: 0,
        });
      } else {
        await ctx.runMutation(internal.syncData.finishRun, {
          runId: args.runId,
          status: "success",
        });
      }
    } catch (error) {
      console.error("transaction batch failed", error);
      await ctx.runMutation(internal.syncData.finishRun, {
        runId: args.runId,
        status: "error",
        error: String(error),
      });
    }
  },
});

// ---------- stage 3: investment transactions (self-rescheduling) ----------

export const investmentsBatch = internalAction({
  args: {
    connectionId: v.id("bankConnections"),
    runId: v.id("syncRuns"),
    offset: v.number(),
  },
  handler: async (ctx, args) => {
    const context = await loadContext(ctx, args.connectionId);
    if (!context) {
      return;
    }
    const { connection, notion, accounts } = context;
    if (!(await heartbeat(ctx, args.connectionId, args.runId))) {
      return;
    }
    const databases = notion.databases!;
    const token = notion.accessToken;
    const userId = connection.userId;

    try {
      const client = plaidClient(connection.plaidEnv ?? "production");
      // Full window from the configured start date. The ID map makes
      // re-processing overlap free of duplicates.
      const start = notion.startDate ?? "2000-01-01";
      const end = todayUTC();
      let response;
      try {
        response = await client.investmentsTransactionsGet({
          access_token: connection.accessToken,
          start_date: start,
          end_date: end,
          options: { count: INV_BATCH_SIZE, offset: args.offset },
        });
      } catch (error: any) {
        // Items without investment accounts throw PRODUCTS_NOT_SUPPORTED.
        console.log("investment transactions unavailable", error?.message);
        await ctx.runMutation(internal.syncData.finishRun, {
          runId: args.runId,
          status: "success",
        });
        return;
      }

      const { investment_transactions, securities, total_investment_transactions } =
        response.data;
      const enabledIds = new Set(
        accounts.filter((a) => a.syncEnabled).map((a) => a.plaidAccountId),
      );
      const accountPages = await ctx.runQuery(
        internal.syncData.getAllMapEntries,
        { userId, kind: "account" },
      );
      const securityPages = await syncSecurities(ctx, {
        userId,
        token,
        databaseId: databases.securities,
        securities,
        runId: args.runId,
      });

      const invIds = investment_transactions.map(
        (t) => t.investment_transaction_id,
      );
      const invPages = await ctx.runQuery(internal.syncData.getMapEntries, {
        userId,
        kind: "investmentTransaction",
        providerIds: invIds,
      });

      let stats = { added: 0, modified: 0, removed: 0 };
      const newEntries: Array<{ providerId: string; notionPageId: string }> =
        [];
      for (const txn of investment_transactions) {
        if (!enabledIds.has(txn.account_id)) {
          continue;
        }
        const accountPage = accountPages[txn.account_id];
        if (!accountPage) {
          continue;
        }
        try {
          const properties = investmentTransactionProperties(
            txn,
            accountPage,
            txn.security_id ? securityPages[txn.security_id] : null,
          );
          const existing = invPages[txn.investment_transaction_id];
          if (existing) {
            await updatePage(token, existing, properties);
            stats.modified++;
          } else {
            const page = await createPage(
              token,
              databases.investmentTransactions,
              properties,
            );
            newEntries.push({
              providerId: txn.investment_transaction_id,
              notionPageId: page.id,
            });
            stats.added++;
          }
        } catch (error) {
          console.error(
            "failed to sync investment transaction",
            txn.investment_transaction_id,
            error,
          );
        }
      }

      if (newEntries.length > 0) {
        await ctx.runMutation(internal.syncData.putMapEntries, {
          userId,
          kind: "investmentTransaction",
          entries: newEntries,
        });
      }
      await ctx.runMutation(internal.syncData.addRunStats, {
        runId: args.runId,
        ...stats,
      });

      const nextOffset = args.offset + investment_transactions.length;
      if (nextOffset < total_investment_transactions) {
        await ctx.scheduler.runAfter(0, internal.sync.investmentsBatch, {
          connectionId: connection._id,
          runId: args.runId,
          offset: nextOffset,
        });
      } else {
        await ctx.runMutation(internal.syncData.finishRun, {
          runId: args.runId,
          status: "success",
        });
      }
    } catch (error) {
      console.error("investments batch failed", error);
      await ctx.runMutation(internal.syncData.finishRun, {
        runId: args.runId,
        status: "error",
        error: String(error),
      });
    }
  },
});

// ---------- helpers ----------

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Push the sync lease out by another window at the top of each batch hop, so
// a long backfill keeps the connection to itself. A lost lease means this run
// was superseded — stop writing rather than race the run that took over.
async function heartbeat(
  ctx: ActionCtx,
  connectionId: Id<"bankConnections">,
  runId: Id<"syncRuns">,
): Promise<boolean> {
  const held = await ctx.runMutation(internal.syncData.renewSyncLease, {
    connectionId,
    runId,
  });
  if (!held) {
    console.error("sync lease lost, abandoning run", runId);
    await ctx.runMutation(internal.syncData.finishRun, {
      runId,
      status: "error",
      error: "Sync lease lost: another run took over this connection.",
    });
  }
  return held;
}

// Categories belong to the user, not to one connection, so two connections
// syncing at once can reach the same one. Claim it first: the winner creates
// the page, the losers wait for it instead of creating a second copy.
async function ensureCategoryPage(
  ctx: ActionCtx,
  input: {
    userId: Id<"users">;
    token: string;
    databaseId: string;
    detailed: string;
    primary: string;
    // Plaid's icon for the category. Keyed on the primary category, so every
    // detailed category under one primary shares an icon.
    iconUrl?: string;
  },
): Promise<string | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const claim = await ctx.runMutation(internal.syncData.claimMapEntry, {
      userId: input.userId,
      kind: "category",
      providerId: input.detailed,
    });
    if (claim.status === "ready") {
      return claim.notionPageId;
    }
    if (claim.status === "pending") {
      await sleep(250 * (attempt + 1));
      continue;
    }
    try {
      // Adopt a row that already carries this id before making another one.
      // The map and Notion drift apart whenever pages are restored from
      // trash, or a past duplicate left a row nothing points at.
      const adopted = await findPageByText(
        input.token,
        input.databaseId,
        "ID",
        input.detailed,
      );
      const pageId =
        adopted ??
        ((
          await createPage(
            input.token,
            input.databaseId,
            {
              Name: P.title(categoryName(input.detailed, input.primary)),
              ID: P.text(input.detailed),
              "Category Group": P.select(titleCase(input.primary)),
            },
            input.iconUrl ? externalIcon(input.iconUrl) : undefined,
          )
        ).id as string);
      await ctx.runMutation(internal.syncData.putMapEntries, {
        userId: input.userId,
        kind: "category",
        entries: [{ providerId: input.detailed, notionPageId: pageId }],
      });
      return pageId;
    } catch (error) {
      // Drop the claim so the next sync retries instead of waiting it out.
      await ctx.runMutation(internal.syncData.deleteMapEntries, {
        userId: input.userId,
        kind: "category",
        providerIds: [input.detailed],
      });
      throw error;
    }
  }
  // The holder of the claim is taking an unusual amount of time. Leave the
  // transaction uncategorised; the next sync picks it up.
  console.error("category claim never resolved", input.detailed);
  return null;
}

type NotionIcon = Record<string, unknown>;

// Plaid hands us the institution logo as base64, which Notion can only use
// as a page icon once it has been uploaded. Upload it once per connection
// and reuse the id for the connection page and every account under it.
//
// Returns a thunk rather than the icon itself so nothing is uploaded unless
// a page is actually created — an upload that never gets attached expires
// after an hour and would leave a dead id behind.
function institutionIcon(
  ctx: ActionCtx,
  connection: Doc<"bankConnections">,
  token: string,
): () => Promise<NotionIcon | undefined> {
  let pending: Promise<NotionIcon | undefined> | undefined;
  const resolve = async () => {
    if (connection.notionIconFileUploadId) {
      return fileUploadIcon(connection.notionIconFileUploadId);
    }
    if (!connection.institutionLogo) {
      return undefined;
    }
    try {
      const fileUploadId = await uploadDataUri(
        token,
        `${connection.institutionName.replace(/[^\w -]/g, "")}.png`,
        connection.institutionLogo,
      );
      await ctx.runMutation(internal.connections.setNotionIconFileUpload, {
        connectionId: connection._id,
        fileUploadId,
      });
      return fileUploadIcon(fileUploadId);
    } catch (error) {
      // An icon is cosmetic; never fail a sync over one.
      console.error("institution icon upload failed", error);
      return undefined;
    }
  };
  return () => (pending ??= resolve());
}

// Create or update the Notion page for a mapped entity; returns the page id.
async function upsertMapped(
  ctx: ActionCtx,
  userId: Id<"users">,
  input: {
    kind:
      | "bankConnection"
      | "account"
      | "transaction"
      | "security"
      | "holding"
      | "investmentTransaction"
      | "category"
      | "balanceSnapshot";
    providerId: string;
    token: string;
    databaseId: string;
    properties: Record<string, unknown>;
    runId: Id<"syncRuns">;
    // Applied on creation only, so a later sync never overwrites an icon
    // the user has since chosen themselves.
    icon?: () => Promise<NotionIcon | undefined>;
  },
): Promise<string> {
  const existing = await ctx.runQuery(internal.syncData.getMapEntries, {
    userId,
    kind: input.kind,
    providerIds: [input.providerId],
  });
  const pageId = existing[input.providerId];
  if (pageId) {
    await updatePage(input.token, pageId, input.properties);
    await ctx.runMutation(internal.syncData.addRunStats, {
      runId: input.runId,
      added: 0,
      modified: 1,
      removed: 0,
    });
    return pageId;
  }
  const page = await createPage(input.token, input.databaseId, input.properties);
  await ctx.runMutation(internal.syncData.putMapEntries, {
    userId,
    kind: input.kind,
    entries: [{ providerId: input.providerId, notionPageId: page.id }],
  });
  if (input.icon) {
    try {
      const icon = await input.icon();
      if (icon) {
        await setPageIcon(input.token, page.id, icon);
      }
    } catch (error) {
      console.error("failed to set page icon", input.providerId, error);
    }
  }
  await ctx.runMutation(internal.syncData.addRunStats, {
    runId: input.runId,
    added: 1,
    modified: 0,
    removed: 0,
  });
  return page.id as string;
}

async function syncSecurities(
  ctx: ActionCtx,
  input: {
    userId: Id<"users">;
    token: string;
    databaseId: string | undefined;
    securities: Security[];
    runId: Id<"syncRuns">;
  },
): Promise<Record<string, string>> {
  const pages = await ctx.runQuery(internal.syncData.getAllMapEntries, {
    userId: input.userId,
    kind: "security",
  });
  if (!input.databaseId) {
    return pages;
  }
  const newEntries: Array<{ providerId: string; notionPageId: string }> = [];
  for (const security of input.securities) {
    const properties = {
      Symbol: P.title(
        security.ticker_symbol ?? security.name ?? security.security_id,
      ),
      "Security Name": P.text(security.name),
      ID: P.text(security.security_id),
      Type: P.select(security.type),
      "Close Price": P.number(security.close_price),
      "Close Price As Of": P.date(security.close_price_as_of),
    };
    try {
      const existing = pages[security.security_id];
      if (existing) {
        await updatePage(input.token, existing, properties);
      } else {
        const page = await createPage(input.token, input.databaseId, properties);
        pages[security.security_id] = page.id;
        newEntries.push({
          providerId: security.security_id,
          notionPageId: page.id,
        });
      }
    } catch (error) {
      console.error("failed to sync security", security.security_id, error);
    }
  }
  if (newEntries.length > 0) {
    await ctx.runMutation(internal.syncData.putMapEntries, {
      userId: input.userId,
      kind: "security",
      entries: newEntries,
    });
  }
  return pages;
}

async function syncHoldings(
  ctx: ActionCtx,
  input: {
    context: SyncContext;
    runId: Id<"syncRuns">;
    accountPages: Record<string, string>;
  },
): Promise<void> {
  const { connection, notion, accounts } = input.context;
  const databases = notion.databases!;
  const token = notion.accessToken;
  const userId = connection.userId;
  const client = plaidClient(connection.plaidEnv ?? "production");

  let holdingsData;
  try {
    holdingsData = await client.investmentsHoldingsGet({
      access_token: connection.accessToken,
    });
  } catch (error: any) {
    console.log("holdings unavailable", error?.message);
    return;
  }

  const securityPages = await syncSecurities(ctx, {
    userId,
    token,
    databaseId: databases.securities,
    securities: holdingsData.data.securities,
    runId: input.runId,
  });
  const securityById = Object.fromEntries(
    holdingsData.data.securities.map((s) => [s.security_id, s]),
  );
  const enabledIds = new Set(
    accounts.filter((a) => a.syncEnabled).map((a) => a.plaidAccountId),
  );

  const holdingPages = await ctx.runQuery(internal.syncData.getAllMapEntries, {
    userId,
    kind: "holding",
  });
  const seen = new Set<string>();
  const newEntries: Array<{ providerId: string; notionPageId: string }> = [];
  let stats = { added: 0, modified: 0, removed: 0 };

  for (const holding of holdingsData.data.holdings) {
    if (!enabledIds.has(holding.account_id)) {
      continue;
    }
    const accountPage = input.accountPages[holding.account_id];
    if (!accountPage || !databases.holdings) {
      continue;
    }
    const providerId = `${holding.account_id}|${holding.security_id}`;
    seen.add(providerId);
    const security = securityById[holding.security_id];
    const symbol =
      security?.ticker_symbol ?? security?.name ?? holding.security_id;
    const properties = {
      Summary: P.title(`${symbol} Holding`),
      Account: P.relation(accountPage),
      Security: P.relation(securityPages[holding.security_id]),
      Quantity: P.number(holding.quantity),
      "Cost Basis": P.number(holding.cost_basis),
      "Last Update": P.date(new Date().toISOString()),
    };
    try {
      const existing = holdingPages[providerId];
      if (existing) {
        await updatePage(token, existing, properties);
        stats.modified++;
      } else {
        const page = await createPage(token, databases.holdings, properties);
        newEntries.push({ providerId, notionPageId: page.id });
        stats.added++;
      }
    } catch (error) {
      console.error("failed to sync holding", providerId, error);
    }
  }

  // Archive holdings that disappeared (sold positions) for this item's
  // accounts.
  const itemAccountIds = new Set(accounts.map((a) => a.plaidAccountId));
  const removedIds: string[] = [];
  for (const [providerId, pageId] of Object.entries(holdingPages)) {
    const accountId = providerId.split("|")[0];
    if (!itemAccountIds.has(accountId) || seen.has(providerId)) {
      continue;
    }
    try {
      await archivePage(token, pageId);
      removedIds.push(providerId);
      stats.removed++;
    } catch (error) {
      console.error("failed to archive holding", providerId, error);
    }
  }

  if (newEntries.length > 0) {
    await ctx.runMutation(internal.syncData.putMapEntries, {
      userId,
      kind: "holding",
      entries: newEntries,
    });
  }
  if (removedIds.length > 0) {
    await ctx.runMutation(internal.syncData.deleteMapEntries, {
      userId,
      kind: "holding",
      providerIds: removedIds,
    });
  }
  await ctx.runMutation(internal.syncData.addRunStats, {
    runId: input.runId,
    ...stats,
  });
}

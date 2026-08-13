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

import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import type {
  AccountBase,
  CreditCardLiability,
  InvestmentTransaction,
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
  titleCase,
  todayUTC,
  updatePage,
} from "./notionApi";
import { plaidClient } from "./plaidClient";

const TXN_BATCH_SIZE = 100;
const INV_BATCH_SIZE = 100;

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
    // Webhooks can arrive in bursts; don't stack runs.
    if (args.trigger === "webhook" || args.trigger === "cron") {
      const busy = await ctx.runQuery(internal.syncData.hasRecentRunningRun, {
        connectionId: args.connectionId,
      });
      if (busy) {
        console.log("sync skipped: run already in progress");
        return;
      }
    }

    const { connection, notion, accounts } = context;
    const runId = await ctx.runMutation(internal.syncData.createRun, {
      userId: connection.userId,
      connectionId: connection._id,
      trigger: args.trigger,
    });

    try {
      const client = plaidClient();
      const databases = notion.databases!;
      const token = notion.accessToken;
      const enabled = accounts.filter((account) => account.syncEnabled);
      const enabledIds = new Set(enabled.map((a) => a.plaidAccountId));
      const customNames = new Map(
        accounts
          .filter((a) => a.customName)
          .map((a) => [a.plaidAccountId, a.customName as string]),
      );

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
    const databases = notion.databases!;
    const token = notion.accessToken;
    const userId = connection.userId;

    try {
      const client = plaidClient();
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
        const page = await createPage(token, databases.categories, {
          Name: P.title(categoryName(pfc.detailed, pfc.primary)),
          ID: P.text(pfc.detailed),
          "Category Group": P.select(titleCase(pfc.primary)),
        });
        categoryPages[pfc.detailed] = page.id;
        await ctx.runMutation(internal.syncData.putMapEntries, {
          userId,
          kind: "category",
          entries: [{ providerId: pfc.detailed, notionPageId: page.id }],
        });
        return page.id as string;
      };

      for (const txn of added) {
        if (!inScope(txn)) {
          continue;
        }
        const accountPage = accountPages[txn.account_id];
        if (!accountPage) {
          continue;
        }
        try {
          const categoryPage = await ensureCategory(txn);
          const properties = transactionProperties(txn, accountPage, categoryPage);
          const existing = txnPages[txn.transaction_id];
          const pendingPage = txn.pending_transaction_id
            ? txnPages[txn.pending_transaction_id]
            : undefined;
          if (existing) {
            await updatePage(token, existing, properties);
            stats.modified++;
          } else if (pendingPage) {
            // Pending -> posted: update the page we made for the pending
            // transaction and re-key its mapping to the posted id.
            await updatePage(token, pendingPage, properties);
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
            const page = await createPage(token, databases.transactions, properties);
            newEntries.push({
              providerId: txn.transaction_id,
              notionPageId: page.id,
            });
            txnPages[txn.transaction_id] = page.id;
            stats.added++;
          }
        } catch (error) {
          console.error("failed to sync transaction", txn.transaction_id, error);
        }
      }

      for (const txn of modified) {
        if (!inScope(txn)) {
          continue;
        }
        const pageId = txnPages[txn.transaction_id];
        const accountPage = accountPages[txn.account_id];
        if (!accountPage) {
          continue;
        }
        try {
          const categoryPage = await ensureCategory(txn);
          const properties = transactionProperties(txn, accountPage, categoryPage);
          if (pageId) {
            await updatePage(token, pageId, properties);
            stats.modified++;
          } else {
            const page = await createPage(token, databases.transactions, properties);
            newEntries.push({
              providerId: txn.transaction_id,
              notionPageId: page.id,
            });
            stats.added++;
          }
        } catch (error) {
          console.error("failed to update transaction", txn.transaction_id, error);
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
      await ctx.runMutation(internal.syncData.addRunStats, {
        runId: args.runId,
        ...stats,
      });
      // Only advance the cursor after this page is fully processed.
      await ctx.runMutation(internal.syncData.setCursor, {
        connectionId: connection._id,
        cursor: next_cursor,
      });

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
    const databases = notion.databases!;
    const token = notion.accessToken;
    const userId = connection.userId;

    try {
      const client = plaidClient();
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
  const client = plaidClient();

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

// ---------- property mappers ----------

// Plaid: positive = money out. Notion convention: negative = outflow.
function transactionProperties(
  txn: Transaction,
  accountPageId: string,
  categoryPageId: string | null,
) {
  return {
    Name: P.title(txn.merchant_name || txn.name || "Transaction"),
    ID: P.text(txn.transaction_id),
    "Original Description": P.text(txn.original_description ?? txn.name),
    Account: P.relation(accountPageId),
    Category: P.relation(categoryPageId),
    Amount: P.number(-txn.amount),
    Date: P.date(txn.datetime ?? txn.authorized_datetime ?? txn.date),
    Pending: P.checkbox(txn.pending),
  };
}

// Credit-card balances arrive positive from Plaid (amount owed), matching
// the [redacted] convention, so no sign flip here.
function balanceForNotion(account: AccountBase): number | null {
  return account.balances.current ?? account.balances.available ?? null;
}

function accountProperties(
  institutionName: string,
  account: AccountBase,
  credit: CreditCardLiability | undefined,
  connectionPageId: string,
  customName?: string,
) {
  const apr = credit?.aprs?.find(
    (entry) => entry.apr_type === "purchase_apr",
  )?.apr_percentage;
  return {
    "Account Name": P.title(accountTitle(institutionName, account, customName)),
    ID: P.text(account.account_id),
    "Account Type": P.select(account.type),
    "Account Subtype": P.select(
      account.subtype ? account.subtype.replaceAll("_", " ") : null,
    ),
    "Current Balance": P.number(account.balances.current),
    "Available Balance": P.number(account.balances.available),
    "Account Limit": P.number(account.balances.limit),
    "Next Payment Due": P.date(credit?.next_payment_due_date ?? null),
    "Minimum Payment": P.number(credit?.minimum_payment_amount),
    "Last Statement Balance": P.number(credit?.last_statement_balance),
    // Notion percent format renders 0.2499 as 24.99%.
    APR: P.number(typeof apr === "number" ? apr / 100 : null),
    "Bank Connection": P.relation(connectionPageId),
  };
}

// Plaid cash flows: positive = out of the account. For cash-type rows we
// flip so deposits/contributions read positive in Notion ([redacted] convention);
// trade rows (buy/sell) keep Plaid's sign.
function investmentTransactionProperties(
  txn: InvestmentTransaction,
  accountPageId: string,
  securityPageId: string | null | undefined,
) {
  const amount = txn.type === "cash" ? -txn.amount : txn.amount;
  return {
    "Transaction Summary": P.title(txn.name || titleCase(txn.subtype ?? txn.type)),
    "Transaction ID": P.text(txn.investment_transaction_id),
    "Transaction Type": P.select(txn.type),
    "Transaction Subtype": P.select(
      txn.subtype ? txn.subtype.replaceAll("_", " ") : null,
    ),
    Amount: P.number(amount),
    Price: P.number(txn.price),
    Quantity: P.number(txn.quantity),
    Fees: P.number(txn.fees ?? 0),
    Date: P.date(txn.date),
    "Related Account": P.relation(accountPageId),
    "Related Security": P.relation(securityPageId),
  };
}

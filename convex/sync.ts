"use node";

// The Plaid -> Notion sync engine.
//
// A sync for one bank connection runs as a chain of actions so large
// backfills never hit action time limits:
//
//   runForConnection            (bank connection page, accounts, balances,
//                                holdings + securities)
//     -> accountBackfill        (one transactions/get page per invocation,
//                                once per account switched back on)
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
// Transactions pass through the user's rules on the way out (rulesEngine.ts,
// applied in upsertTransaction). Rules are evaluated here rather than against
// stored data because Finny stores none: this pass is the only place a
// transaction's merchant and amount exist to be matched.
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
import { plaidClient, plaidErrorInfo } from "./plaidClient";
import { evaluate, pfcPrimary, type Rule } from "./rulesEngine";
import {
  accountProperties,
  balanceForNotion,
  investmentTransactionProperties,
  ruleTransaction,
  transactionIcon,
  transactionProperties,
} from "./syncMappers";

const TXN_BATCH_SIZE = 100;
const INV_BATCH_SIZE = 100;

// How many runs may fail on the same transactions/sync page before its
// unwritable rows are abandoned and the cursor moves on.
const MAX_CURSOR_ATTEMPTS = 3;

// Plaid error codes that mean "this Item simply has nothing to report for
// investments" — a cash-only bank, or an Item whose investments product has
// not finished initialising. These are the only outcomes a sync may treat as
// a successful skip; anything else is a real failure. The plaid package does
// not export these as an enum, so they are strings here.
const NO_INVESTMENTS_CODES = new Set([
  "PRODUCTS_NOT_SUPPORTED",
  "PRODUCTS_NOT_READY",
  "NO_INVESTMENT_ACCOUNTS",
]);

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

// ---------- failure handling ----------

// Note that a Plaid failure was the Item's fault, not a passing one.
//
// A sync is where most broken Items are actually discovered: Plaid's ITEM
// ERROR webhook covers some cases, arrives late for others, and never arrives
// for an Item whose access was revoked outside the bank's own flow. Until the
// connection is marked, the Accounts page shows it as Active with no reconnect
// button and the daily cron keeps producing the same error.
//
// Transient codes — rate limits, institution outages, 5xx — are deliberately
// not marked: a reconnect fixes none of them, and the next run will work.
async function noteItemBroken(
  ctx: ActionCtx,
  connectionId: Id<"bankConnections">,
  error: unknown,
): Promise<void> {
  const info = plaidErrorInfo(error);
  if (!info.itemBroken) {
    return;
  }
  await ctx.runMutation(internal.connections.markItemBroken, {
    connectionId,
    errorCode: info.code,
  });
  // The Notion Bank Connections row says Active until something tells it
  // otherwise, and no sync will run to correct it while the Item is broken.
  await ctx.scheduler.runAfter(0, internal.sync.pushConnectionStatusToNotion, {
    connectionId,
  });
}

// End a run in error, saying what actually went wrong.
//
// `String(error)` on a failed Plaid call reads "Error: Request failed with
// status code 400", which is the one thing about it that does not matter.
// Plaid's error_code and error_message are on the response body, so a Plaid
// failure is unwrapped; anything else (a Notion write, a bug here) keeps its
// own message behind a note of which stage it came from.
async function failRun(
  ctx: ActionCtx,
  input: {
    runId: Id<"syncRuns">;
    connectionId: Id<"bankConnections">;
    stage: string;
    error: unknown;
  },
): Promise<void> {
  const info = plaidErrorInfo(input.error);
  await noteItemBroken(ctx, input.connectionId, input.error);
  await ctx.runMutation(internal.syncData.finishRun, {
    runId: input.runId,
    status: "error",
    error: info.code
      ? `${input.stage}: ${info.message}`
      : `${input.stage}: ${String(input.error)}`,
  });
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

// ---------- connection status ----------

// The Status select option in the Notion Bank Connections database. Live
// contract with notionSchemas.ts, which creates those three options.
function notionStatus(status: Doc<"bankConnections">["status"]): string {
  return status === "active"
    ? "Active"
    : status === "error"
      ? "Error"
      : "Pending expiration";
}

// Write just the Status of a connection's Notion row.
//
// A full sync also writes Status, but a broken Item is exactly the case
// where no sync will run — so without this the Notion row keeps saying
// "Active" for as long as the bank stays broken. Called from the webhook
// handler and the daily sweep, and safe to run repeatedly.
//
// Never throws: a webhook must not be held up by Notion being unreachable.
export const pushConnectionStatusToNotion = internalAction({
  args: { connectionId: v.id("bankConnections") },
  handler: async (ctx, args) => {
    try {
      const context = await ctx.runQuery(internal.syncData.getContext, {
        connectionId: args.connectionId,
      });
      if (!context?.notion?.databases?.bankConnections) {
        return;
      }
      const { connection, notion } = context;
      const pages = await ctx.runQuery(internal.syncData.getMapEntries, {
        userId: connection.userId,
        kind: "bankConnection",
        providerIds: [connection.plaidItemId],
      });
      const pageId = pages[connection.plaidItemId];
      if (!pageId) {
        // Never synced, so there is no row to correct; the first sync
        // writes the status it finds.
        return;
      }
      await updatePage(notion.accessToken, pageId, {
        Status: P.select(notionStatus(connection.status)),
      });
    } catch (error) {
      console.error("failed to write connection status to Notion", error);
    }
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
          Status: P.select(notionStatus(connection.status)),
          "Last Update": P.date(new Date().toISOString()),
        },
        runId,
        icon,
      });

      // 2. Accounts (+ credit liabilities when available)
      const balances = await client.accountsGet({
        access_token: connection.accessToken,
      });
      // Banks add accounts to an Item after it is linked. Record them now —
      // disabled, so nothing syncs without being asked for — otherwise every
      // later step silently skips an account the user can never see.
      await ctx.runMutation(internal.connections.upsertPlaidAccounts, {
        connectionId: connection._id,
        accounts: balances.data.accounts.map((account) => ({
          plaidAccountId: account.account_id,
          name: account.name,
          officialName: account.official_name ?? undefined,
          mask: account.mask ?? undefined,
          type: String(account.type),
          subtype: account.subtype ?? undefined,
        })),
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
          accountId: account.account_id,
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
            accountId: account.account_id,
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

      // 5. Hand off to the transaction chain, catching up any account that
      //    was switched back on first.
      await scheduleNextStage(ctx, { context, runId, completed: [] });
    } catch (error) {
      console.error("sync failed", error);
      await failRun(ctx, {
        runId,
        connectionId: connection._id,
        stage: "Accounts and balances",
        error,
      });
    }
  },
});

// ---------- stage 1b: per-account catch-up (self-rescheduling) ----------

const BACKFILL_PAGE_SIZE = 100;

// Plaid keeps about two years of transactions, so a wider window is only
// wasted requests.
const BACKFILL_MAX_DAYS = 730;

// A walk this long means an account nobody meant to backfill. Stop rather
// than re-walk the same thousands of rows on every run forever.
const MAX_BACKFILL_PAGES = 50;

function backfillStart(startDate: string | undefined, end: string): string {
  const earliest = new Date(`${end}T00:00:00Z`);
  earliest.setUTCDate(earliest.getUTCDate() - BACKFILL_MAX_DAYS);
  const capped = earliest.toISOString().slice(0, 10);
  return startDate && startDate > capped ? startDate : capped;
}

// Fetch one account's history straight from Plaid, a page at a time.
//
// transactions/sync is per Item, and its cursor advances whether or not a
// given account was switched on, so everything that streamed by while an
// account was off is not coming back. transactions/get reads the same data
// without touching that cursor, which is why the catch-up uses it. Rows go
// through the same map as everything else, so re-running only updates.
export const accountBackfill = internalAction({
  args: {
    connectionId: v.id("bankConnections"),
    runId: v.id("syncRuns"),
    plaidAccountId: v.string(),
    offset: v.number(),
    // Accounts this run has already walked. A walk that ends with failures
    // leaves its flag set to retry later, so without this the run would
    // pick the same account again and never reach the next stage.
    completed: v.array(v.string()),
    failures: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const context = await loadContext(ctx, args.connectionId);
    if (!context) {
      await ctx.runMutation(internal.syncData.finishRun, {
        runId: args.runId,
        status: "error",
        error: "The connection or its Notion destination went away mid-sync.",
      });
      return;
    }
    if (!(await heartbeat(ctx, args.connectionId, args.runId))) {
      return;
    }
    const { connection, notion } = context;
    const databases = notion.databases!;
    const token = notion.accessToken;
    const userId = connection.userId;
    const completed = [...args.completed, args.plaidAccountId];
    const moveOn = () =>
      scheduleNextStage(ctx, { context, runId: args.runId, completed });

    try {
      const account = context.accounts.find(
        (row) => row.plaidAccountId === args.plaidAccountId,
      );
      if (
        !account ||
        !account.syncEnabled ||
        !account.needsBackfill ||
        !databases.transactions
      ) {
        // Switched off again mid-run, or already caught up.
        await moveOn();
        return;
      }

      const accountPages = await ctx.runQuery(
        internal.syncData.getAllMapEntries,
        { userId, kind: "account" },
      );
      const accountPage = accountPages[args.plaidAccountId];
      if (!accountPage) {
        // Stage 1 makes the account page. Without it these rows have
        // nothing to relate to, so leave the flag for the next run.
        console.error("no account page for catch-up", args.plaidAccountId);
        await moveOn();
        return;
      }

      const client = plaidClient(connection.plaidEnv ?? "production");
      const end = todayUTC();
      let response;
      try {
        response = await client.transactionsGet({
          access_token: connection.accessToken,
          start_date: backfillStart(notion.startDate, end),
          end_date: end,
          options: {
            account_ids: [args.plaidAccountId],
            count: BACKFILL_PAGE_SIZE,
            offset: args.offset,
            include_original_description: true,
          },
        });
      } catch (error: any) {
        // Nothing here has consumed a cursor, so a failed catch-up costs
        // only this attempt: keep the flag and let a later run retry. The
        // Item still gets marked if the reason was the Item — the rest of
        // this run would only fail the same way.
        console.error(
          "account catch-up failed",
          args.plaidAccountId,
          plaidErrorInfo(error).message,
        );
        await noteItemBroken(ctx, args.connectionId, error);
        await moveOn();
        return;
      }
      const { transactions, total_transactions } = response.data;

      const categoryPages = await ctx.runQuery(
        internal.syncData.getAllMapEntries,
        { userId, kind: "category" },
      );
      const ensureCategory = categoryResolver(ctx, {
        userId,
        token,
        databaseId: databases.categories,
        cache: categoryPages,
      });
      // Once for the whole page, not once per transaction.
      const rules = await ctx.runQuery(internal.rules.listEnabledInternal, {
        userId,
      });
      const txnPages = await ctx.runQuery(internal.syncData.getMapEntries, {
        userId,
        kind: "transaction",
        providerIds: [
          ...transactions.map((txn) => txn.transaction_id),
          ...transactions
            .map((txn) => txn.pending_transaction_id)
            .filter(Boolean),
        ] as string[],
      });

      const stats = { added: 0, modified: 0, removed: 0 };
      let failures = args.failures ?? 0;
      for (const txn of transactions) {
        try {
          const result = await upsertTransaction(ctx, {
            userId,
            token,
            databaseId: databases.transactions,
            txn,
            accountPage,
            accountRowId: account._id,
            rules,
            ensureCategory,
            txnPages,
          });
          // A rule keeping a row out of Notion wrote nothing to report.
          if (result !== "hidden") {
            stats[result]++;
          }
        } catch (error) {
          console.error("failed to catch up transaction", txn.transaction_id, error);
          failures++;
        }
      }
      await ctx.runMutation(internal.syncData.addRunStats, {
        runId: args.runId,
        ...stats,
      });

      const walked = args.offset + transactions.length;
      const capped = walked >= MAX_BACKFILL_PAGES * BACKFILL_PAGE_SIZE;
      if (transactions.length > 0 && walked < total_transactions && !capped) {
        await ctx.scheduler.runAfter(0, internal.sync.accountBackfill, {
          connectionId: connection._id,
          runId: args.runId,
          plaidAccountId: args.plaidAccountId,
          offset: walked,
          completed: args.completed,
          failures,
        });
        return;
      }

      if (capped && walked < total_transactions) {
        console.error(
          `catch-up for ${args.plaidAccountId} stopped at ${walked} of ` +
            `${total_transactions} transactions; the rest of that window ` +
            `will not be fetched.`,
        );
      } else if (failures > 0) {
        console.error(
          `${failures} row(s) failed the catch-up for ${args.plaidAccountId}; ` +
            `leaving it queued for the next run.`,
        );
      }
      if (failures === 0 || capped) {
        await ctx.runMutation(internal.connections.clearAccountBackfill, {
          accountId: account._id,
        });
      }
      await moveOn();
    } catch (error) {
      console.error("account catch-up batch failed", error);
      await failRun(ctx, {
        runId: args.runId,
        connectionId: args.connectionId,
        stage: "Account catch-up",
        error,
      });
    }
  },
});

// What follows the account pass: any account still waiting on a catch-up,
// then the transaction stream, then investments.
async function scheduleNextStage(
  ctx: ActionCtx,
  input: {
    context: SyncContext;
    runId: Id<"syncRuns">;
    completed: string[];
  },
): Promise<void> {
  const { connection, notion, accounts } = input.context;
  const databases = notion.databases!;

  if (notion.modules.spending && databases.transactions) {
    const pending = accounts.find(
      (account) =>
        account.syncEnabled &&
        account.needsBackfill &&
        !input.completed.includes(account.plaidAccountId),
    );
    if (pending) {
      await ctx.scheduler.runAfter(0, internal.sync.accountBackfill, {
        connectionId: connection._id,
        runId: input.runId,
        plaidAccountId: pending.plaidAccountId,
        offset: 0,
        completed: input.completed,
      });
      return;
    }
    await ctx.scheduler.runAfter(0, internal.sync.transactionsBatch, {
      connectionId: connection._id,
      runId: input.runId,
    });
    return;
  }
  if (notion.modules.investments && databases.investmentTransactions) {
    await ctx.scheduler.runAfter(0, internal.sync.investmentsBatch, {
      connectionId: connection._id,
      runId: input.runId,
      offset: 0,
    });
    return;
  }
  await ctx.runMutation(internal.syncData.finishRun, {
    runId: input.runId,
    status: "success",
  });
}

// ---------- stage 2: transactions (self-rescheduling) ----------

export const transactionsBatch = internalAction({
  args: {
    connectionId: v.id("bankConnections"),
    runId: v.id("syncRuns"),
  },
  handler: async (ctx, args) => {
    const context = await loadContext(ctx, args.connectionId);
    if (!context) {
      // Returning here without finishing left the run "running" forever, and
      // with it the connection's lease.
      await ctx.runMutation(internal.syncData.finishRun, {
        runId: args.runId,
        status: "error",
        error: "The connection or its Notion destination went away mid-sync.",
      });
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
        ...modified.map((t) => t.pending_transaction_id).filter(Boolean),
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

      const ensureCategory = categoryResolver(ctx, {
        userId,
        token,
        databaseId: databases.categories,
        cache: categoryPages,
      });
      // Read once for the whole page: rules are per user, and evaluating them
      // is pure, so nothing here needs the database again per transaction.
      const rules = await ctx.runQuery(internal.rules.listEnabledInternal, {
        userId,
      });
      const accountRowIds = new Map(
        accounts.map((account) => [account.plaidAccountId, account._id]),
      );

      // A transaction whose account is switched off (or that predates the
      // start date) still gets its updates if it already has a Notion page:
      // this stream is the only place a pending row learns it posted, or
      // that an amount was corrected, and the cursor moves past it either
      // way. Only the create is skipped — that is what "off" means.
      const mappedPage = (txn: Transaction) =>
        txnPages[txn.transaction_id] ??
        (txn.pending_transaction_id
          ? txnPages[txn.pending_transaction_id]
          : undefined);

      for (const txn of [...added, ...modified]) {
        const scoped = inScope(txn);
        if (!scoped && !mappedPage(txn)) {
          continue;
        }
        const accountPage = accountPages[txn.account_id];
        if (!accountPage) {
          if (!scoped) {
            // Nothing to relate the row to, and writing it without the
            // relation would clear the one it has.
            continue;
          }
          // The account page is made in stage 1; missing means that failed.
          console.error("no account page for transaction", txn.transaction_id);
          failures++;
          continue;
        }
        try {
          const result = await upsertTransaction(ctx, {
            userId,
            token,
            databaseId: databases.transactions,
            txn,
            accountPage,
            accountRowId: accountRowIds.get(txn.account_id),
            rules,
            ensureCategory,
            txnPages,
          });
          // A rule keeping a row out of Notion wrote nothing to report.
          if (result !== "hidden") {
            stats[result]++;
          }
        } catch (error) {
          console.error("failed to sync transaction", txn.transaction_id, error);
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
      await failRun(ctx, {
        runId: args.runId,
        connectionId: args.connectionId,
        stage: "Transactions",
        error,
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
    // Rows earlier pages of this window failed to write. Carried along
    // because reconciliation may only run after a walk that saw everything.
    pageErrors: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const context = await loadContext(ctx, args.connectionId);
    if (!context) {
      await ctx.runMutation(internal.syncData.finishRun, {
        runId: args.runId,
        status: "error",
        error: "The connection or its Notion destination went away mid-sync.",
      });
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
        // Only "this Item has no investments" is a clean skip. Catching
        // everything here used to finish the run successfully, and finishRun
        // forces the connection back to active — so ITEM_LOGIN_REQUIRED, a
        // rate limit, or a 5xx made a broken Item look healthy.
        const code: string | undefined = error?.response?.data?.error_code;
        if (code && NO_INVESTMENTS_CODES.has(code)) {
          console.log("investment transactions unavailable", code);
          await ctx.runMutation(internal.syncData.finishRun, {
            runId: args.runId,
            status: "success",
          });
          return;
        }
        console.error("investment transactions failed", code, error?.message);
        await failRun(ctx, {
          runId: args.runId,
          connectionId: args.connectionId,
          stage: "Investment transactions",
          error,
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
      let failures = 0;
      for (const txn of investment_transactions) {
        if (!enabledIds.has(txn.account_id)) {
          continue;
        }
        const accountPage = accountPages[txn.account_id];
        if (!accountPage) {
          console.error(
            "no account page for investment transaction",
            txn.investment_transaction_id,
          );
          failures++;
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
            const claimed = await claimAndCreatePage(ctx, {
              userId,
              kind: "investmentTransaction",
              providerId: txn.investment_transaction_id,
              token,
              databaseId: databases.investmentTransactions,
              properties,
              accountId: txn.account_id,
            });
            if (!claimed) {
              throw new Error(
                `another sync holds the investment transaction claim for ${txn.investment_transaction_id}`,
              );
            }
            if (!claimed.created) {
              await updatePage(token, claimed.pageId, properties);
            }
            stats.added++;
          }
        } catch (error) {
          console.error(
            "failed to sync investment transaction",
            txn.investment_transaction_id,
            error,
          );
          failures++;
        }
      }

      // Every id on the page, in scope or not: an id Plaid still lists is an
      // id that has not been canceled, which is all reconciliation asks.
      if (investment_transactions.length > 0) {
        await ctx.runMutation(
          internal.syncData.markInvestmentTransactionsSeen,
          {
            userId,
            runId: args.runId,
            entries: investment_transactions.map((txn) => ({
              providerId: txn.investment_transaction_id,
              accountId: txn.account_id,
            })),
          },
        );
      }

      await ctx.runMutation(internal.syncData.addRunStats, {
        runId: args.runId,
        ...stats,
      });

      const pageErrors = (args.pageErrors ?? 0) + failures;
      const nextOffset = args.offset + investment_transactions.length;
      if (nextOffset < total_investment_transactions) {
        if (investment_transactions.length === 0) {
          // Plaid claims more rows but returned none, so the window can
          // never be walked to the end. Stop rather than reschedule the same
          // offset forever, and leave reconciliation alone.
          await ctx.runMutation(internal.syncData.finishRun, {
            runId: args.runId,
            status: "error",
            error:
              `Plaid returned an empty investments page at offset ` +
              `${args.offset} of ${total_investment_transactions}.`,
          });
          return;
        }
        await ctx.scheduler.runAfter(0, internal.sync.investmentsBatch, {
          connectionId: connection._id,
          runId: args.runId,
          offset: nextOffset,
          pageErrors,
        });
        return;
      }

      // The window is fully walked. Plaid drops a canceled investment
      // transaction out of the window rather than reporting it as removed,
      // so anything still mapped for this Item's accounts that the walk
      // never mentioned is gone and its Notion row should be archived.
      //
      // Only after a clean walk: a window cut short by write failures would
      // archive live history.
      if (pageErrors === 0) {
        const archived = await reconcileInvestmentTransactions(ctx, {
          userId,
          runId: args.runId,
          token,
          accountIds: accounts.map((account) => account.plaidAccountId),
        });
        if (archived > 0) {
          await ctx.runMutation(internal.syncData.addRunStats, {
            runId: args.runId,
            added: 0,
            modified: 0,
            removed: archived,
          });
        }
        await ctx.runMutation(internal.syncData.finishRun, {
          runId: args.runId,
          status: "success",
        });
        return;
      }
      await ctx.runMutation(internal.syncData.finishRun, {
        runId: args.runId,
        status: "error",
        error:
          `${pageErrors} investment transaction(s) failed to reach Notion; ` +
          `skipped archiving rows that vanished from Plaid this run.`,
      });
    } catch (error) {
      console.error("investments batch failed", error);
      await failRun(ctx, {
        runId: args.runId,
        connectionId: args.connectionId,
        stage: "Investments",
        error,
      });
    }
  },
});

// ---------- helpers ----------

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A run archives at most this many vanished rows; the next one picks up the
// rest. Keeps a first reconciliation over a long history from trying to make
// hundreds of Notion calls in a single action.
const RECONCILE_ARCHIVE_LIMIT = 500;

// Rows one unmap mutation deletes. Each is a point lookup plus a delete, so
// this only has to stay inside one transaction's write budget.
const ARCHIVE_UNMAP_BATCH = 200;

// Archive the Notion rows for investment transactions this Item's accounts no
// longer have at Plaid. Cash transactions arrive with a `removed` list and
// holdings are a full snapshot, but investment transactions are create-and-
// update only, so a canceled trade sits in Notion forever without this.
//
// Walked one account at a time, a bounded page per query, resuming from the
// providerId each page ended on: the map holds every investment transaction
// the user has ever synced, so there is no version of this that reads them
// all. Rows with no accountId are outside every page this reads and are
// therefore never archived — see getVanishedInvestmentTransactions.
//
// Only ever called after a complete window walk with no failed writes. Note
// that "the window" is notion.startDate onwards, so moving that date forward
// would read as history vanishing — rewind cursors rather than narrow the
// window if that ever becomes editable.
async function reconcileInvestmentTransactions(
  ctx: ActionCtx,
  input: {
    userId: Id<"users">;
    runId: Id<"syncRuns">;
    token: string;
    accountIds: string[];
  },
): Promise<number> {
  const archived: string[] = [];
  for (const accountId of input.accountIds) {
    let after: string | undefined = undefined;
    do {
      // Annotated because the inferred type flows back into `after`, which
      // this call's own arguments read.
      const page: {
        vanished: Array<{ providerId: string; notionPageId: string }>;
        nextProviderId: string | null;
      } = await ctx.runQuery(
        internal.syncData.getVanishedInvestmentTransactions,
        {
          userId: input.userId,
          runId: input.runId,
          accountId,
          afterProviderId: after,
        },
      );
      for (const entry of page.vanished) {
        if (archived.length >= RECONCILE_ARCHIVE_LIMIT) {
          break;
        }
        try {
          await archivePage(input.token, entry.notionPageId);
          archived.push(entry.providerId);
        } catch (error) {
          console.error(
            "failed to archive investment transaction",
            entry.providerId,
            error,
          );
        }
      }
      after = page.nextProviderId ?? undefined;
    } while (after !== undefined && archived.length < RECONCILE_ARCHIVE_LIMIT);
    if (archived.length >= RECONCILE_ARCHIVE_LIMIT) {
      break;
    }
  }
  if (archived.length > 0) {
    // One mutation per batch, not per row: the map keys are short and the
    // delete is a point lookup each.
    for (let index = 0; index < archived.length; index += ARCHIVE_UNMAP_BATCH) {
      await ctx.runMutation(internal.syncData.deleteMapEntries, {
        userId: input.userId,
        kind: "investmentTransaction",
        providerIds: archived.slice(index, index + ARCHIVE_UNMAP_BATCH),
      });
    }
  }
  const unscoped = await ctx.runQuery(
    internal.syncData.countUnscopedInvestmentTransactions,
    { userId: input.userId },
  );
  if (unscoped.count > 0) {
    console.log(
      `skipped ${unscoped.count}${unscoped.more ? "+" : ""} mapped ` +
        `investment transaction(s) with no account scope; run ` +
        `syncData.backfillMapScopes to make them reconcilable`,
    );
  }
  return archived.length;
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

type NotionIcon = Record<string, unknown>;

type MapKind =
  | "bankConnection"
  | "account"
  | "transaction"
  | "security"
  | "holding"
  | "investmentTransaction"
  | "category"
  | "balanceSnapshot";

// The Notion property each database keeps the provider id in. Used to adopt
// a row a previous attempt already created rather than making a second one.
// Holdings and Balance History have none — they are keyed on account +
// security and account + date in their titles — so those rely on the claim
// alone (see notionSchemas.ts).
const ID_PROPERTY: Partial<Record<MapKind, string>> = {
  bankConnection: "ID",
  account: "ID",
  transaction: "ID",
  security: "ID",
  investmentTransaction: "Transaction ID",
  category: "ID",
};

// Reserve the map entry for a key, then create its Notion page, then write
// the real page id — in that order, and never batched with other rows.
//
// Creating first and mapping later leaves a window where a crash, a replayed
// Plaid page, or a second run produces a duplicate Notion row that nothing
// points at. Claiming first turns that window into a stale claim, which the
// next attempt recognises and resolves by adopting the page instead.
//
// Returns null when another caller holds the claim and never resolves it;
// the caller should treat that as a failure for this row and move on.
async function claimAndCreatePage(
  ctx: ActionCtx,
  input: {
    userId: Id<"users">;
    kind: MapKind;
    providerId: string;
    token: string;
    databaseId: string;
    properties: Record<string, unknown>;
    icon?: NotionIcon;
    // The Plaid account this row belongs to, where there is one. Recorded on
    // the map row so reconciliation can find it without reading the user's
    // whole history; rows created before this was passed are scoped by
    // syncData.backfillMapScopes instead.
    accountId?: string;
    // Query Notion before every create, not just after a reclaimed claim.
    // Only worth the extra request where rows routinely outlive the map —
    // categories survive resetAndResync, transactions do not.
    alwaysAdopt?: boolean;
  },
): Promise<{ pageId: string; created: boolean } | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const claim = await ctx.runMutation(internal.syncData.claimMapEntry, {
      userId: input.userId,
      kind: input.kind,
      providerId: input.providerId,
      accountId: input.accountId,
    });
    if (claim.status === "ready") {
      return { pageId: claim.notionPageId, created: false };
    }
    if (claim.status === "pending") {
      await sleep(250 * (attempt + 1));
      continue;
    }
    const idProperty = ID_PROPERTY[input.kind];
    try {
      // Notion's rate limit is the binding constraint on a backfill, so this
      // extra query only happens where a duplicate is actually plausible.
      const adopted =
        idProperty && (input.alwaysAdopt || claim.reclaimed)
          ? await findPageByText(
              input.token,
              input.databaseId,
              idProperty,
              input.providerId,
            )
          : undefined;
      const pageId =
        adopted ??
        ((
          await createPage(
            input.token,
            input.databaseId,
            input.properties,
            input.icon,
          )
        ).id as string);
      await ctx.runMutation(internal.syncData.putMapEntries, {
        userId: input.userId,
        kind: input.kind,
        entries: [
          {
            providerId: input.providerId,
            notionPageId: pageId,
            accountId: input.accountId,
          },
        ],
      });
      return { pageId, created: !adopted };
    } catch (error) {
      // Drop the claim so the next sync retries instead of waiting it out.
      await ctx.runMutation(internal.syncData.deleteMapEntries, {
        userId: input.userId,
        kind: input.kind,
        providerIds: [input.providerId],
      });
      throw error;
    }
  }
  console.error("claim never resolved", input.kind, input.providerId);
  return null;
}

// What one transaction did to Notion. "hidden" is a rule keeping a row out
// and is deliberately not counted in a run's stats: nothing was written.
type TransactionResult = "added" | "modified" | "removed" | "hidden";

// Create or update the Notion row for one Plaid transaction and keep the
// caller's providerId -> page map in step. Shared by the transactions/sync
// stream and the per-account catch-up so the pending -> posted rule, the
// claim-then-create rule, and the user's rules have one implementation
// between them.
//
// Callers decide whether a create is allowed: pass a txn with no mapping
// only when it should be created.
async function upsertTransaction(
  ctx: ActionCtx,
  input: {
    userId: Id<"users">;
    token: string;
    databaseId: string;
    txn: Transaction;
    accountPage: string;
    // The Convex accounts row this transaction belongs to, which is what a
    // rule's account condition is written against.
    accountRowId?: string;
    // Loaded once per batch, never per transaction.
    rules: Rule[];
    // Resolves (and creates on first sight) the category page, taking a rule's
    // category override into account. Called after the rules run, so a hidden
    // transaction never creates a category row for a category it never gets.
    ensureCategory: (
      txn: Transaction,
      categoryOverride?: string,
    ) => Promise<string | null>;
    txnPages: Record<string, string>;
  },
): Promise<TransactionResult> {
  const { txn, txnPages } = input;

  const decision = evaluate(
    input.rules,
    ruleTransaction(txn, input.accountRowId),
  );
  if (decision?.hide) {
    return await hideTransaction(ctx, {
      userId: input.userId,
      token: input.token,
      txn,
      txnPages,
    });
  }

  const properties = transactionProperties(
    txn,
    input.accountPage,
    await input.ensureCategory(txn, decision?.categoryId),
    decision?.rename,
  );
  // Merchant logos ride along in the request we are already making, so
  // keeping them current costs no extra calls.
  const icon = transactionIcon(txn);

  const existing = txnPages[txn.transaction_id];
  if (existing) {
    await updatePage(input.token, existing, properties, icon);
    return "modified";
  }

  const pendingPage = txn.pending_transaction_id
    ? txnPages[txn.pending_transaction_id]
    : undefined;
  if (pendingPage) {
    // Pending -> posted: update the page made for the pending transaction
    // and re-key its mapping to the posted id.
    await updatePage(input.token, pendingPage, properties, icon);
    await ctx.runMutation(internal.syncData.rekeyMapEntry, {
      userId: input.userId,
      kind: "transaction",
      fromProviderId: txn.pending_transaction_id!,
      toProviderId: txn.transaction_id,
    });
    txnPages[txn.transaction_id] = pendingPage;
    delete txnPages[txn.pending_transaction_id!];
    return "modified";
  }

  const claimed = await claimAndCreatePage(ctx, {
    userId: input.userId,
    kind: "transaction",
    providerId: txn.transaction_id,
    token: input.token,
    databaseId: input.databaseId,
    properties,
    accountId: txn.account_id,
    icon,
  });
  if (!claimed) {
    throw new Error(
      `another sync holds the transaction claim for ${txn.transaction_id}`,
    );
  }
  if (!claimed.created) {
    // Adopted a page a previous attempt left behind; make sure it carries
    // this transaction's values.
    await updatePage(input.token, claimed.pageId, properties, icon);
  }
  txnPages[txn.transaction_id] = claimed.pageId;
  return "added";
}

// A rule says this transaction does not belong in Notion.
//
// Usually there is nothing to do — the row was never created. But a rule can
// be written after the transaction already synced, or start applying when a
// pending row posts and its amount changes, so a page that exists has to be
// archived and its mapping dropped. Without dropping it, the next sync event
// for the transaction would update a page the user asked to be gone.
//
// Throwing here is the caller's signal that this row failed, which leaves the
// Plaid cursor where it is so the archive is retried — the same treatment any
// other failed Notion write gets.
async function hideTransaction(
  ctx: ActionCtx,
  input: {
    userId: Id<"users">;
    token: string;
    txn: Transaction;
    txnPages: Record<string, string>;
  },
): Promise<TransactionResult> {
  const { txn, txnPages } = input;
  const pendingId = txn.pending_transaction_id ?? undefined;
  const mappedId = txnPages[txn.transaction_id]
    ? txn.transaction_id
    : pendingId && txnPages[pendingId]
      ? pendingId
      : undefined;
  if (!mappedId) {
    return "hidden";
  }
  await archivePage(input.token, txnPages[mappedId]);
  await ctx.runMutation(internal.syncData.deleteMapEntries, {
    userId: input.userId,
    kind: "transaction",
    providerIds: [mappedId],
  });
  delete txnPages[mappedId];
  // A Notion row went away, which is what "removed" counts.
  return "removed";
}

// Resolve a transaction's category page, creating it the first time it is
// seen. The cache is the caller's, so one pass never asks twice.
//
// `categoryOverride` is a rule's category outcome: a Plaid category enum that
// this transaction never came with, so its primary group has to be looked up
// rather than read off the transaction.
function categoryResolver(
  ctx: ActionCtx,
  input: {
    userId: Id<"users">;
    token: string;
    databaseId: string | undefined;
    cache: Record<string, string>;
  },
): (txn: Transaction, categoryOverride?: string) => Promise<string | null> {
  return async (txn, categoryOverride) => {
    const pfc = txn.personal_finance_category;
    const detailed = categoryOverride ?? pfc?.detailed;
    const databaseId = input.databaseId;
    if (!detailed || !databaseId) {
      return null;
    }
    if (input.cache[detailed]) {
      return input.cache[detailed];
    }
    const pageId = await ensureCategoryPage(ctx, {
      userId: input.userId,
      token: input.token,
      databaseId,
      detailed,
      // An override that is not in the taxonomy can only be a rule written
      // against a category Plaid has since renamed; group it under itself
      // rather than dropping the outcome the user asked for.
      primary: categoryOverride
        ? (pfcPrimary(categoryOverride) ?? categoryOverride)
        : (pfc?.primary ?? detailed),
      // Plaid's icon belongs to the category it chose. A rule moving the
      // transaction somewhere else says nothing about that category's icon,
      // so the row is created without one.
      iconUrl: categoryOverride
        ? undefined
        : (txn.personal_finance_category_icon_url ?? undefined),
    });
    if (pageId) {
      input.cache[detailed] = pageId;
    }
    return pageId;
  };
}

// Categories belong to the user, not to one connection, so two connections
// syncing at once can reach the same one.
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
  const claimed = await claimAndCreatePage(ctx, {
    userId: input.userId,
    kind: "category",
    providerId: input.detailed,
    token: input.token,
    databaseId: input.databaseId,
    properties: {
      Name: P.title(categoryName(input.detailed, input.primary)),
      ID: P.text(input.detailed),
      "Category Group": P.select(titleCase(input.primary)),
    },
    icon: input.iconUrl ? externalIcon(input.iconUrl) : undefined,
    // The map and Notion drift apart whenever category pages are restored
    // from trash or a past duplicate left a row nothing points at, and there
    // are only ever a hundred or so of them.
    alwaysAdopt: true,
  });
  // No page means someone else is mid-create. Leave the transaction
  // uncategorised; the next sync picks it up.
  return claimed?.pageId ?? null;
}

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
    kind: MapKind;
    providerId: string;
    token: string;
    databaseId: string;
    properties: Record<string, unknown>;
    runId: Id<"syncRuns">;
    // Scopes the map row to a Plaid account where the entity has one.
    accountId?: string;
    // Applied on creation only, so a later sync never overwrites an icon
    // the user has since chosen themselves.
    icon?: () => Promise<NotionIcon | undefined>;
  },
): Promise<string> {
  const claimed = await claimAndCreatePage(ctx, {
    userId,
    kind: input.kind,
    providerId: input.providerId,
    token: input.token,
    databaseId: input.databaseId,
    properties: input.properties,
    accountId: input.accountId,
  });
  if (!claimed) {
    throw new Error(
      `another sync holds the ${input.kind} claim for ${input.providerId}`,
    );
  }
  if (!claimed.created) {
    await updatePage(input.token, claimed.pageId, input.properties);
    await ctx.runMutation(internal.syncData.addRunStats, {
      runId: input.runId,
      added: 0,
      modified: 1,
      removed: 0,
    });
    return claimed.pageId;
  }
  if (input.icon) {
    try {
      const icon = await input.icon();
      if (icon) {
        await setPageIcon(input.token, claimed.pageId, icon);
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
  return claimed.pageId;
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
  const databaseId = input.databaseId;
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
        continue;
      }
      // Securities are keyed on the user, not the connection, so two
      // connections holding the same ETF can reach this at the same moment.
      const claimed = await claimAndCreatePage(ctx, {
        userId: input.userId,
        kind: "security",
        providerId: security.security_id,
        token: input.token,
        databaseId,
        properties,
      });
      if (!claimed) {
        console.error("security claim never resolved", security.security_id);
        continue;
      }
      if (!claimed.created) {
        await updatePage(input.token, claimed.pageId, properties);
      }
      pages[security.security_id] = claimed.pageId;
    } catch (error) {
      console.error("failed to sync security", security.security_id, error);
    }
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
    // Holdings are optional — a cash-only Item simply has none — so this
    // never fails the run. An Item that is broken rather than uninterested
    // still gets marked, since the stages after this one will hit the same
    // wall and the user needs the reconnect either way.
    console.log("holdings unavailable", plaidErrorInfo(error).message);
    await noteItemBroken(ctx, connection._id, error);
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

  // One bounded read per account of this Item, rather than every holding row
  // the user has across every connection. A holding's providerId is
  // `${plaidAccountId}|${securityId}`, so account scoping covers them exactly.
  // Legacy rows with no accountId are invisible here: a create still finds
  // them through claimMapEntry (so no duplicate page), they just are not
  // archived until syncData.backfillMapScopes derives their account.
  const holdingPages: Record<string, string> = {};
  for (const account of accounts) {
    Object.assign(
      holdingPages,
      await ctx.runQuery(internal.syncData.getAccountMapEntries, {
        userId,
        kind: "holding",
        accountId: account.plaidAccountId,
      }),
    );
  }
  const seen = new Set<string>();
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
        // Holdings have no ID property to adopt by, so the claim is the only
        // thing standing between a retry and a duplicate row.
        const claimed = await claimAndCreatePage(ctx, {
          userId,
          kind: "holding",
          providerId,
          token,
          databaseId: databases.holdings,
          properties,
          accountId: holding.account_id,
        });
        if (!claimed) {
          console.error("holding claim never resolved", providerId);
          continue;
        }
        if (!claimed.created) {
          await updatePage(token, claimed.pageId, properties);
        }
        stats.added++;
      }
    } catch (error) {
      console.error("failed to sync holding", providerId, error);
    }
  }

  // Archive holdings that disappeared (sold positions). Everything read above
  // already belongs to one of this Item's accounts, so there is nothing left
  // to filter by connection.
  const removedIds: string[] = [];
  for (const [providerId, pageId] of Object.entries(holdingPages)) {
    if (seen.has(providerId)) {
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

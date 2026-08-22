"use node";

// The Plaid -> Notion sync engine.
//
// A sync for one bank connection runs as a chain of actions so large
// backfills never hit action time limits:
//
//   runForConnection            (bank connection page, accounts, balances,
//                                category seed, holdings + securities)
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
import type { CreditCardLiability, Transaction } from "plaid";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalAction, type ActionCtx } from "./_generated/server";
import {
  P,
  archivePage,
  accountTitle,
  externalIcon,
  setPageIcon,
  todayUTC,
  updatePage,
} from "./notionApi";
import { NOTION_SCHEMA_VERSION } from "./notionSchemas";
import { plaidClient, plaidErrorInfo } from "./plaidClient";
import {
  reconcileInvestmentTransactions,
  syncHoldings,
  syncRecurring,
  syncSecurities,
} from "./syncInvestments";
import {
  accountProperties,
  balanceForNotion,
  investmentTransactionProperties,
} from "./syncMappers";
import { claimAndCreatePage, upsertMapped } from "./syncPages";
import { renderTitle } from "./titleFormats";
import {
  commentOnStatusChange,
  failRun,
  heartbeat,
  institutionIcon,
  itemIsBroken,
  accountTitles,
  loadContext,
  notionStatus,
  type SyncContext,
} from "./syncRun";
import {
  categoryResolver,
  seedCategories,
  upsertTransaction,
} from "./syncTransactionWriter";

// Deliberately small, and the reason is Notion rather than Plaid.
//
// A page is fetched and then written one row at a time at Notion's three a
// second, and Plaid's pagination is open for all of it. A hundred rows is
// half a minute of open window on a busy Item, which is how
// TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION goes from unlucky to routine.
// Twenty-five is about eight seconds. Plaid calls are cheap; the window is
// not.
const TXN_BATCH_SIZE = 25;
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

// What to do with the rows the last build left in Notion.
//
// Finny holds the page id of every row it ever created, so "go and delete them
// yourself first" was always a chore the app could have done. It can now:
// `archive` walks the map and sends each page to the Notion trash on the way
// out. `leave` is the old behaviour, kept because a user who has since made
// those rows their own — relations, extra properties, a view built on them —
// may well prefer duplicates to losing them.
const existingRowsValidator = v.union(
  v.literal("archive"),
  v.literal("leave"),
);

type ExistingRows = "archive" | "leave";

// Rebuild everything from scratch: forget every Notion page id this app has
// recorded, rewind the transactions cursors, and start a fresh sync for each
// connection.
//
// With `leave`, nothing here touches Notion, so rows from the last build stay
// where they are and the rebuild writes new ones alongside them. Categories
// are the exception either way — those are matched back up by their ID
// property (see ensureCategoryPage).
export const resetAndResync = action({
  args: { existingRows: existingRowsValidator },
  handler: async (ctx, args): Promise<{ connections: number }> => {
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
    return await resetUser(ctx, userId, args.existingRows);
  },
});

// Same thing for `npx convex run`, which has no signed-in user to read.
export const resetAndResyncByEmail = internalAction({
  args: { email: v.string(), existingRows: existingRowsValidator },
  handler: async (ctx, args): Promise<{ connections: number }> => {
    const userId = await ctx.runQuery(internal.syncData.getUserIdByEmail, {
      email: args.email,
    });
    if (!userId) {
      throw new Error(`No user with email ${args.email}`);
    }
    return await resetUser(ctx, userId, args.existingRows);
  },
});

async function resetUser(
  ctx: ActionCtx,
  userId: Id<"users">,
  existingRows: ExistingRows,
): Promise<{ connections: number }> {
  const connections = await ctx.runQuery(
    internal.connections.listByUserInternal,
    { userId },
  );
  if (existingRows === "archive") {
    // Handed to a chain rather than done here: archiving a long history is
    // thousands of Notion writes at ~3 rps, which is hours, and the map is
    // what the chain reads to know what is left. Cursors are rewound and the
    // syncs start at the end of it, so a rebuild never races the teardown.
    await ctx.scheduler.runAfter(0, internal.sync.archiveMappedPages, {
      userId,
    });
    return { connections: connections.length };
  }
  while (await ctx.runMutation(internal.syncData.clearMapEntries, { userId })) {
    // Batched; keep going until the table is empty for this user.
  }
  await startRebuild(ctx, userId);
  return { connections: connections.length };
}

// Rewind every cursor and sync every bank. The end of a reset, whichever way
// the old rows were dealt with.
async function startRebuild(
  ctx: ActionCtx,
  userId: Id<"users">,
): Promise<void> {
  const connectionIds = await ctx.runMutation(internal.syncData.clearCursors, {
    userId,
  });
  for (const connectionId of connectionIds) {
    await ctx.scheduler.runAfter(0, internal.sync.runForConnection, {
      connectionId,
      trigger: "manual",
    });
  }
}

// Notion pages one hop of the teardown archives. At ~340ms a write this is
// about twenty seconds of work, which leaves room in an action for the reads
// around it.
const ARCHIVE_HOP = 50;

// Send this user's mapped Notion rows to the trash, a page at a time, then
// start the rebuild.
//
// Each hop reads the first rows still in the map, archives them, and deletes
// those rows — so "the first rows" always makes progress and the map itself is
// the queue. A row whose page has already gone from Notion is unmapped
// anyway: the aim is that nothing points at it, and 404 means that is true.
export const archiveMappedPages = internalAction({
  args: {
    userId: v.id("users"),
    archived: v.optional(v.number()),
    failed: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const notion = await ctx.runQuery(internal.notion.getConnectionInternal, {
      userId: args.userId,
    });
    let archived = args.archived ?? 0;
    let failed = args.failed ?? 0;

    if (!notion) {
      // Disconnected mid-teardown. Nothing can be archived, so finish the
      // reset rather than stranding it half done.
      console.error("reset: Notion went away mid-teardown; forgetting the map");
      while (
        await ctx.runMutation(internal.syncData.clearMapEntries, {
          userId: args.userId,
        })
      ) {
        // Batched.
      }
      await startRebuild(ctx, args.userId);
      return;
    }

    const rows = await ctx.runQuery(internal.syncData.getMapPage, {
      userId: args.userId,
      limit: ARCHIVE_HOP,
    });
    if (rows.length === 0) {
      console.log(
        `reset: archived ${archived} Notion row(s)` +
          (failed ? `, ${failed} could not be archived and were left` : ""),
      );
      await startRebuild(ctx, args.userId);
      return;
    }

    for (const row of rows) {
      // An empty page id is an in-flight claim, not a page.
      if (!row.notionPageId) {
        continue;
      }
      try {
        await archivePage(notion.accessToken, row.notionPageId);
        archived++;
      } catch (error) {
        // Already gone is the outcome we wanted. Anything else is left in
        // Notion — which is the "leave" outcome for that one row, and better
        // than a teardown that cannot finish.
        if (!String(error).includes("(404)")) {
          console.error("reset: could not archive", row.notionPageId, error);
          failed++;
        }
      }
    }
    // Dropped whether or not the archive worked: a map row that survives a
    // failed archive would be read again on the next hop, forever.
    await ctx.runMutation(internal.syncData.deleteMapRows, {
      ids: rows.map((row) => row.id),
    });

    await ctx.scheduler.runAfter(0, internal.sync.archiveMappedPages, {
      userId: args.userId,
      archived,
      failed,
    });
  },
});

// ---------- connection status ----------

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
      await commentOnStatusChange(ctx, args.connectionId, notion.accessToken, pageId);
    } catch (error) {
      console.error("failed to write connection status to Notion", error);
    }
  },
});

// Give a connection an icon by hand, and put it on the rows it already has.
//
// Plaid returns a logo for most institutions and nothing for the rest, and
// there is no fixing that from here — so this takes a URL, records it, and
// applies it immediately to the Bank Connection row and every Account row
// under it rather than waiting for a sync to notice.
//
// The URL is handed to Notion as an external icon, so Notion fetches and
// renders it: no upload, and nothing of the image is stored here.
//
//   npx convex run sync:setConnectionIcon '{"institutionName":"Chase","iconUrl":"https://…"}'
export const setConnectionIcon = internalAction({
  args: {
    // By name, because this is run by a person who is looking at the app, not
    // at a table of ids.
    institutionName: v.string(),
    iconUrl: v.string(),
  },
  handler: async (ctx, args): Promise<{ pages: number }> => {
    const connection = await ctx.runQuery(
      internal.connections.getByInstitutionInternal,
      { institutionName: args.institutionName },
    );
    if (!connection) {
      throw new Error(`No connection called "${args.institutionName}"`);
    }
    await ctx.runMutation(internal.connections.setInstitutionIconUrl, {
      connectionId: connection._id,
      iconUrl: args.iconUrl,
    });

    const notion = await ctx.runQuery(internal.notion.getConnectionInternal, {
      userId: connection.userId,
    });
    if (!notion?.databases) {
      return { pages: 0 };
    }
    const accounts = await ctx.runQuery(internal.connections.listAccountsInternal, {
      connectionId: connection._id,
    });
    const icon = externalIcon(args.iconUrl);

    // The connection's own row, then each of its accounts. Every one of these
    // already has a page or it has never synced, in which case the next sync
    // creates it with the icon.
    const targets = await ctx.runQuery(internal.syncData.getMapEntries, {
      userId: connection.userId,
      kind: "bankConnection",
      providerIds: [connection.plaidItemId],
    });
    const accountPages = await ctx.runQuery(internal.syncData.getMapEntries, {
      userId: connection.userId,
      kind: "account",
      providerIds: accounts.map((account) => account.plaidAccountId),
    });

    let pages = 0;
    for (const pageId of [
      ...Object.values(targets),
      ...Object.values(accountPages),
    ]) {
      await setPageIcon(notion.accessToken, pageId, icon);
      pages++;
    }
    console.log(`icon set on ${pages} page(s) for ${args.institutionName}`);
    return { pages };
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
      v.literal("retry"),
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
      // Before writing anything: a property added to a spec since this
      // destination was built is not on it, and writing a column that is not
      // there is a 400 for the whole row. Costs one integer comparison once
      // the destination is current.
      if (notion.schemaVersion !== NOTION_SCHEMA_VERSION) {
        await ctx.runAction(internal.notion.ensureDatabaseColumns, {
          userId: connection.userId,
        });
      }
      // One request, so the Rules page always knows about a column added in
      // Notion since the last sync — and so a rule pointed at one that has
      // since been deleted stops being written.
      if (notion.databases?.transactions) {
        await ctx.runAction(internal.notion.refreshManualProperties, {
          userId: connection.userId,
          keys: ["transactions"],
        });
      }

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
      // The title each account row got, which is what a {account} token in
      // any other database's format refers to.
      const accountNames: Record<string, string> = {};
      for (const account of balances.data.accounts) {
        if (!enabledIds.has(account.account_id)) {
          continue;
        }
        const accountName = accountTitle(
          connection.institutionName,
          account,
          customNames.get(account.account_id),
        );
        accountNames[account.account_id] = accountName;
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
                renderTitle(
                  notion.titleFormats?.balanceHistory,
                  {
                    date: day,
                    account: accountName,
                    balance: balanceForNotion(account),
                  },
                  `${day} · ${accountName}`,
                  account.balances.iso_currency_code ?? undefined,
                ),
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

      // 4. Categories — the whole taxonomy, not just ones a transaction has
      //    mentioned. Recurring and a rule that recategorises into something
      //    unspent both need the row to exist first.
      if (notion.modules.spending && databases.categories) {
        await seedCategories(ctx, {
          userId: connection.userId,
          token,
          databaseId: databases.categories,
        });
      }

      // 5. Holdings + securities
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
          accountNames,
        });
      }

      // 6. Recurring streams
      if (notion.modules.recurring && databases.recurring) {
        await syncRecurring(ctx, { context, runId, accountPages, accountNames });
      }

      // 7. Hand off to the transaction chain, catching up any account that
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
        // Nothing to come back to: retrying finds the same nothing.
        retryable: false,
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
      const accountNames = accountTitles(context);
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
        console.error(
          "account catch-up failed",
          args.plaidAccountId,
          plaidErrorInfo(error).message,
        );
        if (itemIsBroken(error)) {
          // Every stage after this one talks to the same Item and will hit
          // the same wall, so there is nothing to carry on to.
          await failRun(ctx, {
            runId: args.runId,
            connectionId: args.connectionId,
            stage: "Account catch-up",
            error,
          });
          return;
        }
        // Nothing here has consumed a cursor, so a passing failure costs only
        // this attempt: keep the flag and let a later run retry.
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
            titleFormats: notion.titleFormats,
            accountName: accountNames[txn.account_id],
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

// Plaid rejects a page of transactions/sync when the Item's data changed
// underneath the pagination, and asks for the walk to be restarted.
//
// Restarted from *where* is the whole of it. Every page's next_cursor is
// persisted as it is written, so the obvious reading is "carry on from the
// one you have" — and that does not work: the mid-sequence cursors belong to
// a snapshot Plaid has just thrown away, so resuming from one is rejected
// again, and again, for as long as anyone keeps trying. A run doing exactly
// that was observed restarting five times, processing nothing each time.
//
// So a restart goes back to the cursor the *sequence* began with, which is
// the last one from a walk that finished. Re-walking pages already written is
// free of consequence — the page map turns every one of them into an update —
// and it is the only position Plaid will still accept.
//
// Expected rather than exceptional: a busy Item mutates while a backfill is
// walking it, and Notion's three writes a second make that window wide.
const MUTATION_DURING_PAGINATION = "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION";

// Restarts one run will do before giving up and letting it fail properly. An
// Item mutating faster than a whole sequence can be written is a real
// condition, and somebody has to stop.
const MAX_PAGINATION_RESTARTS = 4;

export const transactionsBatch = internalAction({
  args: {
    connectionId: v.id("bankConnections"),
    runId: v.id("syncRuns"),
    // How many times this run has been sent back to the start of the walk.
    restarts: v.optional(v.number()),
    // The cursor this pagination sequence started from, carried along the
    // has_more chain so a mutation part-way through knows where to rewind to.
    // Absent on the first hop, which reads it off the connection.
    sequenceStart: v.optional(v.string()),
    // Whether this hop is the first of its sequence, which is the only time
    // sequenceStart may legitimately be undefined (an Item that has never
    // synced has no cursor at all).
    sequenceStarted: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const context = await loadContext(ctx, args.connectionId);
    if (!context) {
      // Returning here without finishing left the run "running" forever, and
      // with it the connection's lease.
      await ctx.runMutation(internal.syncData.finishRun, {
        runId: args.runId,
        status: "error",
        // Nothing to come back to: retrying finds the same nothing.
        retryable: false,
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
      // Established once per sequence and carried from there; on the first
      // hop it is wherever the connection had got to.
      const sequenceStart = args.sequenceStarted
        ? args.sequenceStart
        : connection.transactionsCursor;
      let response;
      try {
        response = await client.transactionsSync({
          access_token: connection.accessToken,
          cursor: connection.transactionsCursor,
          count: TXN_BATCH_SIZE,
          options: { include_original_description: true },
        });
      } catch (error: any) {
        if (plaidErrorInfo(error).code !== MUTATION_DURING_PAGINATION) {
          throw error;
        }
        const restarts = (args.restarts ?? 0) + 1;
        if (restarts > MAX_PAGINATION_RESTARTS) {
          throw error;
        }
        // Back to where the sequence began. The cursors written since belong
        // to a snapshot Plaid has discarded, so they are not resumable; the
        // pages they covered are already in Notion and will be updated in
        // place on the way back through.
        //
        // Unless the sequence began where we already are — the first page of
        // the walk is the one being refused. Then there is nothing earlier
        // recorded to go back to, and the stored position is itself one Plaid
        // will not take, which is exactly how a connection gets stuck for
        // good. The only position left is the beginning of the Item.
        const stuck = sequenceStart === connection.transactionsCursor;
        await ctx.runMutation(internal.syncData.rewindCursor, {
          connectionId: connection._id,
          cursor: stuck ? undefined : sequenceStart,
        });
        console.log(
          stuck
            ? `transactions cursor refused at the start of the walk; ` +
                `replaying this Item from the beginning ` +
                `(${restarts} of ${MAX_PAGINATION_RESTARTS})`
            : `transactions changed mid-walk, restarting the sequence ` +
                `(${restarts} of ${MAX_PAGINATION_RESTARTS})`,
        );
        await ctx.scheduler.runAfter(
          // Backing off properly: an Item busy enough to mutate mid-walk is
          // an Item worth giving a moment to settle.
          2000 * 2 ** (restarts - 1),
          internal.sync.transactionsBatch,
          {
            connectionId: connection._id,
            runId: args.runId,
            restarts,
          },
        );
        return;
      }
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
      const accountNames = accountTitles(context);

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
            titleFormats: notion.titleFormats,
            accountName: accountNames[txn.account_id],
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
          // The whole point of holding the cursor was to try this page again.
          retryable: true,
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
          // Just decided not to try these again.
          retryable: false,
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
          restarts: args.restarts,
          sequenceStart,
          sequenceStarted: true,
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

// How far back a routine investments pass reads.
//
// Plaid has no cursor for investment transactions — the only way to ask is a
// date range — so a run re-reads and re-writes every row in whatever range it
// is given. Reading from the start date every time meant a daily cron PATCHing
// years of settled trades into Notion, thousands of writes at ~3 rps, to find
// the handful that changed. Amendments land within days, so a month is
// generous.
const INVESTMENTS_WINDOW_DAYS = 30;

// How long between full passes. The full window is the only thing that can
// notice a canceled trade has dropped out of Plaid's history, so it still has
// to happen — just not every morning.
const INVESTMENTS_FULL_SYNC_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

function windowStart(days: number, end: string): string {
  const start = new Date(`${end}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - days);
  return start.toISOString().slice(0, 10);
}

export const investmentsBatch = internalAction({
  args: {
    connectionId: v.id("bankConnections"),
    runId: v.id("syncRuns"),
    offset: v.number(),
    // Rows earlier pages of this window failed to write. Carried along
    // because reconciliation may only run after a walk that saw everything.
    pageErrors: v.optional(v.number()),
    // Whether this walk covers the whole history or only the recent window.
    // Decided once, on the first page, and carried through the continuation:
    // pages of one walk have to agree on the range they are paging through,
    // and only a full walk may archive.
    full: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const context = await loadContext(ctx, args.connectionId);
    if (!context) {
      await ctx.runMutation(internal.syncData.finishRun, {
        runId: args.runId,
        status: "error",
        // Nothing to come back to: retrying finds the same nothing.
        retryable: false,
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
      const end = todayUTC();
      // Decided on the first page and carried from there, so every page of one
      // walk pages through the same range.
      const full =
        args.full ??
        Date.now() - (connection.lastInvestmentsFullSyncAt ?? 0) >=
          INVESTMENTS_FULL_SYNC_INTERVAL_MS;
      const configuredStart = notion.startDate ?? "2000-01-01";
      const recentStart = windowStart(INVESTMENTS_WINDOW_DAYS, end);
      // A recent window that reaches back before the configured start date is
      // just the configured start date.
      const start = full
        ? configuredStart
        : recentStart > configuredStart
          ? recentStart
          : configuredStart;
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
      const securityNames = Object.fromEntries(
        securities.map((security) => [
          security.security_id,
          security.ticker_symbol ?? security.name ?? security.security_id,
        ]),
      );
      const accountNames = accountTitles(context);
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
            notion.titleFormats,
            {
              account: accountNames[txn.account_id],
              security: securityNames[txn.security_id ?? ""],
            },
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
            // Structural: the same offset would return the same nothing.
            retryable: false,
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
          full,
        });
        return;
      }

      // The window is fully walked. Plaid drops a canceled investment
      // transaction out of the window rather than reporting it as removed,
      // so anything still mapped for this Item's accounts that the walk
      // never mentioned is gone and its Notion row should be archived.
      //
      // Only after a clean walk of the *whole* window. A recent-window pass
      // never mentions last year's trades, so every one of them would look
      // vanished — and a walk cut short by write failures would archive live
      // history for the same reason.
      if (pageErrors === 0 && full) {
        await ctx.runMutation(internal.syncData.recordInvestmentsFullSync, {
          connectionId: connection._id,
        });
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
      if (pageErrors === 0) {
        // A clean pass over the recent window. Nothing to reconcile against —
        // that is the full pass's job, and it stays due until one runs.
        await ctx.runMutation(internal.syncData.finishRun, {
          runId: args.runId,
          status: "success",
        });
        return;
      }
      await ctx.runMutation(internal.syncData.finishRun, {
        runId: args.runId,
        status: "error",
        retryable: true,
        error:
          `${pageErrors} investment transaction(s) failed to reach Notion` +
          (full
            ? `; skipped archiving rows that vanished from Plaid this run.`
            : `.`),
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

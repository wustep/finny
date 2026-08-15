import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";

const kindValidator = v.union(
  v.literal("bankConnection"),
  v.literal("account"),
  v.literal("transaction"),
  v.literal("security"),
  v.literal("holding"),
  v.literal("investmentTransaction"),
  v.literal("category"),
  v.literal("balanceSnapshot"),
  v.literal("recurringStream"),
);

// Everything the sync engine needs to run for one connection.
export const getContext = internalQuery({
  args: { connectionId: v.id("bankConnections") },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (!connection) {
      return null;
    }
    const notion = await ctx.db
      .query("notionConnections")
      .withIndex("by_user", (q) => q.eq("userId", connection.userId))
      .unique();
    const accounts = await ctx.db
      .query("accounts")
      .withIndex("by_connection", (q) => q.eq("connectionId", connection._id))
      .collect();
    return { connection, notion, accounts };
  },
});

const triggerValidator = v.union(
  v.literal("initial"),
  v.literal("webhook"),
  v.literal("manual"),
  v.literal("cron"),
  v.literal("retry"),
);

// How long a lease survives without a heartbeat. Long enough for the
// slowest single hop — a full accounts + holdings pass against Notion's
// ~3 rps — and short enough that a run killed mid-chain unblocks the Item
// within one cron interval.
const SYNC_LEASE_MS = 10 * 60 * 1000;

// How long a webhook that lost the race waits before trying again.
const SYNC_FOLLOW_UP_MS = 60 * 1000;

// Take the connection's sync lease and open a run for it, or report that
// someone else holds it. Both halves live in one mutation because mutations
// are serializable: a check in one call and a set in another let two
// webhooks 1ms apart each believe they were first.
export const beginRun = internalMutation({
  args: {
    userId: v.id("users"),
    connectionId: v.id("bankConnections"),
    trigger: triggerValidator,
  },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (!connection) {
      return { acquired: false as const };
    }
    const now = Date.now();
    if ((connection.syncLockExpiresAt ?? 0) > now) {
      // Dropping a webhook loses the update that prompted it, so queue one
      // retry. Only one may be outstanding, or a burst of webhooks against
      // a long backfill piles up a run per webhook.
      if (
        args.trigger === "webhook" &&
        (connection.syncFollowUpAt ?? 0) <= now
      ) {
        await ctx.db.patch(args.connectionId, {
          syncFollowUpAt: now + SYNC_FOLLOW_UP_MS,
        });
        await ctx.scheduler.runAfter(
          SYNC_FOLLOW_UP_MS,
          internal.sync.runForConnection,
          { connectionId: args.connectionId, trigger: "webhook" },
        );
      }
      return { acquired: false as const };
    }
    const runId = await ctx.db.insert("syncRuns", {
      userId: args.userId,
      connectionId: args.connectionId,
      trigger: args.trigger,
      status: "running",
      startedAt: now,
      stats: { added: 0, modified: 0, removed: 0 },
    });
    await ctx.db.patch(args.connectionId, {
      syncLockExpiresAt: now + SYNC_LEASE_MS,
      activeRunId: runId,
      syncFollowUpAt: undefined,
    });
    return { acquired: true as const, runId };
  },
});

// Push the lease expiry out from a batch hop. Returns false if the lease has
// already been handed to someone else, which means this run has been
// superseded and should stop rather than keep writing.
export const renewSyncLease = internalMutation({
  args: {
    connectionId: v.id("bankConnections"),
    runId: v.id("syncRuns"),
  },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (!connection || connection.activeRunId !== args.runId) {
      return false;
    }
    await ctx.db.patch(args.connectionId, {
      syncLockExpiresAt: Date.now() + SYNC_LEASE_MS,
    });
    return true;
  },
});

export const addRunStats = internalMutation({
  args: {
    runId: v.id("syncRuns"),
    added: v.number(),
    modified: v.number(),
    removed: v.number(),
    skipped: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) {
      return;
    }
    const stats = run.stats ?? { added: 0, modified: 0, removed: 0 };
    await ctx.db.patch(args.runId, {
      stats: {
        added: stats.added + args.added,
        modified: stats.modified + args.modified,
        removed: stats.removed + args.removed,
        skipped: (stats.skipped ?? 0) + (args.skipped ?? 0),
      },
    });
  },
});

// How long after a failed run the next attempt is due. Growing, because a
// failure that survives five minutes is unlikely to clear in another five;
// short enough that the first two land well inside the day the daily sweep
// would otherwise have made the user wait.
const RETRY_DELAYS_MS = [5 * 60 * 1000, 20 * 60 * 1000, 60 * 60 * 1000];

export const finishRun = internalMutation({
  args: {
    runId: v.id("syncRuns"),
    status: v.union(v.literal("success"), v.literal("error")),
    error: v.optional(v.string()),
    // Whether this failure is the kind another attempt could get past — a
    // Notion 5xx, a rate limit, a page that failed to write. Callers pass
    // false for anything a human has to fix first (a broken bank, a
    // destination that went away), where retrying only writes the same error
    // to the log three more times.
    retryable: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) {
      return;
    }
    await ctx.db.patch(args.runId, {
      status: args.status,
      error: args.error,
      finishedAt: Date.now(),
    });
    if (!run.connectionId) {
      return;
    }
    // Releasing the lease is the whole point of finishRun being on every
    // exit path — including the error ones.
    const connection = await ctx.db.get(run.connectionId);
    if (connection?.activeRunId === args.runId) {
      await ctx.db.patch(run.connectionId, {
        syncLockExpiresAt: undefined,
        activeRunId: undefined,
      });
    }
    if (args.status === "success") {
      const recovered = connection !== null && connection.status !== "active";
      await ctx.db.patch(run.connectionId, {
        lastSyncedAt: Date.now(),
        status: "active",
        errorCode: undefined,
      });
      // A run that worked ends the retry sequence, whatever it took.
      await ctx.db.patch(run.connectionId, { syncRetryCount: undefined });
      if (recovered) {
        // A bank that fixed itself is worth saying out loud, since the user
        // was told when it broke. The push is what writes the Notion row's
        // Status and leaves the comment; it de-duplicates itself.
        await ctx.scheduler.runAfter(
          0,
          internal.sync.pushConnectionStatusToNotion,
          { connectionId: run.connectionId },
        );
      }
      return;
    }
    if (!args.retryable || !connection) {
      return;
    }
    // Scheduled from here rather than from the action that failed, because
    // this is the one place every failure passes through — and because the
    // lease is released in the same transaction, so the retry cannot arrive
    // to find the connection still locked by the run that scheduled it.
    const attempt = connection.syncRetryCount ?? 0;
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay === undefined) {
      // Out of attempts. The daily sweep is the backstop, and the run rows
      // say what has been happening.
      return;
    }
    await ctx.db.patch(run.connectionId, { syncRetryCount: attempt + 1 });
    await ctx.scheduler.runAfter(delay, internal.sync.runForConnection, {
      connectionId: run.connectionId,
      trigger: "retry",
    });
  },
});

// Take the right to comment about this connection's current state, once.
//
// Read-and-set in one mutation because several paths reach here at the same
// moment — a webhook, the run it schedules, and the daily sweep — and mutations
// are serialisable, so exactly one of them comes away with the claim. Returns
// null when there is nothing new to say.
export const claimStatusNotification = internalMutation({
  args: { connectionId: v.id("bankConnections") },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (!connection) {
      return null;
    }
    const key = `${connection.status}:${connection.errorCode ?? ""}`;
    if (connection.notifiedStatusKey === key) {
      return null;
    }
    const first = connection.notifiedStatusKey === undefined;
    await ctx.db.patch(args.connectionId, { notifiedStatusKey: key });
    // A connection that has never been commented about and is simply working
    // is not news; saying "all fine" the first time a sync runs would be.
    if (first && connection.status === "active") {
      return null;
    }
    return {
      status: connection.status,
      errorCode: connection.errorCode,
      institutionName: connection.institutionName,
    };
  },
});

export const setCursor = internalMutation({
  args: {
    connectionId: v.id("bankConnections"),
    cursor: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.connectionId, {
      transactionsCursor: args.cursor,
      // The page this counter was about is behind us now.
      cursorFailures: undefined,
    });
  },
});

// Count one run that could not write every row of the page at the current
// cursor. Returns the number of consecutive failed attempts so far.
export const recordCursorFailure = internalMutation({
  args: { connectionId: v.id("bankConnections") },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (!connection) {
      return 0;
    }
    const failures = (connection.cursorFailures ?? 0) + 1;
    await ctx.db.patch(args.connectionId, { cursorFailures: failures });
    return failures;
  },
});

// Note that a run walked the whole investments window and reached the end of
// it cleanly. Investment transactions have no cursor, so this is the only
// record of when the history was last seen in full — which is both what
// schedules the next full pass and what licenses archiving.
export const recordInvestmentsFullSync = internalMutation({
  args: { connectionId: v.id("bankConnections") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.connectionId, {
      lastInvestmentsFullSyncAt: Date.now(),
    });
  },
});

export const getUserIdByEmail = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", args.email))
      .unique();
    return user?._id ?? null;
  },
});

// Forget every page this app has created for a user, in bounded batches so a
// large history cannot blow the mutation limit. Returns true while more
// remain.
export const clearMapEntries = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const BATCH = 500;
    const entries = await ctx.db
      .query("notionPageMap")
      .withIndex("by_user_kind_provider", (q) => q.eq("userId", args.userId))
      .take(BATCH + 1);
    for (const entry of entries.slice(0, BATCH)) {
      await ctx.db.delete(entry._id);
    }
    return entries.length > BATCH;
  },
});

// Forget the pages of one kind, in bounded batches. Returns true while more
// remain.
//
// For a database that had to be rebuilt: its rows went with it, so every map
// entry addressing one is an address of a page that is not there. Left in
// place, the next sync patches each of them, every patch 404s, and the run
// fails on rows it could have simply created.
export const clearMapEntriesOfKind = internalMutation({
  args: { userId: v.id("users"), kind: kindValidator },
  handler: async (ctx, args) => {
    const BATCH = 500;
    const entries = await ctx.db
      .query("notionPageMap")
      .withIndex("by_user_kind_provider", (q) =>
        q.eq("userId", args.userId).eq("kind", args.kind),
      )
      .take(BATCH + 1);
    for (const entry of entries.slice(0, BATCH)) {
      await ctx.db.delete(entry._id);
    }
    return entries.length > BATCH;
  },
});

// The first page of a user's mapped rows, for a teardown that archives them
// in Notion before forgetting them.
//
// Deliberately unordered and always "the first N": the caller deletes each
// page as it finishes with it, so the next call returns the next ones. Every
// kind is in scope here — this is the one read that legitimately spans them,
// because it is bounded by the take rather than by the range.
export const getMapPage = internalQuery({
  args: { userId: v.id("users"), limit: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("notionPageMap")
      .withIndex("by_user_kind_provider", (q) => q.eq("userId", args.userId))
      .take(Math.min(args.limit, 200));
    return rows.map((row) => ({ id: row._id, notionPageId: row.notionPageId }));
  },
});

export const deleteMapRows = internalMutation({
  args: { ids: v.array(v.id("notionPageMap")) },
  handler: async (ctx, args) => {
    for (const id of args.ids) {
      await ctx.db.delete(id);
    }
  },
});

// Rewind every connection's transactions/sync cursor so the next run replays
// the full history rather than only what has changed since last time.
export const clearCursors = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const connections = await ctx.db
      .query("bankConnections")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    for (const connection of connections) {
      await ctx.db.patch(connection._id, { transactionsCursor: undefined });
    }
    return connections.map((connection) => connection._id);
  },
});

// ---------- providerId -> Notion page id map ----------

// Kinds whose row count per user grows with how long they have been using
// Finny rather than with the shape of their accounts. A whole (userId, kind)
// range of one of these is unbounded by construction, so nothing may read it:
// walk one account at a time through by_user_kind_account_provider instead
// (see getVanishedInvestmentTransactions).
const UNBOUNDED_KINDS: ReadonlySet<string> = new Set([
  "transaction",
  "investmentTransaction",
  "balanceSnapshot",
]);

// Point lookups, so the read is bounded by the caller's providerIds — which
// is one Plaid page (≤ 100 ids) at every call site.
export const getMapEntries = internalQuery({
  args: {
    userId: v.id("users"),
    kind: kindValidator,
    providerIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const result: Record<string, string> = {};
    for (const providerId of args.providerIds) {
      const entry = await ctx.db
        .query("notionPageMap")
        .withIndex("by_user_kind_provider", (q) =>
          q
            .eq("userId", args.userId)
            .eq("kind", args.kind)
            .eq("providerId", providerId),
        )
        .unique();
      // An empty id is an in-flight claim, not a page.
      if (entry?.notionPageId) {
        result[providerId] = entry.notionPageId;
      }
    }
    return result;
  },
});

// Every row of one bounded kind, as providerId -> Notion page id.
//
// "Bounded" is the whole contract: this reads a full (userId, kind) range, so
// it is only ever correct for a kind whose row count is set by the shape of
// the user's accounts — bankConnection (one per Item), account (one per
// account), category (≤ 127 Plaid personal finance categories), security (one
// per instrument the user holds). The kinds that grow with history are
// rejected rather than documented, because the failure mode is a query that
// works fine for a year and then stops.
export const getAllMapEntries = internalQuery({
  args: { userId: v.id("users"), kind: kindValidator },
  handler: async (ctx, args) => {
    if (UNBOUNDED_KINDS.has(args.kind)) {
      throw new Error(
        `getAllMapEntries is not safe for kind "${args.kind}": that range ` +
          `grows with the user's history. Read it per account through ` +
          `by_user_kind_account_provider instead.`,
      );
    }
    // Bounded by the kinds allowed above, none of which grows with history.
    const entries = await ctx.db
      .query("notionPageMap")
      .withIndex("by_user_kind_provider", (q) =>
        q.eq("userId", args.userId).eq("kind", args.kind),
      )
      .collect();
    return Object.fromEntries(
      entries
        .filter((entry) => entry.notionPageId)
        .map((entry) => [entry.providerId, entry.notionPageId]),
    );
  },
});

// Rows for one Plaid account of a kind whose per-account count is bounded by
// the account itself — holdings, where there is one row per portfolio
// position. Capped anyway: an account with more positions than this loses
// archival of the overflow, never correctness, because a create still finds
// the existing row through claimMapEntry.
const ACCOUNT_SCOPED_MAX = 500;

export const getAccountMapEntries = internalQuery({
  args: {
    userId: v.id("users"),
    kind: kindValidator,
    accountId: v.string(),
  },
  handler: async (ctx, args) => {
    const entries = await ctx.db
      .query("notionPageMap")
      .withIndex("by_user_kind_account_provider", (q) =>
        q
          .eq("userId", args.userId)
          .eq("kind", args.kind)
          .eq("accountId", args.accountId),
      )
      .take(ACCOUNT_SCOPED_MAX);
    if (entries.length === ACCOUNT_SCOPED_MAX) {
      console.error(
        `more than ${ACCOUNT_SCOPED_MAX} ${args.kind} rows on account ` +
          `${args.accountId}; the rest are not visible to this pass`,
      );
    }
    return Object.fromEntries(
      entries
        .filter((entry) => entry.notionPageId)
        .map((entry) => [entry.providerId, entry.notionPageId]),
    );
  },
});

// A claim whose owner never came back is up for grabs again. Only one Notion
// create sits between claim and finish, so this just has to outlast a slow
// API call and its retries.
const CLAIM_TIMEOUT_MS = 60_000;

// Reserve the right to create the Notion page for a mapped key.
//
// Every kind goes through this. Creating first and mapping afterwards leaves
// a window in which a crash, a retried Plaid page, or a second run scheduled
// against the same connection makes a duplicate Notion row that nothing
// points at. Mutations are serializable, so exactly one caller comes away
// with "create"; the rest get "pending" and wait for it to land.
//
// Convex has no unique indexes, so by_user_kind_provider uniqueness is
// enforced here and in putMapEntries / rekeyMapEntry: read and write in one
// transaction, never patch a key that already has a row.
export const claimMapEntry = internalMutation({
  args: {
    userId: v.id("users"),
    kind: kindValidator,
    providerId: v.string(),
    // The Plaid account this row belongs to, where the caller knows it.
    // Written at insert time so rows created from now on are already scoped
    // for reconciliation; backfillMapScopes handles the ones that are not.
    accountId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("notionPageMap")
      .withIndex("by_user_kind_provider", (q) =>
        q
          .eq("userId", args.userId)
          .eq("kind", args.kind)
          .eq("providerId", args.providerId),
      )
      .unique();

    if (existing?.notionPageId) {
      return { status: "ready" as const, notionPageId: existing.notionPageId };
    }
    if (existing) {
      if (Date.now() - (existing.claimedAt ?? 0) < CLAIM_TIMEOUT_MS) {
        return { status: "pending" as const };
      }
      await ctx.db.patch(existing._id, { claimedAt: Date.now() });
      // Whoever held this claim never came back, and may well have created
      // the Notion page before dying. Tell the taker to look before creating.
      return { status: "create" as const, reclaimed: true };
    }
    await ctx.db.insert("notionPageMap", {
      userId: args.userId,
      kind: args.kind,
      providerId: args.providerId,
      notionPageId: "",
      claimedAt: Date.now(),
      accountId: args.accountId,
    });
    return { status: "create" as const, reclaimed: false };
  },
});

export const putMapEntries = internalMutation({
  args: {
    userId: v.id("users"),
    kind: kindValidator,
    entries: v.array(
      v.object({
        providerId: v.string(),
        notionPageId: v.string(),
        accountId: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    for (const entry of args.entries) {
      const existing = await ctx.db
        .query("notionPageMap")
        .withIndex("by_user_kind_provider", (q) =>
          q
            .eq("userId", args.userId)
            .eq("kind", args.kind)
            .eq("providerId", entry.providerId),
        )
        .unique();
      if (existing) {
        if (
          existing.notionPageId !== entry.notionPageId ||
          (entry.accountId !== undefined && existing.accountId === undefined)
        ) {
          await ctx.db.patch(existing._id, {
            notionPageId: entry.notionPageId,
            // Scope a row this caller knows the account for, so a legacy row
            // the sync touches again stops being legacy.
            accountId: entry.accountId ?? existing.accountId,
          });
        }
      } else {
        await ctx.db.insert("notionPageMap", {
          userId: args.userId,
          kind: args.kind,
          providerId: entry.providerId,
          notionPageId: entry.notionPageId,
          accountId: entry.accountId,
        });
      }
    }
  },
});

export const deleteMapEntries = internalMutation({
  args: {
    userId: v.id("users"),
    kind: kindValidator,
    providerIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    for (const providerId of args.providerIds) {
      const entry = await ctx.db
        .query("notionPageMap")
        .withIndex("by_user_kind_provider", (q) =>
          q
            .eq("userId", args.userId)
            .eq("kind", args.kind)
            .eq("providerId", providerId),
        )
        .unique();
      if (entry) {
        await ctx.db.delete(entry._id);
      }
    }
  },
});

// ---------- investment transaction reconciliation ----------

// Note which investment transactions Plaid still reports, and which account
// each belongs to. Called once per page of the window walk, for every id on
// the page whether or not it was in scope to sync — an id the walk mentioned
// is an id that still exists, which is all reconciliation asks.
//
// Bounded by the Plaid page size: one indexed lookup and at most one patch
// per id on the page the caller just fetched (INV_BATCH_SIZE = 100 in
// sync.ts), never per id in the user's history. Keep it that way — a caller
// that accumulated ids across pages would turn this into an unbounded write.
export const markInvestmentTransactionsSeen = internalMutation({
  args: {
    userId: v.id("users"),
    runId: v.id("syncRuns"),
    entries: v.array(
      v.object({ providerId: v.string(), accountId: v.string() }),
    ),
  },
  handler: async (ctx, args) => {
    for (const entry of args.entries) {
      const row = await ctx.db
        .query("notionPageMap")
        .withIndex("by_user_kind_provider", (q) =>
          q
            .eq("userId", args.userId)
            .eq("kind", "investmentTransaction")
            .eq("providerId", entry.providerId),
        )
        .unique();
      if (!row) {
        continue;
      }
      await ctx.db.patch(row._id, {
        accountId: entry.accountId,
        lastSeenRunId: args.runId,
      });
    }
  },
});

// Rows one reconciliation pass reads. A user's mapped investment
// transactions grow without bound, so the pass that looks for vanished ones
// can only ever read a window of them: one account, 200 rows, resumed from
// the providerId the last pass stopped at.
const RECONCILE_BATCH = 200;

// One page of mapped investment transactions on a single Plaid account that
// the given run never saw, plus where to resume.
//
// Scoped through by_user_kind_account_provider, so rows with no accountId are
// not in the range this reads at all. That is deliberate: such a row predates
// scoping and cannot be attributed to a connection, and archiving a Notion
// page on a guess is worse than reconciling one run late (or never — see
// syncData.backfillMapScopes, which scopes what it can derive).
export const getVanishedInvestmentTransactions = internalQuery({
  args: {
    userId: v.id("users"),
    runId: v.id("syncRuns"),
    accountId: v.string(),
    // Exclusive lower bound: the providerId the previous pass stopped at.
    afterProviderId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const after = args.afterProviderId;
    const rows = await ctx.db
      .query("notionPageMap")
      .withIndex("by_user_kind_account_provider", (q) => {
        const scoped = q
          .eq("userId", args.userId)
          .eq("kind", "investmentTransaction")
          .eq("accountId", args.accountId);
        return after === undefined ? scoped : scoped.gt("providerId", after);
      })
      .take(RECONCILE_BATCH);
    const vanished = rows
      .filter(
        (row) => row.notionPageId && row.lastSeenRunId !== args.runId,
      )
      .map((row) => ({
        providerId: row.providerId,
        notionPageId: row.notionPageId,
      }));
    return {
      vanished,
      // Null once this account is walked to the end. A short page is the end:
      // the index is ordered by providerId, so nothing can appear behind us.
      nextProviderId:
        rows.length === RECONCILE_BATCH
          ? rows[rows.length - 1].providerId
          : null,
    };
  },
});

// How many unscoped rows a log line will admit to. Counting them all would be
// the unbounded read this whole change exists to remove.
const UNSCOPED_SAMPLE = 500;

// Mapped investment transactions this user has that carry no accountId, so a
// run can say how many rows it is knowingly leaving unreconciled.
export const countUnscopedInvestmentTransactions = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("notionPageMap")
      .withIndex("by_user_kind_account_provider", (q) =>
        q
          .eq("userId", args.userId)
          .eq("kind", "investmentTransaction")
          .eq("accountId", undefined),
      )
      .take(UNSCOPED_SAMPLE + 1);
    return {
      count: Math.min(rows.length, UNSCOPED_SAMPLE),
      more: rows.length > UNSCOPED_SAMPLE,
    };
  },
});

// Pending transaction re-key: move the Notion page mapping from the pending
// transaction id to the posted transaction id.
export const rekeyMapEntry = internalMutation({
  args: {
    userId: v.id("users"),
    kind: kindValidator,
    fromProviderId: v.string(),
    toProviderId: v.string(),
  },
  handler: async (ctx, args) => {
    const byProviderId = (providerId: string) =>
      ctx.db
        .query("notionPageMap")
        .withIndex("by_user_kind_provider", (q) =>
          q
            .eq("userId", args.userId)
            .eq("kind", args.kind)
            .eq("providerId", providerId),
        )
        .unique();

    const from = await byProviderId(args.fromProviderId);
    if (!from) {
      return;
    }
    const to = await byProviderId(args.toProviderId);
    if (!to) {
      await ctx.db.patch(from._id, { providerId: args.toProviderId });
      return;
    }
    // The destination key already has a row. Patching onto it would leave two
    // rows under one key, which every .unique() read of this index then
    // throws on. Merge instead: the destination wins unless it is only a
    // claim, in which case it inherits the page the pending row found.
    if (!to.notionPageId && from.notionPageId) {
      await ctx.db.patch(to._id, {
        notionPageId: from.notionPageId,
        claimedAt: undefined,
      });
    }
    // If both rows point at real pages the pending one is now orphaned in
    // Notion. Dropping the mapping is still right — the alternative is a
    // duplicate that later syncs keep writing to.
    await ctx.db.delete(from._id);
  },
});

// ---------- one-off: scope legacy map rows ----------

// Rows one backfill pass reads. Each may cost one extra index lookup to
// confirm the account it derives, so a pass is ~400 reads and a few hundred
// patches — comfortably inside one transaction.
const BACKFILL_BATCH = 200;

// Accounts rows read while confirming a Plaid account id. There is one in
// practice; a handful is headroom for an id that somehow repeats.
const ACCOUNT_LOOKUP_MAX = 8;

// Does this user still have the given Plaid account? The map's keys are the
// only evidence a legacy row carries, and scoping a row to an account that
// does not exist would put it in the range reconciliation archives from.
async function ownsPlaidAccount(
  ctx: MutationCtx,
  userId: Id<"users">,
  plaidAccountId: string,
): Promise<boolean> {
  const accounts = await ctx.db
    .query("accounts")
    .withIndex("by_plaid_account", (q) =>
      q.eq("plaidAccountId", plaidAccountId),
    )
    .take(ACCOUNT_LOOKUP_MAX);
  return accounts.some((account) => account.userId === userId);
}

// The Plaid account a legacy row belongs to, or null when nothing in the row
// says. Only the kinds whose providerId carries an account id can be answered:
// `account` is keyed on it outright, and `holding` / `balanceSnapshot` prefix
// their composite keys with it.
async function deriveAccountId(
  ctx: MutationCtx,
  row: Doc<"notionPageMap">,
): Promise<string | null> {
  if (row.kind === "account") {
    return (await ownsPlaidAccount(ctx, row.userId, row.providerId))
      ? row.providerId
      : null;
  }
  if (row.kind === "holding" || row.kind === "balanceSnapshot") {
    const separator = row.providerId.indexOf("|");
    if (separator <= 0 || separator === row.providerId.length - 1) {
      return null;
    }
    const plaidAccountId = row.providerId.slice(0, separator);
    return (await ownsPlaidAccount(ctx, row.userId, plaidAccountId))
      ? plaidAccountId
      : null;
  }
  // Everything else stays unscoped. A transaction or investment transaction id
  // is an opaque Plaid string with no account in it, and Finny stores no
  // transaction data to look it up against — the account is only knowable the
  // next time Plaid mentions that id, which is when the sync records it.
  // bankConnection, security and category rows belong to the user rather than
  // to an account and have nothing to scope to. Unscoped means excluded from
  // reconciliation, which is the safe direction.
  return null;
}

// Backfill notionPageMap.accountId on rows written before it was tracked, in
// bounded passes that continue through the scheduler.
//
// Idempotent: a row that already carries an accountId is skipped, and every
// derivation reads only the row's own key plus the accounts table, so re-runs
// converge on the same answer. Safe to run while syncs are live — the patch
// only fills in a missing field, and a pass that loses an OCC race against a
// sync writing the same row simply retries.
//
// Run it once after deploy:
//   npx convex run syncData:backfillMapScopes '{}'
export const backfillMapScopes = internalMutation({
  args: {
    // Continuation cursor: rows created after this time. Absent on the first
    // pass. Creation time orders the built-in index, so a pass that resumes
    // from the last row it read cannot revisit or skip one.
    after: v.optional(v.number()),
    scanned: v.optional(v.number()),
    scoped: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("notionPageMap")
      .withIndex("by_creation_time", (q) =>
        q.gt("_creationTime", args.after ?? 0),
      )
      .take(BACKFILL_BATCH);

    let scoped = 0;
    for (const row of rows) {
      if (row.accountId !== undefined) {
        continue;
      }
      const accountId = await deriveAccountId(ctx, row);
      if (accountId === null) {
        continue;
      }
      await ctx.db.patch(row._id, { accountId });
      scoped++;
    }

    const totals = {
      scanned: (args.scanned ?? 0) + rows.length,
      scoped: (args.scoped ?? 0) + scoped,
    };
    if (rows.length === BACKFILL_BATCH) {
      await ctx.scheduler.runAfter(0, internal.syncData.backfillMapScopes, {
        after: rows[rows.length - 1]._creationTime,
        ...totals,
      });
      return { done: false, ...totals };
    }
    console.log(
      `backfillMapScopes finished: scanned ${totals.scanned} row(s), ` +
        `scoped ${totals.scoped}`,
    );
    return { done: true, ...totals };
  },
});

// ---------- stuck run sweep ----------

// A run only leaves "running" through finishRun, which every exit path of
// the chain calls. An action that dies hard — killed mid-hop, a deploy in
// the middle of a backfill — never reaches it, so the row keeps claiming the
// sync is in progress long after it stopped. The lease frees itself by
// expiry; the run row needs telling.
//
// Generous on purpose: a first backfill of two years against Notion's ~3 rps
// legitimately runs for hours, and the heartbeat is what distinguishes it.
const STUCK_RUN_MS = 2 * 60 * 60 * 1000;

// Bounded so one sweep cannot blow the mutation limit; a backlog clears over
// consecutive days.
const STUCK_RUN_LIMIT = 100;

export const sweepStuckRuns = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const stale = await ctx.db
      .query("syncRuns")
      .withIndex("by_status_and_startedAt", (q) =>
        q.eq("status", "running").lt("startedAt", now - STUCK_RUN_MS),
      )
      .take(STUCK_RUN_LIMIT);

    let closed = 0;
    for (const run of stale) {
      const connection = run.connectionId
        ? await ctx.db.get(run.connectionId)
        : null;
      // Every hop of the chain heartbeats the lease, so this run still
      // holding an unexpired one means it is alive and slow, not dead.
      const alive =
        connection?.activeRunId === run._id &&
        (connection.syncLockExpiresAt ?? 0) > now;
      if (alive) {
        continue;
      }
      await ctx.db.patch(run._id, {
        status: "error",
        error: "timed out",
        finishedAt: now,
      });
      // Only when it is still this run's lease: a newer run may already
      // have taken the connection over.
      if (connection?.activeRunId === run._id) {
        await ctx.db.patch(connection._id, {
          syncLockExpiresAt: undefined,
          activeRunId: undefined,
        });
      }
      closed++;
    }
    return closed;
  },
});

// ---------- retention ----------

// How long a finished run stays readable. The UI shows the last ten and the
// value of an older one is forensic, so this is generous; what it rules out is
// a table that grows by (connections × triggers) a day forever, which is a
// cost and a scan the app gets nothing back for.
const RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// An OAuth state is consumed by the callback that redeems it, and expires
// after fifteen minutes (OAUTH_STATE_TTL_MS in notion.ts). A row still here an
// hour later belongs to a flow the user abandoned, and is dead weight the
// account-deletion scan has to page through.
const OAUTH_STATE_RETENTION_MS = 60 * 60 * 1000;

// How long a balance-snapshot page id is worth keeping.
//
// Its key is `${accountId}|${YYYY-MM-DD}` and the only date a sync ever looks
// up is today's, so a row for a past day is never read again — it exists only
// to stop the same day being written twice. The window is generous because
// the cost of being wrong is a duplicate row in Balance History, and days
// this old have long since settled.
const BALANCE_SNAPSHOT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

// How long an access-password attempt record outlives its last attempt. Also
// the ban duration — see ACCESS_BAN_MS in access.ts, which is what actually
// enforces it; this only clears the row afterwards.
const ACCESS_ATTEMPT_RETENTION_MS = 24 * 60 * 60 * 1000;

// Rows one retention pass deletes, per table. Bounded so the daily sweep stays
// inside one transaction; a backlog drains over consecutive days.
const RETENTION_BATCH = 500;

// Delete finished sync runs and abandoned OAuth states that are past their
// retention window. Both tables are append-only in normal operation, so
// without this they only ever grow.
//
// Creation time is the cursor, which is what keeps the read bounded: taking
// the oldest RETENTION_BATCH rows under the cutoff never scans the live ones.
// A run still saying "running" is left alone whatever its age — that is
// sweepStuckRuns' call to make, and it runs first.
export const pruneHistory = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    const runs = await ctx.db
      .query("syncRuns")
      .withIndex("by_creation_time", (q) =>
        q.lt("_creationTime", now - RUN_RETENTION_MS),
      )
      .take(RETENTION_BATCH);
    let deletedRuns = 0;
    for (const run of runs) {
      if (run.status === "running") {
        continue;
      }
      await ctx.db.delete(run._id);
      deletedRuns++;
    }

    const states = await ctx.db
      .query("notionOauthStates")
      .withIndex("by_creation_time", (q) =>
        q.lt("_creationTime", now - OAUTH_STATE_RETENTION_MS),
      )
      .take(RETENTION_BATCH);
    for (const state of states) {
      await ctx.db.delete(state._id);
    }

    // Balance-snapshot page ids for days gone by. This is the only kind in
    // notionPageMap that grows forever with nothing left to read it: a
    // transaction's id may come back from Plaid at any time, but a snapshot
    // key names a date, and a sync only ever asks about today.
    const snapshots = await ctx.db
      .query("notionPageMap")
      .withIndex("by_kind", (q) =>
        q
          .eq("kind", "balanceSnapshot")
          .lt("_creationTime", now - BALANCE_SNAPSHOT_RETENTION_MS),
      )
      .take(RETENTION_BATCH);
    for (const snapshot of snapshots) {
      await ctx.db.delete(snapshot._id);
    }

    // Attempt records that have been quiet for a day. Deleting one both frees
    // the row and lifts its ban, which is the point: a ban that only a
    // dashboard visit can lift is a way to lock yourself out of your own app
    // from a hotel network.
    const attempts = await ctx.db
      .query("accessAttempts")
      .withIndex("by_creation_time", (q) =>
        q.lt("_creationTime", now - ACCESS_ATTEMPT_RETENTION_MS),
      )
      .take(RETENTION_BATCH);
    let deletedAttempts = 0;
    for (const attempt of attempts) {
      // Creation time only says when the IP first showed up; a row still
      // being tried against is one to keep.
      if (now - attempt.lastAttemptAt < ACCESS_ATTEMPT_RETENTION_MS) {
        continue;
      }
      await ctx.db.delete(attempt._id);
      deletedAttempts++;
    }

    return {
      runs: deletedRuns,
      oauthStates: states.length,
      balanceSnapshots: snapshots.length,
      accessAttempts: deletedAttempts,
    };
  },
});

// ---------- daily cron sweep ----------

// Connections one sweep pass schedules. The sweep is the one place that walks
// every user's connections, so it cannot read the table in one go — a pass
// takes a batch and hands the rest to a continuation.
const SWEEP_BATCH = 100;

export const sweep = internalMutation({
  args: {
    // Continuation cursor: schedule connections created after this time.
    // Absent on the first pass, which is also the one that closes out stale
    // runs. Creation time orders the built-in index, so a pass that resumes
    // from the last row it saw cannot revisit or skip one.
    after: v.optional(v.number()),
    // Carried across passes so the stagger keeps counting up instead of
    // restarting at zero and firing a hundred runs at once.
    delayMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (args.after === undefined) {
      // Subtransactions: a failure in either housekeeping step rolls back on
      // its own and still leaves the day's syncs scheduled. Stale runs are
      // closed out before history is pruned, so a run this sweep just failed
      // is never also a run it deletes.
      try {
        await ctx.runMutation(internal.syncData.sweepStuckRuns, {});
      } catch (error) {
        console.error("stuck run sweep failed", error);
      }
      try {
        await ctx.runMutation(internal.syncData.pruneHistory, {});
      } catch (error) {
        console.error("history prune failed", error);
      }
    }
    const connections = await ctx.db
      .query("bankConnections")
      .withIndex("by_creation_time", (q) =>
        q.gt("_creationTime", args.after ?? 0),
      )
      .take(SWEEP_BATCH);
    let delay = args.delayMs ?? 0;
    for (const connection of connections) {
      if (connection.status === "error") {
        // Syncing a broken Item only produces Plaid errors, but its Notion
        // row still has to say so — a status the app knows and Notion does
        // not is how a bank stays broken unnoticed for weeks.
        await ctx.scheduler.runAfter(
          delay,
          internal.sync.pushConnectionStatusToNotion,
          { connectionId: connection._id },
        );
        delay += 2 * 1000;
        continue;
      }
      await ctx.scheduler.runAfter(delay, internal.sync.runForConnection, {
        connectionId: connection._id,
        trigger: "cron",
      });
      // Space runs out to be gentle on Plaid/Notion rate limits.
      delay += 15 * 1000;
    }
    if (connections.length === SWEEP_BATCH) {
      await ctx.scheduler.runAfter(0, internal.syncData.sweep, {
        after: connections[connections.length - 1]._creationTime,
        delayMs: delay,
      });
    }
  },
});

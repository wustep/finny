import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery } from "./_generated/server";

const kindValidator = v.union(
  v.literal("bankConnection"),
  v.literal("account"),
  v.literal("transaction"),
  v.literal("security"),
  v.literal("holding"),
  v.literal("investmentTransaction"),
  v.literal("category"),
  v.literal("balanceSnapshot"),
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
      },
    });
  },
});

export const finishRun = internalMutation({
  args: {
    runId: v.id("syncRuns"),
    status: v.union(v.literal("success"), v.literal("error")),
    error: v.optional(v.string()),
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
      await ctx.db.patch(run.connectionId, {
        lastSyncedAt: Date.now(),
        status: "active",
        errorCode: undefined,
      });
    }
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

export const getAllMapEntries = internalQuery({
  args: { userId: v.id("users"), kind: kindValidator },
  handler: async (ctx, args) => {
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

// A claim whose owner never came back is up for grabs again. Only one Notion
// create sits between claim and finish, so this just has to outlast a slow
// API call and its retries.
const CLAIM_TIMEOUT_MS = 60_000;

// Reserve the right to create the Notion page for a mapped key.
//
// Keys scoped to the user rather than to one connection — categories, and
// securities — are reachable from several connections' syncs at once, and a
// plain read-then-create let two overlapping runs each create a page for the
// same key. Mutations are serializable, so exactly one caller comes away with
// "create"; the rest get "pending" and wait for it to land.
export const claimMapEntry = internalMutation({
  args: {
    userId: v.id("users"),
    kind: kindValidator,
    providerId: v.string(),
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
      return { status: "create" as const };
    }
    await ctx.db.insert("notionPageMap", {
      userId: args.userId,
      kind: args.kind,
      providerId: args.providerId,
      notionPageId: "",
      claimedAt: Date.now(),
    });
    return { status: "create" as const };
  },
});

export const putMapEntries = internalMutation({
  args: {
    userId: v.id("users"),
    kind: kindValidator,
    entries: v.array(
      v.object({ providerId: v.string(), notionPageId: v.string() }),
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
        if (existing.notionPageId !== entry.notionPageId) {
          await ctx.db.patch(existing._id, {
            notionPageId: entry.notionPageId,
          });
        }
      } else {
        await ctx.db.insert("notionPageMap", {
          userId: args.userId,
          kind: args.kind,
          providerId: entry.providerId,
          notionPageId: entry.notionPageId,
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
    const entry = await ctx.db
      .query("notionPageMap")
      .withIndex("by_user_kind_provider", (q) =>
        q
          .eq("userId", args.userId)
          .eq("kind", args.kind)
          .eq("providerId", args.fromProviderId),
      )
      .unique();
    if (entry) {
      await ctx.db.patch(entry._id, { providerId: args.toProviderId });
    }
  },
});

// ---------- daily cron sweep ----------

export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const connections = await ctx.db.query("bankConnections").collect();
    let delay = 0;
    for (const connection of connections) {
      if (connection.status === "error") {
        continue;
      }
      await ctx.scheduler.runAfter(delay, internal.sync.runForConnection, {
        connectionId: connection._id,
        trigger: "cron",
      });
      // Space runs out to be gentle on Plaid/Notion rate limits.
      delay += 15 * 1000;
    }
  },
});

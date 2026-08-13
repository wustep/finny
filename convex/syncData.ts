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

export const createRun = internalMutation({
  args: {
    userId: v.id("users"),
    connectionId: v.id("bankConnections"),
    trigger: v.union(
      v.literal("initial"),
      v.literal("webhook"),
      v.literal("manual"),
      v.literal("cron"),
    ),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("syncRuns", {
      userId: args.userId,
      connectionId: args.connectionId,
      trigger: args.trigger,
      status: "running",
      startedAt: Date.now(),
      stats: { added: 0, modified: 0, removed: 0 },
    });
  },
});

export const hasRecentRunningRun = internalQuery({
  args: { connectionId: v.id("bankConnections") },
  handler: async (ctx, args) => {
    const runs = await ctx.db
      .query("syncRuns")
      .withIndex("by_connection", (q) => q.eq("connectionId", args.connectionId))
      .order("desc")
      .take(3);
    const cutoff = Date.now() - 5 * 60 * 1000;
    return runs.some(
      (run) => run.status === "running" && run.startedAt > cutoff,
    );
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
    if (args.status === "success" && run.connectionId) {
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
      if (entry) {
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
      entries.map((entry) => [entry.providerId, entry.notionPageId]),
    );
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

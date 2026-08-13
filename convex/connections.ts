import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";

// Bank connections + their accounts for the Accounts page.
// Access tokens never leave the server.
export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return [];
    }
    const connections = await ctx.db
      .query("bankConnections")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return Promise.all(
      connections.map(async (connection) => {
        const accounts = await ctx.db
          .query("accounts")
          .withIndex("by_connection", (q) =>
            q.eq("connectionId", connection._id),
          )
          .collect();
        return {
          id: connection._id,
          institutionName: connection.institutionName,
          institutionLogo: connection.institutionLogo,
          status: connection.status,
          errorCode: connection.errorCode,
          lastSyncedAt: connection.lastSyncedAt,
          accounts: accounts.map((account) => ({
            id: account._id,
            name: account.name,
            mask: account.mask,
            type: account.type,
            subtype: account.subtype,
            syncEnabled: account.syncEnabled,
          })),
        };
      }),
    );
  },
});

export const toggleAccountSync = mutation({
  args: { accountId: v.id("accounts"), enabled: v.boolean() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not signed in");
    }
    const account = await ctx.db.get(args.accountId);
    if (!account || account.userId !== userId) {
      throw new Error("Account not found");
    }
    await ctx.db.patch(args.accountId, { syncEnabled: args.enabled });
  },
});

export const getInternal = internalQuery({
  args: { connectionId: v.id("bankConnections") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.connectionId);
  },
});

export const getByItemInternal = internalQuery({
  args: { plaidItemId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("bankConnections")
      .withIndex("by_plaid_item", (q) => q.eq("plaidItemId", args.plaidItemId))
      .unique();
  },
});

export const listByUserInternal = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("bankConnections")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
  },
});

// Recent sync runs for the UI.
export const recentRuns = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return [];
    }
    const runs = await ctx.db
      .query("syncRuns")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(10);
    return Promise.all(
      runs.map(async (run) => {
        const connection = run.connectionId
          ? await ctx.db.get(run.connectionId)
          : null;
        return {
          id: run._id,
          institutionName: connection?.institutionName ?? "Unknown",
          trigger: run.trigger,
          status: run.status,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          stats: run.stats,
          error: run.error,
        };
      }),
    );
  },
});

// Insert or update (reconnect / re-link) a connection and its accounts.
export const saveConnection = internalMutation({
  args: {
    userId: v.id("users"),
    plaidItemId: v.string(),
    accessToken: v.string(),
    institutionId: v.optional(v.string()),
    institutionName: v.string(),
    institutionLogo: v.optional(v.string()),
    accounts: v.array(
      v.object({
        plaidAccountId: v.string(),
        name: v.string(),
        officialName: v.optional(v.string()),
        mask: v.optional(v.string()),
        type: v.string(),
        subtype: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("bankConnections")
      .withIndex("by_plaid_item", (q) => q.eq("plaidItemId", args.plaidItemId))
      .unique();

    let connectionId;
    if (existing) {
      if (existing.userId !== args.userId) {
        throw new Error("Item belongs to a different user");
      }
      await ctx.db.patch(existing._id, {
        accessToken: args.accessToken,
        institutionId: args.institutionId,
        institutionName: args.institutionName,
        institutionLogo: args.institutionLogo,
        status: "active",
        errorCode: undefined,
      });
      connectionId = existing._id;
    } else {
      connectionId = await ctx.db.insert("bankConnections", {
        userId: args.userId,
        plaidItemId: args.plaidItemId,
        accessToken: args.accessToken,
        institutionId: args.institutionId,
        institutionName: args.institutionName,
        institutionLogo: args.institutionLogo,
        status: "active",
      });
    }

    for (const account of args.accounts) {
      const existingAccount = await ctx.db
        .query("accounts")
        .withIndex("by_plaid_account", (q) =>
          q.eq("plaidAccountId", account.plaidAccountId),
        )
        .unique();
      if (existingAccount) {
        await ctx.db.patch(existingAccount._id, {
          name: account.name,
          officialName: account.officialName,
          mask: account.mask,
          type: account.type,
          subtype: account.subtype,
        });
      } else {
        await ctx.db.insert("accounts", {
          userId: args.userId,
          connectionId,
          syncEnabled: true,
          ...account,
        });
      }
    }
    return connectionId;
  },
});

export const setStatusByItem = internalMutation({
  args: {
    plaidItemId: v.string(),
    status: v.union(
      v.literal("active"),
      v.literal("error"),
      v.literal("pending_expiration"),
    ),
    errorCode: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const connection = await ctx.db
      .query("bankConnections")
      .withIndex("by_plaid_item", (q) => q.eq("plaidItemId", args.plaidItemId))
      .unique();
    if (connection) {
      await ctx.db.patch(connection._id, {
        status: args.status,
        errorCode: args.errorCode,
      });
    }
  },
});

export const deleteCascade = internalMutation({
  args: { connectionId: v.id("bankConnections") },
  handler: async (ctx, args) => {
    const accounts = await ctx.db
      .query("accounts")
      .withIndex("by_connection", (q) => q.eq("connectionId", args.connectionId))
      .collect();
    for (const account of accounts) {
      await ctx.db.delete(account._id);
    }
    await ctx.db.delete(args.connectionId);
    // Notion pages created by past syncs are left in place, matching [redacted]:
    // the destination stops updating but keeps its data.
  },
});

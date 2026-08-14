import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { P, accountTitle, updatePage } from "./notionApi";

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
            name: account.customName ?? account.name,
            originalName: account.name,
            customName: account.customName,
            mask: account.mask,
            type: account.type,
            subtype: account.subtype,
            syncEnabled: account.syncEnabled,
            isNew: account.discoveredAt !== undefined,
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
    await ctx.db.patch(args.accountId, {
      syncEnabled: args.enabled,
      // Either answer to "do you want this one?" retires the new badge.
      discoveredAt: undefined,
    });
  },
});

// Accounts a sync found at Plaid that this app has no row for yet. New ones
// arrive disabled: the user picked what to sync when they linked the bank,
// and an account added afterwards is not covered by that choice. Existing
// rows keep their syncEnabled and only take fresh metadata.
export const upsertPlaidAccounts = internalMutation({
  args: {
    connectionId: v.id("bankConnections"),
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
    const connection = await ctx.db.get(args.connectionId);
    if (!connection) {
      return { discovered: 0 };
    }
    const existing = await ctx.db
      .query("accounts")
      .withIndex("by_connection", (q) => q.eq("connectionId", args.connectionId))
      .collect();
    const byPlaidId = new Map(
      existing.map((account) => [account.plaidAccountId, account]),
    );

    let discovered = 0;
    for (const account of args.accounts) {
      const row = byPlaidId.get(account.plaidAccountId);
      if (row) {
        await ctx.db.patch(row._id, {
          name: account.name,
          officialName: account.officialName,
          mask: account.mask,
          type: account.type,
          subtype: account.subtype,
        });
        continue;
      }
      await ctx.db.insert("accounts", {
        userId: connection.userId,
        connectionId: args.connectionId,
        syncEnabled: false,
        discoveredAt: Date.now(),
        ...account,
      });
      discovered++;
    }
    return { discovered };
  },
});

// Link update mode fixes the credentials at Plaid and hands nothing back to
// exchange, so the app only learns the Item works again by being told. Clear
// the error and sync, or the card keeps saying "needs attention" until the
// next webhook happens to arrive.
export const markReconnected = mutation({
  args: { connectionId: v.id("bankConnections") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not signed in");
    }
    const user = await ctx.db.get(userId);
    if (user?.accessGrantedAt === undefined) {
      throw new Error("Access password required");
    }
    const connection = await ctx.db.get(args.connectionId);
    if (!connection || connection.userId !== userId) {
      throw new Error("Connection not found");
    }
    await ctx.db.patch(args.connectionId, {
      status: "active",
      errorCode: undefined,
    });
    await ctx.scheduler.runAfter(0, internal.sync.runForConnection, {
      connectionId: args.connectionId,
      trigger: "manual",
    });
    // The sync writes the status too, but it may find nothing to do (no
    // Notion destination yet, another run holding the lease) and the Notion
    // row would stay on "Error" after a repair that worked.
    await ctx.scheduler.runAfter(
      0,
      internal.sync.pushConnectionStatusToNotion,
      { connectionId: args.connectionId },
    );
  },
});

// Rename an account. Writes the new title straight to the Notion Accounts
// row so the change shows up without waiting for the next sync; subsequent
// syncs keep using it (see accountTitle in notionApi.ts).
export const renameAccount = action({
  args: {
    accountId: v.id("accounts"),
    name: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
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

    // Empty name clears the override and reverts to the derived title.
    const customName = args.name.trim().slice(0, 200) || undefined;
    const account = await ctx.runMutation(
      internal.connections.setAccountName,
      { userId, accountId: args.accountId, customName },
    );

    const notion = await ctx.runQuery(internal.notion.getConnectionInternal, {
      userId,
    });
    if (!notion?.databases?.accounts) {
      return;
    }
    const pages = await ctx.runQuery(internal.syncData.getMapEntries, {
      userId,
      kind: "account",
      providerIds: [account.plaidAccountId],
    });
    const pageId = pages[account.plaidAccountId];
    if (!pageId) {
      // Not synced to Notion yet; the next sync will use the new name.
      return;
    }
    await updatePage(notion.accessToken, pageId, {
      "Account Name": P.title(
        accountTitle(
          account.institutionName,
          {
            name: account.name,
            official_name: account.officialName,
            mask: account.mask,
          },
          customName,
        ),
      ),
    });
  },
});

export const setAccountName = internalMutation({
  args: {
    userId: v.id("users"),
    accountId: v.id("accounts"),
    customName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account || account.userId !== args.userId) {
      throw new Error("Account not found");
    }
    await ctx.db.patch(args.accountId, { customName: args.customName });
    const connection = await ctx.db.get(account.connectionId);
    return {
      plaidAccountId: account.plaidAccountId,
      name: account.name,
      officialName: account.officialName,
      mask: account.mask,
      institutionName: connection?.institutionName ?? "Bank",
    };
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

export const setNotionIconFileUpload = internalMutation({
  args: {
    connectionId: v.id("bankConnections"),
    fileUploadId: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.connectionId, {
      notionIconFileUploadId: args.fileUploadId,
    });
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
    plaidEnv: v.optional(
      v.union(v.literal("sandbox"), v.literal("production")),
    ),
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
        // A different logo means the uploaded copy no longer matches.
        notionIconFileUploadId:
          existing.institutionLogo === args.institutionLogo
            ? existing.notionIconFileUploadId
            : undefined,
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
        plaidEnv: args.plaidEnv,
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

import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { DATABASE_SPECS, MODULE_DATABASES } from "./notionSchemas";
import { allowedOrigins } from "./origins";

const NOTION_VERSION = "2022-06-28";
const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

function redirectUri() {
  return `${process.env.CONVEX_SITE_URL}/notion/oauth/callback`;
}

// Notion-writing actions are gated behind the access password.
async function requireAccess(
  ctx: { runQuery: (ref: any, args: any) => Promise<any> },
  userId: string,
): Promise<void> {
  const ok = await ctx.runQuery(internal.access.hasAccessInternal, { userId });
  if (!ok) {
    throw new Error("Access password required");
  }
}

async function notionFetch(
  token: string,
  path: string,
  init?: { method?: string; body?: unknown },
) {
  const response = await fetch(`https://api.notion.com/v1${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data: any = await response.json();
  if (!response.ok) {
    throw new Error(
      `Notion API ${path} failed (${response.status}): ${data?.message ?? "unknown"}`,
    );
  }
  return data;
}

// ---------- status / config ----------

export const getStatus = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return null;
    }
    const connection = await ctx.db
      .query("notionConnections")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (!connection) {
      return { connected: false as const };
    }
    return {
      connected: true as const,
      workspaceName: connection.workspaceName,
      workspaceIcon: connection.workspaceIcon,
      parentPageId: connection.parentPageId,
      modules: connection.modules,
      startDate: connection.startDate,
      databases: connection.databases,
    };
  },
});

export const disconnect = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not signed in");
    }
    const connection = await ctx.db
      .query("notionConnections")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (connection) {
      await ctx.db.delete(connection._id);
    }
  },
});

// ---------- OAuth ----------

export const startOAuth = action({
  args: { origin: v.optional(v.string()) },
  handler: async (ctx, args): Promise<string> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not signed in");
    }
    await requireAccess(ctx, userId);
    const clientId = process.env.NOTION_CLIENT_ID;
    if (!clientId) {
      throw new Error("NOTION_CLIENT_ID not set — see SETUP.md");
    }
    const origin =
      args.origin && allowedOrigins().includes(args.origin)
        ? args.origin
        : undefined;
    const state = crypto.randomUUID();
    await ctx.runMutation(internal.notion.saveOauthState, {
      userId,
      state,
      origin,
    });
    const url = new URL("https://api.notion.com/v1/oauth/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("owner", "user");
    url.searchParams.set("redirect_uri", redirectUri());
    url.searchParams.set("state", state);
    return url.toString();
  },
});

export const saveOauthState = internalMutation({
  args: {
    userId: v.id("users"),
    state: v.string(),
    origin: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("notionOauthStates", {
      userId: args.userId,
      state: args.state,
      createdAt: Date.now(),
      origin: args.origin,
    });
  },
});

export const consumeOauthState = internalMutation({
  args: { state: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("notionOauthStates")
      .withIndex("by_state", (q) => q.eq("state", args.state))
      .unique();
    if (!doc) {
      return null;
    }
    await ctx.db.delete(doc._id);
    if (Date.now() - doc.createdAt > OAUTH_STATE_TTL_MS) {
      return null;
    }
    return { userId: doc.userId, origin: doc.origin };
  },
});

// Exchange the OAuth code and store the workspace connection.
// Called from the /notion/oauth/callback http action.
export const completeOAuth = internalAction({
  args: { code: v.string(), state: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const consumed = await ctx.runMutation(internal.notion.consumeOauthState, {
      state: args.state,
    });
    if (!consumed) {
      throw new Error("Invalid or expired OAuth state");
    }
    const { userId, origin } = consumed;
    const clientId = process.env.NOTION_CLIENT_ID;
    const clientSecret = process.env.NOTION_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error("Notion OAuth env vars not set");
    }
    const response = await fetch("https://api.notion.com/v1/oauth/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code: args.code,
        redirect_uri: redirectUri(),
      }),
    });
    const data: any = await response.json();
    if (!response.ok) {
      throw new Error(
        `Notion token exchange failed: ${data?.error ?? response.status}`,
      );
    }
    await ctx.runMutation(internal.notion.saveConnection, {
      userId,
      accessToken: data.access_token,
      workspaceId: data.workspace_id,
      workspaceName: data.workspace_name ?? undefined,
      workspaceIcon: data.workspace_icon ?? undefined,
      botId: data.bot_id,
    });
    return origin ?? null;
  },
});

export const saveConnection = internalMutation({
  args: {
    userId: v.id("users"),
    accessToken: v.string(),
    workspaceId: v.string(),
    workspaceName: v.optional(v.string()),
    workspaceIcon: v.optional(v.string()),
    botId: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("notionConnections")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (existing) {
      const sameWorkspace = existing.workspaceId === args.workspaceId;
      await ctx.db.patch(existing._id, {
        accessToken: args.accessToken,
        workspaceId: args.workspaceId,
        workspaceName: args.workspaceName,
        workspaceIcon: args.workspaceIcon,
        botId: args.botId,
        // Databases from another workspace are unreachable with this token.
        ...(sameWorkspace
          ? {}
          : { parentPageId: undefined, databases: undefined }),
      });
    } else {
      await ctx.db.insert("notionConnections", {
        userId: args.userId,
        accessToken: args.accessToken,
        workspaceId: args.workspaceId,
        workspaceName: args.workspaceName,
        workspaceIcon: args.workspaceIcon,
        botId: args.botId,
        modules: { balances: true, spending: true, investments: true },
      });
    }
  },
});

export const getConnectionInternal = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("notionConnections")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
  },
});

// ---------- setup: page picker + database creation ----------

export const listPages = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<Array<{ id: string; title: string; icon: string | null }>> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not signed in");
    }
    await requireAccess(ctx, userId);
    const connection = await ctx.runQuery(
      internal.notion.getConnectionInternal,
      { userId },
    );
    if (!connection) {
      throw new Error("Notion not connected");
    }
    const data = await notionFetch(connection.accessToken, "/search", {
      method: "POST",
      body: {
        filter: { value: "page", property: "object" },
        page_size: 100,
      },
    });
    return (data.results as any[])
      .filter((page) => !page.archived)
      .map((page) => {
        const titleProp = Object.values(page.properties ?? {}).find(
          (prop: any) => prop.type === "title",
        ) as any;
        const title =
          titleProp?.title?.map((t: any) => t.plain_text).join("") ??
          "Untitled";
        return {
          id: page.id as string,
          title: title || "Untitled",
          icon: page.icon?.type === "emoji" ? (page.icon.emoji as string) : null,
        };
      });
  },
});

export const createDatabases = action({
  args: {
    parentPageId: v.string(),
    modules: v.object({
      balances: v.boolean(),
      spending: v.boolean(),
      investments: v.boolean(),
    }),
    startDate: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not signed in");
    }
    await requireAccess(ctx, userId);
    const connection = await ctx.runQuery(
      internal.notion.getConnectionInternal,
      { userId },
    );
    if (!connection) {
      throw new Error("Notion not connected");
    }

    const wanted = new Set(MODULE_DATABASES.base);
    if (args.modules.balances) {
      MODULE_DATABASES.balances.forEach((key) => wanted.add(key));
    }
    if (args.modules.spending) {
      MODULE_DATABASES.spending.forEach((key) => wanted.add(key));
    }
    if (args.modules.investments) {
      MODULE_DATABASES.investments.forEach((key) => wanted.add(key));
    }

    // Reuse databases from a previous run so re-running setup is idempotent.
    const created: Record<string, string> = { ...connection.databases };
    try {
      for (const spec of DATABASE_SPECS) {
        if (!wanted.has(spec.key) || created[spec.key]) {
          continue;
        }
        const create = (properties: Record<string, unknown>) =>
          notionFetch(connection.accessToken, "/databases", {
            method: "POST",
            body: {
              parent: { type: "page_id", page_id: args.parentPageId },
              icon: { type: "emoji", emoji: spec.emoji },
              title: [{ type: "text", text: { content: spec.title } }],
              properties,
            },
          });
        const properties = spec.properties(created);
        let data;
        try {
          data = await create(properties);
        } catch (error) {
          // The Holdings rollup+formula combo is the one schema Notion might
          // reject in a single create call; retry without it rather than
          // failing the whole setup.
          if (spec.key !== "holdings") {
            throw error;
          }
          console.error("holdings formula rejected, retrying without", error);
          const { "Security Price": _rollup, "Market Value": _formula, ...rest } =
            properties as Record<string, unknown>;
          data = await create(rest);
        }
        created[spec.key] = data.id as string;
      }
    } finally {
      // Persist progress even on failure so a retry doesn't duplicate DBs.
      await ctx.runMutation(internal.notion.saveDatabases, {
        userId,
        parentPageId: args.parentPageId,
        modules: args.modules,
        startDate: args.startDate,
        databases: created,
      });
    }

    // Kick off the initial backfill for every connected bank.
    const connections = await ctx.runQuery(
      internal.connections.listByUserInternal,
      { userId },
    );
    let delay = 0;
    for (const connection of connections) {
      await ctx.scheduler.runAfter(delay, internal.sync.runForConnection, {
        connectionId: connection._id,
        trigger: "initial",
      });
      delay += 10 * 1000;
    }
    return created;
  },
});

export const saveDatabases = internalMutation({
  args: {
    userId: v.id("users"),
    parentPageId: v.string(),
    modules: v.object({
      balances: v.boolean(),
      spending: v.boolean(),
      investments: v.boolean(),
    }),
    startDate: v.string(),
    databases: v.record(v.string(), v.string()),
  },
  handler: async (ctx, args) => {
    const connection = await ctx.db
      .query("notionConnections")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (!connection) {
      throw new Error("Notion not connected");
    }
    await ctx.db.patch(connection._id, {
      parentPageId: args.parentPageId,
      modules: args.modules,
      startDate: args.startDate,
      databases: args.databases,
    });
  },
});

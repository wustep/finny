import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
} from "./_generated/server";
import { DATABASE_SPECS, MODULE_DATABASES } from "./notionSchemas";
import { allowedOrigins } from "./origins";

const NOTION_VERSION = "2022-06-28";
const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

const modulesValidator = v.object({
  balances: v.boolean(),
  spending: v.boolean(),
  investments: v.boolean(),
});

type Modules = { balances: boolean; spending: boolean; investments: boolean };

const MODULE_KEYS = ["balances", "spending", "investments"] as const;

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
      // The client compares this across a reconnect: landing in a different
      // workspace is what clears the database map (see saveConnection).
      workspaceId: connection.workspaceId,
      workspaceName: connection.workspaceName,
      workspaceIcon: connection.workspaceIcon,
      parentPageId: connection.parentPageId,
      modules: connection.modules,
      startDate: connection.startDate,
      databases: connection.databases,
    };
  },
});

// Is the stored token still good? A revoked or expired Notion integration
// otherwise only shows up as every sync failing.
//
// This reports instead of throwing so the caller can tell "reauthorise" from
// "Notion is down". It hits the Notion API on every call, so it is a one-shot
// action the destination page runs on load and on demand — never a reactive
// query.
export const checkHealth = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<
    | { state: "disconnected" }
    | { state: "ok" }
    | { state: "unauthorized"; message: string }
    | { state: "unknown"; message: string }
  > => {
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
      return { state: "disconnected" };
    }
    let response: Response;
    try {
      response = await fetch("https://api.notion.com/v1/users/me", {
        headers: {
          Authorization: `Bearer ${connection.accessToken}`,
          "Notion-Version": NOTION_VERSION,
        },
      });
    } catch (error) {
      return { state: "unknown", message: String(error) };
    }
    if (response.ok) {
      return { state: "ok" };
    }
    const data: any = await response.json().catch(() => ({}));
    const message = data?.message ?? `Notion returned ${response.status}`;
    // 401 is a revoked or expired token; 403 is a token that no longer has
    // the access it was granted. Both are fixed by reauthorising.
    if (response.status === 401 || response.status === 403) {
      return { state: "unauthorized", message };
    }
    return { state: "unknown", message };
  },
});

// Forget the workspace entirely: the token and the database map go, the
// pages in Notion stay. Only the map going is what makes a later connect
// create a second set of databases — reconnecting through startOAuth without
// disconnecting keeps it (see saveConnection).
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
      throw new Error("NOTION_CLIENT_ID not set — see README.md");
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

// Which logical databases the enabled modules need. Bank Connections and
// Accounts are always in, whatever is on.
function wantedDatabases(modules: Modules): Set<string> {
  const wanted = new Set(MODULE_DATABASES.base);
  for (const key of MODULE_KEYS) {
    if (modules[key]) {
      MODULE_DATABASES[key].forEach((database) => wanted.add(database));
    }
  }
  return wanted;
}

// Create the databases the enabled modules need and the row does not already
// have, and record the result. Reusing existing ids is what makes this safe
// to call more than once — from a retried setup, or from switching a module
// on months later.
async function ensureDatabases(
  ctx: ActionCtx,
  input: {
    userId: Id<"users">;
    token: string;
    parentPageId: string;
    modules: Modules;
    startDate?: string;
    existing?: Record<string, string>;
  },
): Promise<Record<string, string>> {
  const wanted = wantedDatabases(input.modules);
  const created: Record<string, string> = { ...input.existing };
  try {
    for (const spec of DATABASE_SPECS) {
      if (!wanted.has(spec.key) || created[spec.key]) {
        continue;
      }
      const data = await notionFetch(input.token, "/databases", {
        method: "POST",
        body: {
          parent: { type: "page_id", page_id: input.parentPageId },
          icon: { type: "emoji", emoji: spec.emoji },
          title: [{ type: "text", text: { content: spec.title } }],
          // Relations point at ids created earlier in this same pass; every
          // spec's dependencies come before it in DATABASE_SPECS.
          properties: spec.properties(created),
        },
      });
      created[spec.key] = data.id as string;
    }
  } finally {
    // Persist progress even on failure so a retry doesn't duplicate DBs.
    await ctx.runMutation(internal.notion.saveDatabases, {
      userId: input.userId,
      parentPageId: input.parentPageId,
      modules: input.modules,
      startDate: input.startDate,
      databases: created,
    });
  }
  return created;
}

// Sync every connected bank into the databases as they now stand. Spaced out
// because a run is a long conversation with Plaid and Notion.
async function scheduleSyncs(
  ctx: ActionCtx,
  userId: Id<"users">,
  trigger: "initial" | "manual",
): Promise<number> {
  const connections = await ctx.runQuery(
    internal.connections.listByUserInternal,
    { userId },
  );
  let delay = 0;
  for (const connection of connections) {
    await ctx.scheduler.runAfter(delay, internal.sync.runForConnection, {
      connectionId: connection._id,
      trigger,
    });
    delay += 10 * 1000;
  }
  return connections.length;
}

export const createDatabases = action({
  args: {
    parentPageId: v.string(),
    modules: modulesValidator,
    startDate: v.string(),
  },
  handler: async (ctx, args): Promise<Record<string, string>> => {
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

    const created = await ensureDatabases(ctx, {
      userId,
      token: connection.accessToken,
      parentPageId: args.parentPageId,
      modules: args.modules,
      startDate: args.startDate,
      existing: connection.databases,
    });
    // Kick off the initial backfill for every connected bank.
    await scheduleSyncs(ctx, userId, "initial");
    return created;
  },
});

// Turn a tracking module on or off after setup.
//
// Enabling creates only the databases that module needs and are missing, then
// syncs every bank so they start out filled. Disabling only stops writing:
// the databases and everything already in them stay in Notion, which is the
// difference between a user changing their mind and losing their history.
export const setModules = action({
  args: { modules: modulesValidator },
  handler: async (ctx, args): Promise<Record<string, string>> => {
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
    if (!connection.parentPageId || !connection.databases) {
      throw new Error("Set up the Notion destination first");
    }
    const enabled = MODULE_KEYS.some(
      (key) => args.modules[key] && !connection.modules[key],
    );
    const databases = await ensureDatabases(ctx, {
      userId,
      token: connection.accessToken,
      parentPageId: connection.parentPageId,
      modules: args.modules,
      startDate: connection.startDate,
      existing: connection.databases,
    });
    if (enabled) {
      // A database nothing has written to yet is an empty database.
      await scheduleSyncs(ctx, userId, "manual");
    }
    return databases;
  },
});

// Move how far back syncs reach.
//
// The date is only a filter on what a sync writes, so moving it earlier
// reaches further back only once the Plaid cursor is rewound — that is what
// `rebackfill` does, and the page map makes the replay update rows in place
// instead of duplicating them. Moving it later deliberately leaves what is
// already in Notion alone; later syncs simply stop adding older items.
export const setStartDate = mutation({
  args: { startDate: v.string(), rebackfill: v.boolean() },
  handler: async (ctx, args): Promise<{ connections: number }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not signed in");
    }
    await requireAccess(ctx, userId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.startDate)) {
      throw new Error("Expected a date as YYYY-MM-DD");
    }
    const connection = await ctx.db
      .query("notionConnections")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (!connection) {
      throw new Error("Notion not connected");
    }
    await ctx.db.patch(connection._id, { startDate: args.startDate });
    if (!args.rebackfill) {
      return { connections: 0 };
    }
    const connectionIds = await ctx.runMutation(
      internal.syncData.clearCursors,
      { userId },
    );
    let delay = 0;
    for (const connectionId of connectionIds) {
      await ctx.scheduler.runAfter(delay, internal.sync.runForConnection, {
        connectionId,
        trigger: "manual",
      });
      delay += 10 * 1000;
    }
    return { connections: connectionIds.length };
  },
});

export const saveDatabases = internalMutation({
  args: {
    userId: v.id("users"),
    parentPageId: v.string(),
    modules: modulesValidator,
    // Absent on a connection whose setup predates the start-date question.
    startDate: v.optional(v.string()),
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

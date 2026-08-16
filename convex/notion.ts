import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  action,
  env,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
} from "./_generated/server";
import { NOTION_VERSION, notionFetch } from "./notionApi";
import {
  DATABASE_SPECS,
  MAP_KINDS_BY_DATABASE,
  MODULE_DATABASES,
  NOTION_SCHEMA_VERSION,
  SPEC_BY_KEY,
  propertyTypes,
  relationDependencies,
} from "./notionSchemas";
import { allowedOrigins } from "./origins";
import {
  MAX_TEMPLATE_LENGTH,
  TITLE_FORMAT_BY_KEY,
  unknownFilters,
  unknownTokens,
} from "./titleFormats";

const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

const modulesValidator = v.object({
  balances: v.boolean(),
  spending: v.boolean(),
  investments: v.boolean(),
  recurring: v.optional(v.boolean()),
});

type Modules = {
  balances: boolean;
  spending: boolean;
  investments: boolean;
  recurring?: boolean;
};

const MODULE_KEYS = [
  "balances",
  "spending",
  "investments",
  "recurring",
] as const;

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
      titleFormats: connection.titleFormats,
      manualProperties: connection.manualProperties,
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
//
// The one call in this file that does not go through notionFetch: the status
// code is the answer here, and notionFetch's job is to turn a failure into a
// thrown Error after retrying it.
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
    const clientId = env.NOTION_CLIENT_ID;
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
    const clientId = env.NOTION_CLIENT_ID;
    const clientSecret = env.NOTION_CLIENT_SECRET;
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
        modules: {
          balances: true,
          spending: true,
          investments: true,
          // Off unless asked for: it is one more Plaid call per sync, and a
          // database nobody wanted is still a database in their page.
          recurring: false,
        },
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

// Pages one call walks before giving up. Notion pages its search at 100, and
// a workspace can share far more than that with an integration; the cap keeps
// a pathological workspace from turning the picker into a minute of requests.
const PAGE_SEARCH_LIMIT = 500;

export const listPages = action({
  args: {
    // Narrows the search at Notion rather than in the browser, which is the
    // only way to reach a page past the cap in a large workspace.
    query: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    pages: Array<{ id: string; title: string; icon: string | null }>;
    // True when Notion still had more to give. The picker says so rather than
    // quietly showing a subset.
    truncated: boolean;
  }> => {
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

    const pages: Array<{ id: string; title: string; icon: string | null }> = [];
    const search = args.query?.trim();
    let cursor: string | undefined;
    let truncated = false;

    do {
      const data = await notionFetch(connection.accessToken, "/search", {
        method: "POST",
        body: {
          ...(search ? { query: search } : {}),
          filter: { value: "page", property: "object" },
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        },
      });
      for (const page of data.results as any[]) {
        if (page.archived || page.in_trash) {
          continue;
        }
        const titleProp = Object.values(page.properties ?? {}).find(
          (prop: any) => prop.type === "title",
        ) as any;
        const title =
          titleProp?.title?.map((t: any) => t.plain_text).join("") ?? "Untitled";
        pages.push({
          id: page.id as string,
          title: title || "Untitled",
          icon:
            page.icon?.type === "emoji" ? (page.icon.emoji as string) : null,
        });
      }
      cursor = data.has_more ? (data.next_cursor as string) : undefined;
      if (cursor && pages.length >= PAGE_SEARCH_LIMIT) {
        truncated = true;
        break;
      }
    } while (cursor);

    return { pages, truncated };
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
    // Anything built from the current specs is current by construction.
    await ctx.runMutation(internal.notion.setSchemaVersion, {
      userId: input.userId,
      version: NOTION_SCHEMA_VERSION,
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

// Bring every database this destination has up to the properties the current
// build writes.
//
// Databases are only ever created, never altered, by ensureDatabases — so a
// property added to a spec (Accounts.Currency, Transactions.Tags) is simply
// absent from every destination built before it, and the sync then writes a
// column that is not there. Notion answers that with a 400 for the whole row,
// which fails the run rather than the column.
//
// Additive only: this adds properties, and never removes, renames or retypes
// one. Guarded by NOTION_SCHEMA_VERSION so it costs one integer comparison on
// a current destination rather than eight requests every sync.
export const ensureDatabaseColumns = internalAction({
  args: { userId: v.id("users") },
  handler: async (ctx, args): Promise<{ added: string[] }> => {
    const added: string[] = [];
    const connection = await ctx.runQuery(
      internal.notion.getConnectionInternal,
      { userId: args.userId },
    );
    if (!connection?.databases) {
      return { added };
    }
    const databases = connection.databases;

    for (const [key, databaseId] of Object.entries(databases)) {
      if (!SPEC_BY_KEY[key]) {
        continue;
      }
      const state = await inspectDatabase(
        connection.accessToken,
        key,
        databaseId,
      );
      if (state.state !== "damaged" || state.missingProperties.length === 0) {
        continue;
      }
      const definitions = SPEC_BY_KEY[key].properties(databases);
      const patch = Object.fromEntries(
        state.missingProperties
          .filter((name) => definitions[name])
          .map((name) => [name, definitions[name]]),
      );
      if (Object.keys(patch).length === 0) {
        continue;
      }
      await notionFetch(connection.accessToken, `/databases/${databaseId}`, {
        method: "PATCH",
        body: { properties: patch },
      });
      added.push(...Object.keys(patch).map((name) => `${key}.${name}`));
    }

    // Only once everything above worked. A failure part-way leaves the
    // version behind so the next run tries again, which is the difference
    // between a transient Notion error and a destination stuck a version back.
    await ctx.runMutation(internal.notion.setSchemaVersion, {
      userId: args.userId,
      version: NOTION_SCHEMA_VERSION,
    });
    if (added.length > 0) {
      console.log(`added ${added.join(", ")} to the Notion databases`);
    }
    return { added };
  },
});

export const setSchemaVersion = internalMutation({
  args: { userId: v.id("users"), version: v.number() },
  handler: async (ctx, args) => {
    const connection = await ctx.db
      .query("notionConnections")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (connection) {
      await ctx.db.patch(connection._id, { schemaVersion: args.version });
    }
  },
});

// ---------- destination integrity ----------

// What one of Finny's databases looks like from the outside right now.
//
// checkHealth asks whether the token still works. This asks the question after
// it: the token is fine, the sync is running, and every write fails anyway
// because a database was deleted or a column was renamed. That failure is
// invisible today — the run row carries a Notion error, the destination page
// says "healthy", and nothing says which database.
export type DatabaseState =
  // Present, with every property Finny writes.
  | { key: string; state: "ok" }
  // Gone from the workspace, or no longer shared with the integration.
  | { key: string; state: "missing" }
  // In the Notion trash. Restorable by hand, which is worth saying, because
  // rebuilding loses the rows and restoring does not.
  | { key: string; state: "trashed" }
  // There, but not as Finny left it.
  | {
      key: string;
      state: "damaged";
      // Properties Finny writes that are not there any more. A renamed column
      // is indistinguishable from a deleted one from here.
      missingProperties: string[];
      // Properties whose type was changed. Not repaired automatically:
      // changing a Notion property's type discards what was in it, and doing
      // that to a column the user deliberately converted would be worse than
      // the failing writes.
      wrongTypeProperties: Array<{ name: string; expected: string; actual: string }>;
    }
  // Notion could not be asked. Says nothing about the database either way.
  | { key: string; state: "unknown"; message: string };

async function inspectDatabase(
  token: string,
  key: string,
  databaseId: string,
): Promise<DatabaseState> {
  let data: any;
  try {
    data = await notionFetch(token, `/databases/${databaseId}`);
  } catch (error) {
    const message = String(error);
    if (message.includes("(404)")) {
      return { key, state: "missing" };
    }
    return { key, state: "unknown", message };
  }
  if (data?.archived || data?.in_trash) {
    return { key, state: "trashed" };
  }
  const spec = SPEC_BY_KEY[key];
  if (!spec) {
    // A database key this build does not know about. Not ours to judge.
    return { key, state: "ok" };
  }
  const actual: Record<string, { type?: string }> = data?.properties ?? {};
  const missingProperties: string[] = [];
  const wrongTypeProperties: Array<{
    name: string;
    expected: string;
    actual: string;
  }> = [];
  for (const [name, expected] of Object.entries(propertyTypes(spec))) {
    const found = actual[name];
    if (!found) {
      missingProperties.push(name);
    } else if (found.type && found.type !== expected) {
      wrongTypeProperties.push({ name, expected, actual: found.type });
    }
  }
  if (missingProperties.length === 0 && wrongTypeProperties.length === 0) {
    return { key, state: "ok" };
  }
  return { key, state: "damaged", missingProperties, wrongTypeProperties };
}

// The properties on a database that Finny did not put there.
//
// Everything in the spec is Finny's and gets overwritten on every sync; what
// is left is the user's, and is never touched — unless they point a rule at
// it, which is what this list exists to make possible.
function manualPropertiesOf(key: string, data: any): ManualProperty[] {
  const spec = SPEC_BY_KEY[key];
  const owned = new Set(spec ? Object.keys(propertyTypes(spec)) : []);
  return Object.entries((data?.properties ?? {}) as Record<string, any>)
    .filter(([name, property]) => !owned.has(name) && property?.type !== "title")
    .map(([name, property]) => ({
      name,
      type: String(property.type),
      options: (property[property.type]?.options as any[] | undefined)?.map(
        (option) => String(option.name),
      ),
    }));
}

export interface ManualProperty {
  name: string;
  type: string;
  options?: string[];
}

// Re-read which columns are the user's, so the Rules page can offer them and
// the destination page can show them.
//
// Cheap enough to run on every sync for the one database rules write to, and
// run for all of them by the destination check. A column added in Notion this
// morning is therefore usable in a rule this afternoon without anyone having
// to tell Finny about it.
export const refreshManualProperties = internalAction({
  args: { userId: v.id("users"), keys: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => {
    try {
      const connection = await ctx.runQuery(
        internal.notion.getConnectionInternal,
        { userId: args.userId },
      );
      if (!connection?.databases) {
        return;
      }
      const found: Record<string, ManualProperty[]> = {
        ...(connection.manualProperties ?? {}),
      };
      for (const [key, databaseId] of Object.entries(connection.databases)) {
        if (args.keys && !args.keys.includes(key)) {
          continue;
        }
        const data = await notionFetch(
          connection.accessToken,
          `/databases/${databaseId}`,
        );
        found[key] = manualPropertiesOf(key, data);
      }
      await ctx.runMutation(internal.notion.saveManualProperties, {
        userId: args.userId,
        manualProperties: found,
      });
    } catch (error) {
      // Knowing about someone's own columns is a convenience; a sync does not
      // fail because Notion would not list them.
      console.error("could not refresh manual properties", error);
    }
  },
});

export const saveManualProperties = internalMutation({
  args: {
    userId: v.id("users"),
    manualProperties: v.record(
      v.string(),
      v.array(
        v.object({
          name: v.string(),
          type: v.string(),
          options: v.optional(v.array(v.string())),
        }),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const connection = await ctx.db
      .query("notionConnections")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (connection) {
      await ctx.db.patch(connection._id, {
        manualProperties: args.manualProperties,
      });
    }
  },
});

// Ask Notion about every database Finny has recorded.
//
// One request each, so it is an action the destination page runs on demand
// rather than a reactive query.
export const checkDatabases = action({
  args: {},
  handler: async (ctx): Promise<DatabaseState[]> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not signed in");
    }
    await requireAccess(ctx, userId);
    const connection = await ctx.runQuery(
      internal.notion.getConnectionInternal,
      { userId },
    );
    if (!connection?.databases) {
      return [];
    }
    const results: DatabaseState[] = [];
    for (const [key, databaseId] of Object.entries(connection.databases)) {
      results.push(await inspectDatabase(connection.accessToken, key, databaseId));
    }
    // The check is already reading every database, so this costs nothing.
    await ctx.scheduler.runAfter(0, internal.notion.refreshManualProperties, {
      userId,
    });
    return results;
  },
});

// Put the destination back the way Finny expects to find it.
//
// Two repairs, and they are not the same size:
//
//  - A missing property is added back. Additive and safe; the next sync fills
//    it in for every row it touches.
//  - A missing or trashed database is rebuilt, which is not: the rows went
//    with it. So the map entries pointing into it are dropped (they address
//    pages that no longer exist), every relation aimed at it is repointed at
//    the new id, and the next sync writes the history again from Plaid.
//
// A property whose type was changed is left alone — see DatabaseState.
export const repairDatabases = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ rebuilt: string[]; propertiesAdded: number; syncing: number }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not signed in");
    }
    await requireAccess(ctx, userId);
    const connection = await ctx.runQuery(
      internal.notion.getConnectionInternal,
      { userId },
    );
    if (!connection?.databases || !connection.parentPageId) {
      throw new Error("Set up the Notion destination first");
    }
    const token = connection.accessToken;
    const states = await ctx.runAction(api.notion.checkDatabases, {});

    // 1. Properties first: they need no new ids and cannot fail the rest.
    let propertiesAdded = 0;
    for (const state of states) {
      if (state.state !== "damaged" || state.missingProperties.length === 0) {
        continue;
      }
      const spec = SPEC_BY_KEY[state.key];
      const definitions = spec.properties(connection.databases);
      const patch = Object.fromEntries(
        state.missingProperties
          .filter((name) => definitions[name])
          .map((name) => [name, definitions[name]]),
      );
      if (Object.keys(patch).length === 0) {
        continue;
      }
      await notionFetch(token, `/databases/${connection.databases[state.key]}`, {
        method: "PATCH",
        body: { properties: patch },
      });
      propertiesAdded += Object.keys(patch).length;
    }

    // 2. Databases that have to be built again.
    const gone = states
      .filter((state) => state.state === "missing" || state.state === "trashed")
      .map((state) => state.key);
    if (gone.length === 0) {
      return { rebuilt: [], propertiesAdded, syncing: 0 };
    }

    // Forgetting the id is what makes ensureDatabases create it: it skips any
    // key it already has one for.
    const kept = Object.fromEntries(
      Object.entries(connection.databases).filter(([key]) => !gone.includes(key)),
    );
    const databases = await ensureDatabases(ctx, {
      userId,
      token,
      parentPageId: connection.parentPageId,
      modules: connection.modules,
      startDate: connection.startDate,
      existing: kept,
    });

    // 3. Repoint every relation that aimed at one of the rebuilt databases.
    //    A relation stores the target's id, so a database built with the same
    //    name is a different database as far as the columns pointing at it are
    //    concerned.
    for (const dependency of relationDependencies()) {
      if (!gone.includes(dependency.to) || gone.includes(dependency.from)) {
        // A dependent that was itself rebuilt already has the new id — it was
        // created after its dependency, which is what DATABASE_SPECS' order
        // guarantees.
        continue;
      }
      const from = databases[dependency.from];
      const to = databases[dependency.to];
      if (!from || !to) {
        continue;
      }
      await notionFetch(token, `/databases/${from}`, {
        method: "PATCH",
        body: {
          properties: {
            [dependency.property]: {
              relation: {
                database_id: to,
                type: "single_property",
                single_property: {},
              },
            },
          },
        },
      });
    }

    // 4. Drop the page ids that pointed into the databases that went away.
    for (const key of gone) {
      for (const kind of MAP_KINDS_BY_DATABASE[key] ?? []) {
        while (
          await ctx.runMutation(internal.syncData.clearMapEntriesOfKind, {
            userId,
            kind: kind as any,
          })
        ) {
          // Batched; keep going until this kind is empty for the user.
        }
      }
    }

    const syncing = await scheduleSyncs(ctx, userId, "manual");
    return { rebuilt: gone, propertiesAdded, syncing };
  },
});

// Set or clear one database's title template.
//
// Validated against the tokens that database actually offers: a template
// naming something Finny cannot fill in would render a blank in every row
// from then on, and the place to notice that is here.
export const setTitleFormat = mutation({
  args: { key: v.string(), template: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not signed in");
    }
    const user = await ctx.db.get(userId);
    if (user?.accessGrantedAt === undefined) {
      throw new Error("Access password required");
    }
    if (!TITLE_FORMAT_BY_KEY[args.key]) {
      throw new Error(`${args.key} has no title format`);
    }
    const template = args.template.trim().slice(0, MAX_TEMPLATE_LENGTH);
    const unknown = unknownTokens(args.key, template);
    if (unknown.length > 0) {
      throw new Error(
        `${unknown.map((name) => `{${name}}`).join(", ")} ${
          unknown.length === 1 ? "is not a field" : "are not fields"
        } here`,
      );
    }
    const badFilters = unknownFilters(template);
    if (badFilters.length > 0) {
      throw new Error(
        `${badFilters.map((name) => `.${name}`).join(", ")} ${
          badFilters.length === 1 ? "is not a filter" : "are not filters"
        }`,
      );
    }
    const connection = await ctx.db
      .query("notionConnections")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (!connection) {
      throw new Error("Notion not connected");
    }
    const titleFormats = { ...(connection.titleFormats ?? {}) };
    if (template) {
      titleFormats[args.key] = template;
    } else {
      // Cleared, which is how you ask for the built-in title back.
      delete titleFormats[args.key];
    }
    await ctx.db.patch(connection._id, { titleFormats });
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

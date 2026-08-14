/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const TTL_MS = 15 * 60 * 1000;

async function withUser() {
  const t = convexTest(schema, modules);
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", { email: "tester@example.com" }),
  );
  return { t, userId };
}

// A user who has entered the access password, which every Notion action
// requires.
async function withAccess() {
  const t = convexTest(schema, modules);
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", {
      email: "tester@example.com",
      accessGrantedAt: Date.now(),
    }),
  );
  return {
    t,
    userId,
    asUser: t.withIdentity({ subject: `${userId}|session1` }),
  };
}

function insertConnection(
  t: Awaited<ReturnType<typeof withUser>>["t"],
  userId: Id<"users">,
  fields: {
    workspaceId: string;
    databases?: Record<string, string>;
    parentPageId?: string;
  },
) {
  return t.run(async (ctx) =>
    ctx.db.insert("notionConnections", {
      userId,
      accessToken: "secret-old",
      workspaceId: fields.workspaceId,
      workspaceName: "Workspace",
      botId: "bot-1",
      modules: { balances: true, spending: true, investments: true },
      parentPageId: fields.parentPageId,
      databases: fields.databases,
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("consumeOauthState returns the state once and only once", async () => {
  const { t, userId } = await withUser();
  await t.mutation(internal.notion.saveOauthState, {
    userId,
    state: "state-1",
    origin: "http://localhost:3466",
  });

  expect(
    await t.mutation(internal.notion.consumeOauthState, { state: "state-1" }),
  ).toEqual({ userId, origin: "http://localhost:3466" });

  // Replaying the callback must not hand out a second usable state.
  expect(
    await t.mutation(internal.notion.consumeOauthState, { state: "state-1" }),
  ).toBeNull();
});

test("consumeOauthState rejects an unknown state", async () => {
  const { t } = await withUser();
  expect(
    await t.mutation(internal.notion.consumeOauthState, { state: "forged" }),
  ).toBeNull();
});

test("consumeOauthState rejects a state older than the TTL", async () => {
  const { t, userId } = await withUser();
  await t.run(async (ctx) => {
    await ctx.db.insert("notionOauthStates", {
      userId,
      state: "state-old",
      createdAt: Date.now() - TTL_MS - 1000,
    });
  });

  expect(
    await t.mutation(internal.notion.consumeOauthState, {
      state: "state-old",
    }),
  ).toBeNull();
  // Expired or not, the row is spent.
  const rows = await t.run(async (ctx) =>
    ctx.db.query("notionOauthStates").collect(),
  );
  expect(rows).toHaveLength(0);
});

test("consumeOauthState accepts a state just inside the TTL", async () => {
  const { t, userId } = await withUser();
  await t.run(async (ctx) => {
    await ctx.db.insert("notionOauthStates", {
      userId,
      state: "state-fresh",
      createdAt: Date.now() - (TTL_MS - 5000),
    });
  });

  expect(
    await t.mutation(internal.notion.consumeOauthState, {
      state: "state-fresh",
    }),
  ).toEqual({ userId, origin: undefined });
});

test("reconnecting the same workspace keeps the databases", async () => {
  const { t, userId } = await withUser();
  await insertConnection(t, userId, {
    workspaceId: "ws-1",
    parentPageId: "page-1",
    databases: { transactions: "db-txn", accounts: "db-acct" },
  });

  await t.mutation(internal.notion.saveConnection, {
    userId,
    accessToken: "secret-new",
    workspaceId: "ws-1",
    workspaceName: "Workspace",
    botId: "bot-2",
  });

  const connection = await t.run(async (ctx) =>
    ctx.db
      .query("notionConnections")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique(),
  );
  // The whole point of reconnecting instead of disconnecting: a new token,
  // the same databases.
  expect(connection?.accessToken).toBe("secret-new");
  expect(connection?.parentPageId).toBe("page-1");
  expect(connection?.databases).toEqual({
    transactions: "db-txn",
    accounts: "db-acct",
  });
});

test("reconnecting a different workspace clears the databases", async () => {
  const { t, userId } = await withUser();
  await insertConnection(t, userId, {
    workspaceId: "ws-1",
    parentPageId: "page-1",
    databases: { transactions: "db-txn" },
  });

  await t.mutation(internal.notion.saveConnection, {
    userId,
    accessToken: "secret-new",
    workspaceId: "ws-2",
    workspaceName: "Other workspace",
    botId: "bot-2",
  });

  const connection = await t.run(async (ctx) =>
    ctx.db
      .query("notionConnections")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique(),
  );
  // Databases in the old workspace are unreachable with the new token, so
  // keeping their ids would only make every sync 404.
  expect(connection?.workspaceId).toBe("ws-2");
  expect(connection?.databases).toBeUndefined();
  expect(connection?.parentPageId).toBeUndefined();
});

test("getStatus exposes the workspace id so a reconnect can be compared", async () => {
  const { t, userId, asUser } = await withAccess();
  await insertConnection(t, userId, { workspaceId: "ws-1" });

  const status = await asUser.query(api.notion.getStatus, {});
  expect(status).toMatchObject({ connected: true, workspaceId: "ws-1" });
});

test("checkHealth reports a revoked token as unauthorized", async () => {
  const { t, userId, asUser } = await withAccess();
  await insertConnection(t, userId, { workspaceId: "ws-1" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ message: "API token is invalid." }, { status: 401 }),
    ),
  );

  expect(await asUser.action(api.notion.checkHealth, {})).toEqual({
    state: "unauthorized",
    message: "API token is invalid.",
  });
});

test("checkHealth separates a healthy token from an unreachable Notion", async () => {
  const { t, userId, asUser } = await withAccess();
  await insertConnection(t, userId, { workspaceId: "ws-1" });

  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "bot-1" })));
  expect(await asUser.action(api.notion.checkHealth, {})).toEqual({
    state: "ok",
  });

  // A 5xx is Notion's problem, not the user's — it must not read as
  // "reauthorise".
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({}, { status: 503 })),
  );
  expect(await asUser.action(api.notion.checkHealth, {})).toEqual({
    state: "unknown",
    message: "Notion returned 503",
  });
});

test("checkHealth says disconnected rather than pinging Notion", async () => {
  const { asUser } = await withAccess();
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  expect(await asUser.action(api.notion.checkHealth, {})).toEqual({
    state: "disconnected",
  });
  expect(fetchMock).not.toHaveBeenCalled();
});

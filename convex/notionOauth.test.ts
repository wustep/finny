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
    modules?: { balances: boolean; spending: boolean; investments: boolean };
    startDate?: string;
  },
) {
  return t.run(async (ctx) =>
    ctx.db.insert("notionConnections", {
      userId,
      accessToken: "secret-old",
      workspaceId: fields.workspaceId,
      workspaceName: "Workspace",
      botId: "bot-1",
      modules: fields.modules ?? {
        balances: true,
        spending: true,
        investments: true,
      },
      parentPageId: fields.parentPageId,
      startDate: fields.startDate,
      databases: fields.databases,
    }),
  );
}

function notionConnection(
  t: Awaited<ReturnType<typeof withUser>>["t"],
  userId: Id<"users">,
) {
  return t.run(async (ctx) =>
    ctx.db
      .query("notionConnections")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique(),
  );
}

function insertBank(
  t: Awaited<ReturnType<typeof withUser>>["t"],
  userId: Id<"users">,
  plaidItemId: string,
  cursor?: string,
) {
  return t.run(async (ctx) =>
    ctx.db.insert("bankConnections", {
      userId,
      plaidItemId,
      accessToken: "plaid-token",
      institutionName: "Bank",
      status: "active",
      transactionsCursor: cursor,
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

const SPENDING_AND_BALANCES = {
  bankConnections: "db-bc",
  accounts: "db-acct",
  balanceHistory: "db-bh",
  categories: "db-cat",
  transactions: "db-txn",
};

test("enabling a module creates only the databases it is missing", async () => {
  const { t, userId, asUser } = await withAccess();
  await insertConnection(t, userId, {
    workspaceId: "ws-1",
    parentPageId: "page-1",
    startDate: "2024-01-01",
    modules: { balances: true, spending: true, investments: false },
    databases: SPENDING_AND_BALANCES,
  });
  await insertBank(t, userId, "item-1");
  let created = 0;
  const fetchMock = vi.fn(async () =>
    Response.json({ id: `db-new-${++created}` }),
  );
  vi.stubGlobal("fetch", fetchMock);

  const databases = await asUser.action(api.notion.setModules, {
    modules: { balances: true, spending: true, investments: true },
  });

  // Securities, Holdings, Investment Transactions — and nothing that already
  // existed, which is what stops a second set of databases appearing.
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(databases).toMatchObject(SPENDING_AND_BALANCES);
  expect(Object.keys(databases).sort()).toEqual([
    "accounts",
    "balanceHistory",
    "bankConnections",
    "categories",
    "holdings",
    "investmentTransactions",
    "securities",
    "transactions",
  ]);
  const connection = await notionConnection(t, userId);
  expect(connection?.modules.investments).toBe(true);
  // New databases are empty until something syncs into them.
  const scheduled = await t.run(async (ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  expect(scheduled).toHaveLength(1);
});

test("disabling a module keeps its databases and syncs nothing", async () => {
  const { t, userId, asUser } = await withAccess();
  const databases = {
    ...SPENDING_AND_BALANCES,
    securities: "db-sec",
    holdings: "db-hold",
    investmentTransactions: "db-invtxn",
  };
  await insertConnection(t, userId, {
    workspaceId: "ws-1",
    parentPageId: "page-1",
    databases,
  });
  await insertBank(t, userId, "item-1");
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  await asUser.action(api.notion.setModules, {
    modules: { balances: true, spending: true, investments: false },
  });

  expect(fetchMock).not.toHaveBeenCalled();
  const connection = await notionConnection(t, userId);
  expect(connection?.modules.investments).toBe(false);
  // Turning a module off stops the writes; the user's history stays.
  expect(connection?.databases).toEqual(databases);
  const scheduled = await t.run(async (ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  expect(scheduled).toHaveLength(0);
});

test("saving a start date without a re-backfill leaves the cursors alone", async () => {
  const { t, userId, asUser } = await withAccess();
  await insertConnection(t, userId, {
    workspaceId: "ws-1",
    parentPageId: "page-1",
    startDate: "2024-01-01",
    databases: SPENDING_AND_BALANCES,
  });
  await insertBank(t, userId, "item-1", "cursor-1");

  expect(
    await asUser.mutation(api.notion.setStartDate, {
      startDate: "2025-06-01",
      rebackfill: false,
    }),
  ).toEqual({ connections: 0 });

  const connection = await notionConnection(t, userId);
  expect(connection?.startDate).toBe("2025-06-01");
  // Plaid only re-sends history from a rewound cursor, so leaving it put is
  // what makes "save only" mean "from the next sync onwards".
  const bank = await t.run(async (ctx) =>
    ctx.db
      .query("bankConnections")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique(),
  );
  expect(bank?.transactionsCursor).toBe("cursor-1");
});

test("re-backfilling rewinds every cursor and syncs every bank", async () => {
  const { t, userId, asUser } = await withAccess();
  await insertConnection(t, userId, {
    workspaceId: "ws-1",
    parentPageId: "page-1",
    startDate: "2024-01-01",
    databases: SPENDING_AND_BALANCES,
  });
  await insertBank(t, userId, "item-1", "cursor-1");
  await insertBank(t, userId, "item-2", "cursor-2");

  expect(
    await asUser.mutation(api.notion.setStartDate, {
      startDate: "2020-01-01",
      rebackfill: true,
    }),
  ).toEqual({ connections: 2 });

  const connection = await notionConnection(t, userId);
  expect(connection?.startDate).toBe("2020-01-01");
  const banks = await t.run(async (ctx) =>
    ctx.db
      .query("bankConnections")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect(),
  );
  expect(banks.map((bank) => bank.transactionsCursor)).toEqual([
    undefined,
    undefined,
  ]);
  const scheduled = await t.run(async (ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  expect(scheduled).toHaveLength(2);
});

test("setStartDate rejects a date that is not an ISO day", async () => {
  const { t, userId, asUser } = await withAccess();
  await insertConnection(t, userId, { workspaceId: "ws-1" });

  await expect(
    asUser.mutation(api.notion.setStartDate, {
      startDate: "01/06/2025",
      rebackfill: false,
    }),
  ).rejects.toThrow("YYYY-MM-DD");
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

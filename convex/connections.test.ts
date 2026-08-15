/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const ACCOUNT = {
  plaidAccountId: "acct_1",
  name: "Checking",
  mask: "0000",
  type: "depository",
  subtype: "checking",
};

async function twoUsers() {
  const t = convexTest(schema, modules);
  const [alice, bob] = await t.run(async (ctx) => [
    await ctx.db.insert("users", { email: "alice@example.com" }),
    await ctx.db.insert("users", { email: "bob@example.com" }),
  ]);
  return { t, alice, bob };
}

test("saveConnection refuses a Plaid Item owned by another user", async () => {
  const { t, alice, bob } = await twoUsers();
  await t.mutation(internal.connections.saveConnection, {
    userId: alice,
    plaidItemId: "item_1",
    accessToken: "access-alice",
    institutionName: "Alice Bank",
    accounts: [ACCOUNT],
  });

  await expect(
    t.mutation(internal.connections.saveConnection, {
      userId: bob,
      plaidItemId: "item_1",
      accessToken: "access-bob",
      institutionName: "Bob Bank",
      accounts: [],
    }),
  ).rejects.toThrow("Item belongs to a different user");

  const connection = await t.query(internal.connections.getByItemInternal, {
    plaidItemId: "item_1",
  });
  expect(connection?.userId).toBe(alice);
  expect(connection?.accessToken).toBe("access-alice");
});

test("saveConnection re-links the same user's Item in place", async () => {
  const { t, alice } = await twoUsers();
  const first = await t.mutation(internal.connections.saveConnection, {
    userId: alice,
    plaidItemId: "item_1",
    accessToken: "access-1",
    institutionName: "Alice Bank",
    accounts: [ACCOUNT],
  });
  const second = await t.mutation(internal.connections.saveConnection, {
    userId: alice,
    plaidItemId: "item_1",
    accessToken: "access-2",
    institutionName: "Alice Bank",
    accounts: [ACCOUNT],
  });

  expect(second).toBe(first);
  const accounts = await t.run(async (ctx) =>
    ctx.db.query("accounts").collect(),
  );
  expect(accounts).toHaveLength(1);
});

test("toggleAccountSync refuses another user's account", async () => {
  const { t, alice, bob } = await twoUsers();
  await t.mutation(internal.connections.saveConnection, {
    userId: alice,
    plaidItemId: "item_1",
    accessToken: "access-alice",
    institutionName: "Alice Bank",
    accounts: [ACCOUNT],
  });
  const accountId = await t.run(async (ctx) => {
    const account = await ctx.db.query("accounts").first();
    return account!._id;
  });

  await expect(
    t
      .withIdentity({ subject: `${bob}|session-bob` })
      .mutation(api.connections.toggleAccountSync, {
        accountId,
        enabled: false,
      }),
  ).rejects.toThrow("Account not found");

  await expect(
    t.mutation(api.connections.toggleAccountSync, {
      accountId,
      enabled: false,
    }),
  ).rejects.toThrow("Not signed in");

  const account = await t.run(async (ctx) => ctx.db.get(accountId));
  expect(account?.syncEnabled).toBe(true);
  expect(account?.needsBackfill).toBeUndefined();
});

test("toggleAccountSync updates the owner's own account", async () => {
  const { t, alice } = await twoUsers();
  await t.mutation(internal.connections.saveConnection, {
    userId: alice,
    plaidItemId: "item_1",
    accessToken: "access-alice",
    institutionName: "Alice Bank",
    accounts: [ACCOUNT],
  });
  const accountId = await t.run(async (ctx) => {
    const account = await ctx.db.query("accounts").first();
    return account!._id;
  });

  await t
    .withIdentity({ subject: `${alice}|session-alice` })
    .mutation(api.connections.toggleAccountSync, {
      accountId,
      enabled: false,
    });

  const account = await t.run(async (ctx) => ctx.db.get(accountId));
  expect(account?.syncEnabled).toBe(false);
});

test("toggleAccountSync queues a catch-up when an account is switched on", async () => {
  const { t, alice } = await twoUsers();
  await t.mutation(internal.connections.saveConnection, {
    userId: alice,
    plaidItemId: "item_1",
    accessToken: "access-alice",
    institutionName: "Alice Bank",
    accounts: [ACCOUNT],
  });
  const accountId = await t.run(async (ctx) => {
    const account = await ctx.db.query("accounts").first();
    return account!._id;
  });
  const asAlice = t.withIdentity({ subject: `${alice}|session-alice` });
  const read = () => t.run(async (ctx) => ctx.db.get(accountId));

  // Off: the Item's cursor keeps moving without this account, so there is
  // nothing to catch up on until it comes back.
  await asAlice.mutation(api.connections.toggleAccountSync, {
    accountId,
    enabled: false,
  });
  expect((await read())?.needsBackfill).toBeUndefined();

  await asAlice.mutation(api.connections.toggleAccountSync, {
    accountId,
    enabled: true,
  });
  expect((await read())?.needsBackfill).toBe(true);

  await t.mutation(internal.connections.clearAccountBackfill, { accountId });
  expect((await read())?.needsBackfill).toBeUndefined();
});

test("upsertPlaidAccounts adds unknown accounts disabled and refreshes known ones", async () => {
  const { t, alice } = await twoUsers();
  const connectionId = await t.mutation(internal.connections.saveConnection, {
    userId: alice,
    plaidItemId: "item_1",
    accessToken: "access-alice",
    institutionName: "Alice Bank",
    accounts: [ACCOUNT],
  });

  const result = await t.mutation(internal.connections.upsertPlaidAccounts, {
    connectionId,
    accounts: [
      { ...ACCOUNT, name: "Everyday Checking" },
      {
        plaidAccountId: "acct_2",
        name: "Savings",
        mask: "1111",
        type: "depository",
        subtype: "savings",
      },
    ],
  });

  expect(result.discovered).toBe(1);
  const accounts = await t.run(async (ctx) =>
    ctx.db.query("accounts").collect(),
  );
  const known = accounts.find((a) => a.plaidAccountId === "acct_1");
  const discovered = accounts.find((a) => a.plaidAccountId === "acct_2");
  expect(known?.name).toBe("Everyday Checking");
  expect(known?.syncEnabled).toBe(true);
  expect(known?.discoveredAt).toBeUndefined();
  expect(discovered?.syncEnabled).toBe(false);
  expect(discovered?.discoveredAt).toEqual(expect.any(Number));
  expect(discovered?.userId).toBe(alice);

  // The user answering either way retires the new badge.
  await t
    .withIdentity({ subject: `${alice}|session-alice` })
    .mutation(api.connections.toggleAccountSync, {
      accountId: discovered!._id,
      enabled: true,
    });
  const opted = await t.run(async (ctx) => ctx.db.get(discovered!._id));
  expect(opted?.discoveredAt).toBeUndefined();
});

test("activeRuns returns only the caller's in-flight runs", async () => {
  const { t, alice, bob } = await twoUsers();
  const connectionId = await t.mutation(internal.connections.saveConnection, {
    userId: alice,
    plaidItemId: "item_1",
    accessToken: "access-alice",
    institutionName: "Alice Bank",
    accounts: [ACCOUNT],
  });
  await t.run(async (ctx) => {
    await ctx.db.insert("syncRuns", {
      userId: alice,
      connectionId,
      trigger: "initial" as const,
      status: "running" as const,
      startedAt: Date.now(),
      stats: { added: 7, modified: 2, removed: 0 },
    });
    await ctx.db.insert("syncRuns", {
      userId: alice,
      connectionId,
      trigger: "cron" as const,
      status: "success" as const,
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
    });
  });

  const mine = await t
    .withIdentity({ subject: `${alice}|session-alice` })
    .query(api.connections.activeRuns);
  expect(mine).toHaveLength(1);
  expect(mine[0]).toMatchObject({
    connectionId,
    trigger: "initial",
    stats: { added: 7, modified: 2, removed: 0 },
  });

  expect(
    await t
      .withIdentity({ subject: `${bob}|session-bob` })
      .query(api.connections.activeRuns),
  ).toEqual([]);
  expect(await t.query(api.connections.activeRuns)).toEqual([]);
});

const HOUR = 60 * 60 * 1000;

test("sweepStuckRuns closes runs whose lease died but leaves live ones alone", async () => {
  const { t, alice } = await twoUsers();
  const connectionId = await t.mutation(internal.connections.saveConnection, {
    userId: alice,
    plaidItemId: "item_1",
    accessToken: "access-alice",
    institutionName: "Alice Bank",
    accounts: [ACCOUNT],
  });
  const now = Date.now();
  const { dead, alive, recent } = await t.run(async (ctx) => {
    const run = (startedAt: number) =>
      ctx.db.insert("syncRuns", {
        userId: alice,
        connectionId,
        trigger: "cron" as const,
        status: "running" as const,
        startedAt,
      });
    return {
      dead: await run(now - 5 * HOUR),
      alive: await run(now - 4 * HOUR),
      recent: await run(now - 60 * 1000),
    };
  });

  // The live one is heartbeating: it holds the connection's lease.
  await t.run(async (ctx) => {
    await ctx.db.patch(connectionId, {
      activeRunId: alive,
      syncLockExpiresAt: now + 5 * 60 * 1000,
    });
  });

  const closed = await t.mutation(internal.syncData.sweepStuckRuns, {});
  expect(closed).toBe(1);

  const rows = await t.run(async (ctx) => ({
    dead: await ctx.db.get(dead),
    alive: await ctx.db.get(alive),
    recent: await ctx.db.get(recent),
    connection: await ctx.db.get(connectionId),
  }));
  expect(rows.dead?.status).toBe("error");
  expect(rows.dead?.error).toBe("timed out");
  expect(rows.dead?.finishedAt).toEqual(expect.any(Number));
  // Old but heartbeating — a two-year backfill legitimately looks like this.
  expect(rows.alive?.status).toBe("running");
  expect(rows.recent?.status).toBe("running");
  // The lease belongs to the run still going, so it stays put.
  expect(rows.connection?.activeRunId).toBe(alive);
});

test("sweepStuckRuns frees a lease still pointing at the dead run", async () => {
  const { t, alice } = await twoUsers();
  const connectionId = await t.mutation(internal.connections.saveConnection, {
    userId: alice,
    plaidItemId: "item_1",
    accessToken: "access-alice",
    institutionName: "Alice Bank",
    accounts: [ACCOUNT],
  });
  const runId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("syncRuns", {
      userId: alice,
      connectionId,
      trigger: "manual" as const,
      status: "running" as const,
      startedAt: Date.now() - 5 * HOUR,
    });
    await ctx.db.patch(connectionId, {
      activeRunId: id,
      syncLockExpiresAt: Date.now() - HOUR,
    });
    return id;
  });

  expect(await t.mutation(internal.syncData.sweepStuckRuns, {})).toBe(1);

  const connection = await t.run(async (ctx) => ctx.db.get(connectionId));
  expect(connection?.activeRunId).toBeUndefined();
  expect(connection?.syncLockExpiresAt).toBeUndefined();
  const run = await t.run(async (ctx) => ctx.db.get(runId));
  expect(run?.status).toBe("error");
});

test("markReconnected refuses another user's connection", async () => {
  const { t, alice, bob } = await twoUsers();
  await t.run(async (ctx) => {
    await ctx.db.patch(bob, { accessGrantedAt: Date.now() });
  });
  const connectionId = await t.mutation(internal.connections.saveConnection, {
    userId: alice,
    plaidItemId: "item_1",
    accessToken: "access-alice",
    institutionName: "Alice Bank",
    accounts: [ACCOUNT],
  });
  await t.mutation(internal.connections.setStatusByItem, {
    plaidItemId: "item_1",
    status: "error",
    errorCode: "ITEM_LOGIN_REQUIRED",
  });

  await expect(
    t
      .withIdentity({ subject: `${bob}|session-bob` })
      .mutation(api.connections.markReconnected, { connectionId }),
  ).rejects.toThrow("Connection not found");

  await expect(
    t.mutation(api.connections.markReconnected, { connectionId }),
  ).rejects.toThrow("Not signed in");

  const connection = await t.run(async (ctx) => ctx.db.get(connectionId));
  expect(connection?.status).toBe("error");
});

test("markReconnected needs the access password, then clears the error", async () => {
  const { t, alice } = await twoUsers();
  const connectionId = await t.mutation(internal.connections.saveConnection, {
    userId: alice,
    plaidItemId: "item_1",
    accessToken: "access-alice",
    institutionName: "Alice Bank",
    accounts: [ACCOUNT],
  });
  await t.mutation(internal.connections.setStatusByItem, {
    plaidItemId: "item_1",
    status: "error",
    errorCode: "ITEM_LOGIN_REQUIRED",
  });
  const asAlice = t.withIdentity({ subject: `${alice}|session-alice` });

  await expect(
    asAlice.mutation(api.connections.markReconnected, { connectionId }),
  ).rejects.toThrow("Access password required");

  await t.run(async (ctx) => {
    await ctx.db.patch(alice, { accessGrantedAt: Date.now() });
  });
  await asAlice.mutation(api.connections.markReconnected, { connectionId });

  const connection = await t.run(async (ctx) => ctx.db.get(connectionId));
  expect(connection?.status).toBe("active");
  expect(connection?.errorCode).toBeUndefined();
});

test("markItemBroken flags a connection a sync found broken", async () => {
  const { t, alice } = await twoUsers();
  const connectionId = await t.mutation(internal.connections.saveConnection, {
    userId: alice,
    plaidItemId: "item_broken",
    accessToken: "access-alice",
    institutionName: "Alice Bank",
    accounts: [ACCOUNT],
  });

  await t.mutation(internal.connections.markItemBroken, {
    connectionId,
    errorCode: "ITEM_LOGIN_REQUIRED",
  });

  const connection = await t.run(async (ctx) => ctx.db.get(connectionId));
  expect(connection).toMatchObject({
    status: "error",
    errorCode: "ITEM_LOGIN_REQUIRED",
  });
});

test("markItemBroken keeps the first error code rather than overwriting it", async () => {
  const { t, alice } = await twoUsers();
  const connectionId = await t.mutation(internal.connections.saveConnection, {
    userId: alice,
    plaidItemId: "item_broken_twice",
    accessToken: "access-alice",
    institutionName: "Alice Bank",
    accounts: [ACCOUNT],
  });

  await t.mutation(internal.connections.markItemBroken, {
    connectionId,
    errorCode: "ITEM_LOGIN_REQUIRED",
  });
  // Every later stage of the same run hits the same wall; the first code is
  // the one that explains it.
  await t.mutation(internal.connections.markItemBroken, {
    connectionId,
    errorCode: "PRODUCTS_NOT_READY",
  });

  const connection = await t.run(async (ctx) => ctx.db.get(connectionId));
  expect(connection?.errorCode).toBe("ITEM_LOGIN_REQUIRED");
});

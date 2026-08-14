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

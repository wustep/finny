/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const COFFEE = {
  name: "Coffee",
  conditions: [
    {
      kind: "text" as const,
      field: "merchant" as const,
      op: "contains" as const,
      values: ["blue bottle"],
    },
  ],
  outcomes: { categoryId: "FOOD_AND_DRINK_COFFEE" },
};

async function twoUsers() {
  const t = convexTest(schema, modules);
  const [alice, bob] = await t.run(async (ctx) => [
    await ctx.db.insert("users", { email: "alice@example.com" }),
    await ctx.db.insert("users", { email: "bob@example.com" }),
  ]);
  return {
    t,
    alice,
    bob,
    asAlice: t.withIdentity({ subject: `${alice}|session-alice` }),
    asBob: t.withIdentity({ subject: `${bob}|session-bob` }),
  };
}

async function accountFor(
  t: Awaited<ReturnType<typeof twoUsers>>["t"],
  userId: Id<"users">,
): Promise<Id<"accounts">> {
  return await t.run(async (ctx) => {
    const connectionId = await ctx.db.insert("bankConnections", {
      userId,
      plaidItemId: `item_${userId}`,
      accessToken: "access",
      institutionName: "Bank",
      status: "active" as const,
    });
    return await ctx.db.insert("accounts", {
      userId,
      connectionId,
      plaidAccountId: `acct_${userId}`,
      name: "Checking",
      type: "depository",
      syncEnabled: true,
    });
  });
}

test("rules are private to the user who made them", async () => {
  const { t, asAlice, asBob } = await twoUsers();
  const ruleId = await asAlice.mutation(api.rules.create, COFFEE);

  expect(await asBob.query(api.rules.list)).toEqual([]);
  await expect(
    asBob.mutation(api.rules.update, { ruleId, enabled: false }),
  ).rejects.toThrow("Rule not found");
  await expect(
    asBob.mutation(api.rules.move, { ruleId, direction: "up" }),
  ).rejects.toThrow("Rule not found");
  await expect(asBob.mutation(api.rules.remove, { ruleId })).rejects.toThrow(
    "Rule not found",
  );

  // Signed out is not a way in either.
  await expect(t.mutation(api.rules.create, COFFEE)).rejects.toThrow(
    "Not signed in",
  );
  await expect(
    t.mutation(api.rules.update, { ruleId, enabled: false }),
  ).rejects.toThrow("Not signed in");
  expect(await t.query(api.rules.list)).toEqual([]);

  const mine = await asAlice.query(api.rules.list);
  expect(mine).toHaveLength(1);
  expect(mine[0]).toMatchObject({ name: "Coffee", enabled: true });
});

test("a rule cannot point at another user's account", async () => {
  const { asAlice, asBob, t, bob } = await twoUsers();
  const bobsAccount = await accountFor(t, bob);

  await expect(
    asAlice.mutation(api.rules.create, {
      ...COFFEE,
      conditions: [
        ...COFFEE.conditions,
        { kind: "account" as const, accountIds: [bobsAccount] },
      ],
    }),
  ).rejects.toThrow("Account not found");

  // Bob's own account is fine.
  await asBob.mutation(api.rules.create, {
    ...COFFEE,
    conditions: [
      ...COFFEE.conditions,
      { kind: "account" as const, accountIds: [bobsAccount] },
    ],
  });
  const rules = await asBob.query(api.rules.list);
  expect(rules[0].conditions).toContainEqual({
    kind: "account",
    accountIds: [bobsAccount],
  });
});

test("new rules go to the end of the priority order", async () => {
  const { asAlice } = await twoUsers();
  await asAlice.mutation(api.rules.create, { ...COFFEE, name: "First" });
  await asAlice.mutation(api.rules.create, { ...COFFEE, name: "Second" });
  await asAlice.mutation(api.rules.create, { ...COFFEE, name: "Third" });

  const rules = await asAlice.query(api.rules.list);
  expect(rules.map((rule) => rule.name)).toEqual(["First", "Second", "Third"]);
  expect(rules.map((rule) => rule.priority)).toEqual([1, 2, 3]);
});

test("move swaps a rule with its neighbour and stops at the ends", async () => {
  const { asAlice } = await twoUsers();
  await asAlice.mutation(api.rules.create, { ...COFFEE, name: "First" });
  const second = await asAlice.mutation(api.rules.create, {
    ...COFFEE,
    name: "Second",
  });
  const names = async () =>
    (await asAlice.query(api.rules.list)).map((rule) => rule.name);

  await asAlice.mutation(api.rules.move, { ruleId: second, direction: "up" });
  expect(await names()).toEqual(["Second", "First"]);

  // Already first: nothing to swap with, and nothing thrown.
  await asAlice.mutation(api.rules.move, { ruleId: second, direction: "up" });
  expect(await names()).toEqual(["Second", "First"]);

  await asAlice.mutation(api.rules.move, { ruleId: second, direction: "down" });
  expect(await names()).toEqual(["First", "Second"]);
});

test("update replaces conditions and outcomes wholesale", async () => {
  const { asAlice } = await twoUsers();
  const ruleId = await asAlice.mutation(api.rules.create, {
    name: "Amazon",
    conditions: [
      { kind: "text", field: "merchant", op: "contains", values: ["amzn"] },
      { kind: "amount", op: "gt", value: 50 },
    ],
    outcomes: { rename: "Amazon", categoryId: "GENERAL_MERCHANDISE_ELECTRONICS" },
  });

  await asAlice.mutation(api.rules.update, {
    ruleId,
    conditions: [
      {
        kind: "text",
        field: "merchant",
        op: "equals",
        values: ["AMZN Mktp US"],
      },
    ],
    outcomes: { hide: true },
  });

  const [rule] = await asAlice.query(api.rules.list);
  expect(rule.conditions).toEqual([
    { kind: "text", field: "merchant", op: "equals", values: ["AMZN Mktp US"] },
  ]);
  expect(rule.outcomes).toEqual({ hide: true });
  expect(rule.name).toBe("Amazon");
});

test("enable and disable go through update without touching the rest", async () => {
  const { asAlice } = await twoUsers();
  const ruleId = await asAlice.mutation(api.rules.create, COFFEE);

  await asAlice.mutation(api.rules.update, { ruleId, enabled: false });
  expect((await asAlice.query(api.rules.list))[0]).toMatchObject({
    enabled: false,
    outcomes: { categoryId: "FOOD_AND_DRINK_COFFEE" },
  });

  await asAlice.mutation(api.rules.update, { ruleId, enabled: true });
  expect((await asAlice.query(api.rules.list))[0].enabled).toBe(true);
});

test("a rule that cannot mean anything is refused", async () => {
  const { asAlice } = await twoUsers();

  await expect(
    asAlice.mutation(api.rules.create, { ...COFFEE, name: "   " }),
  ).rejects.toThrow("Give the rule a name");

  // No conditions: it would match every transaction the user has.
  await expect(
    asAlice.mutation(api.rules.create, { ...COFFEE, conditions: [] }),
  ).rejects.toThrow("at least one condition");

  // A blank value is the UI's way of leaving a condition out, so this is the
  // same as no conditions at all.
  await expect(
    asAlice.mutation(api.rules.create, {
      ...COFFEE,
      conditions: [
        { kind: "text", field: "merchant", op: "contains", values: ["  "] },
      ],
    }),
  ).rejects.toThrow("at least one condition");

  await expect(
    asAlice.mutation(api.rules.create, { ...COFFEE, outcomes: {} }),
  ).rejects.toThrow("at least one outcome");

  await expect(
    asAlice.mutation(api.rules.create, {
      ...COFFEE,
      outcomes: { categoryId: "NOT_A_CATEGORY" },
    }),
  ).rejects.toThrow("Unknown category");

  await expect(
    asAlice.mutation(api.rules.create, {
      ...COFFEE,
      conditions: [
        { kind: "text", field: "description", op: "regex", values: ["coffee("] },
      ],
    }),
  ).rejects.toThrow("not a valid regular expression");

  expect(await asAlice.query(api.rules.list)).toEqual([]);
});

test("the sync reads only the caller's enabled rules, in priority order", async () => {
  const { t, alice, bob, asAlice, asBob } = await twoUsers();
  const first = await asAlice.mutation(api.rules.create, {
    ...COFFEE,
    name: "First",
  });
  await asAlice.mutation(api.rules.create, { ...COFFEE, name: "Second" });
  const off = await asAlice.mutation(api.rules.create, {
    ...COFFEE,
    name: "Disabled",
  });
  await asAlice.mutation(api.rules.update, { ruleId: off, enabled: false });
  await asBob.mutation(api.rules.create, { ...COFFEE, name: "Bob's" });

  const forSync = await t.query(internal.rules.listEnabledInternal, {
    userId: alice,
  });
  expect(forSync.map((rule) => rule.id)).toContain(first);
  expect(forSync).toHaveLength(2);
  expect(forSync[0].priority).toBeLessThan(forSync[1].priority);
  expect(forSync.every((rule) => rule.enabled)).toBe(true);

  const bobs = await t.query(internal.rules.listEnabledInternal, {
    userId: bob,
  });
  expect(bobs).toHaveLength(1);
});

test("a rule stored in the old shape is read, evaluated, and edited as a list", async () => {
  const { asAlice, t, alice } = await twoUsers();
  const accountId = await accountFor(t, alice);
  // Written straight to the table, the way a rule saved before conditions
  // became a list still sits there today.
  const ruleId = await t.run(async (ctx) =>
    ctx.db.insert("rules", {
      userId: alice,
      name: "Legacy coffee",
      priority: 1,
      enabled: true,
      conditions: {
        merchant: { op: "contains", value: "blue bottle" },
        amount: { op: "gt", value: 5 },
        accountId,
      },
      outcomes: { categoryId: "FOOD_AND_DRINK_COFFEE" },
    }),
  );

  // The client sees a list; nothing on the page knows the old shape existed.
  const [listed] = await asAlice.query(api.rules.list);
  expect(listed.conditions).toEqual([
    { kind: "text", field: "merchant", op: "contains", values: ["blue bottle"] },
    { kind: "amount", op: "gt", value: 5 },
    { kind: "account", accountIds: [accountId] },
  ]);

  // So does the sync.
  const [forSync] = await t.query(internal.rules.listEnabledInternal, {
    userId: alice,
  });
  expect(forSync.conditions).toHaveLength(3);

  // And editing something else about it rewrites the conditions on the way
  // past, which is the cheapest migration there is.
  await asAlice.mutation(api.rules.update, { ruleId, name: "Renamed" });
  const stored = await t.run(async (ctx) => ctx.db.get(ruleId));
  expect(Array.isArray(stored?.conditions)).toBe(true);
});

test("migrateConditions rewrites old rules and leaves new ones alone", async () => {
  const { asAlice, t, alice } = await twoUsers();
  const untouched = await asAlice.mutation(api.rules.create, COFFEE);
  const legacy = await t.run(async (ctx) =>
    ctx.db.insert("rules", {
      userId: alice,
      name: "Legacy",
      priority: 2,
      enabled: true,
      conditions: { merchant: { op: "contains", value: "amzn" } },
      outcomes: { hide: true },
    }),
  );

  expect(await t.mutation(internal.rules.migrateConditions, {})).toMatchObject({
    done: true,
    migrated: 1,
  });

  const rows = await t.run(async (ctx) => ({
    legacy: await ctx.db.get(legacy),
    untouched: await ctx.db.get(untouched),
  }));
  expect(rows.legacy?.conditions).toEqual([
    { kind: "text", field: "merchant", op: "contains", values: ["amzn"] },
  ]);
  expect(rows.untouched?.conditions).toEqual(COFFEE.conditions);

  // Idempotent: running it again finds nothing left to do.
  expect(await t.mutation(internal.rules.migrateConditions, {})).toMatchObject({
    migrated: 0,
  });
});

test("a condition emptied by the UI is dropped rather than saved", async () => {
  const { asAlice } = await twoUsers();
  const ruleId = await asAlice.mutation(api.rules.create, {
    ...COFFEE,
    conditions: [
      ...COFFEE.conditions,
      // Every value blank is how the builder says "I removed this row".
      { kind: "text", field: "description", op: "contains", values: ["", "  "] },
      { kind: "category", categoryIds: [] },
    ],
  });
  const [rule] = await asAlice.query(api.rules.list);
  expect(rule.conditions).toEqual(COFFEE.conditions);
  expect(ruleId).toBeDefined();
});

test("duplicate values in one condition are kept once", async () => {
  const { asAlice } = await twoUsers();
  await asAlice.mutation(api.rules.create, {
    ...COFFEE,
    conditions: [
      {
        kind: "text",
        field: "merchant",
        op: "contains",
        values: ["amzn", "AMZN", " amzn ", "amazon"],
      },
    ],
  });
  const [rule] = await asAlice.query(api.rules.list);
  // Trimmed and de-duplicated, but case is left alone: matching ignores it,
  // and rewriting what someone typed is not this function's job.
  expect(rule.conditions[0]).toMatchObject({
    values: ["amzn", "AMZN", "amazon"],
  });
});

test("a category condition accepts a group or a category, and nothing else", async () => {
  const { asAlice } = await twoUsers();
  await asAlice.mutation(api.rules.create, {
    ...COFFEE,
    conditions: [
      { kind: "category", categoryIds: ["FOOD_AND_DRINK", "TRAVEL_FLIGHTS"] },
    ],
  });
  expect((await asAlice.query(api.rules.list))[0].conditions).toEqual([
    { kind: "category", categoryIds: ["FOOD_AND_DRINK", "TRAVEL_FLIGHTS"] },
  ]);

  await expect(
    asAlice.mutation(api.rules.create, {
      ...COFFEE,
      name: "Bogus",
      conditions: [{ kind: "category", categoryIds: ["NOT_A_CATEGORY"] }],
    }),
  ).rejects.toThrow("Unknown category");
});

test("a rule is capped at ten conditions", async () => {
  const { asAlice } = await twoUsers();
  await expect(
    asAlice.mutation(api.rules.create, {
      ...COFFEE,
      conditions: Array.from({ length: 11 }, (_, index) => ({
        kind: "amount" as const,
        op: "gt" as const,
        value: index,
      })),
    }),
  ).rejects.toThrow("limited to 10 conditions");
});

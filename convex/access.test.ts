/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const PASSWORD = "hunter2-hunter2";
const IP = "203.0.113.7";

beforeEach(() => {
  process.env.ACCESS_PASSWORD = PASSWORD;
});

afterEach(() => {
  delete process.env.ACCESS_PASSWORD;
});

async function signedIn() {
  const t = convexTest(schema, modules);
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", { email: "tester@example.com" }),
  );
  return { t, userId, asUser: t.withIdentity({ subject: `${userId}|session1` }) };
}

test("isConfigured is true when ACCESS_PASSWORD is set", async () => {
  const t = convexTest(schema, modules);
  expect(await t.query(api.access.isConfigured, {})).toBe(true);
});

test("isConfigured is false when ACCESS_PASSWORD is unset", async () => {
  delete process.env.ACCESS_PASSWORD;
  const t = convexTest(schema, modules);
  expect(await t.query(api.access.isConfigured, {})).toBe(false);
});

test("attemptRedeem issues a grant for a signed-out caller", async () => {
  const t = convexTest(schema, modules);
  const outcome = await t.mutation(internal.access.attemptRedeem, {
    ip: IP,
    password: PASSWORD,
  });
  expect(outcome.result).toBe("ok");
  if (outcome.result !== "ok" || outcome.grant === undefined) {
    throw new Error("expected a grant ticket");
  }
  expect(outcome.grant).toMatch(/^[0-9a-f]{64}$/);

  const grants = await t.run(async (ctx) => ctx.db.query("accessGrants").collect());
  expect(grants).toHaveLength(1);
  expect(grants[0]?.token).toBe(outcome.grant);
});

test("attemptRedeem counts a signed-out wrong password against the IP", async () => {
  const t = convexTest(schema, modules);
  expect(
    await t.mutation(internal.access.attemptRedeem, {
      ip: IP,
      password: "nope",
    }),
  ).toEqual({ result: "wrong" });

  const attempt = await t.run(async (ctx) =>
    ctx.db
      .query("accessAttempts")
      .withIndex("by_ip", (q) => q.eq("ip", IP))
      .unique(),
  );
  expect(attempt?.failures).toBe(1);
  expect(attempt?.bannedAt).toBeUndefined();
});

test("attemptRedeem reports unconfigured when ACCESS_PASSWORD is unset", async () => {
  delete process.env.ACCESS_PASSWORD;
  const { asUser } = await signedIn();
  const result = await asUser.mutation(internal.access.attemptRedeem, {
    ip: IP,
    password: "anything",
  });
  expect(result).toEqual({ result: "unconfigured" });
});

test("attemptRedeem counts a wrong password against the IP", async () => {
  const { t, asUser } = await signedIn();
  expect(
    await asUser.mutation(internal.access.attemptRedeem, {
      ip: IP,
      password: "nope",
    }),
  ).toEqual({ result: "wrong" });

  const attempt = await t.run(async (ctx) =>
    ctx.db
      .query("accessAttempts")
      .withIndex("by_ip", (q) => q.eq("ip", IP))
      .unique(),
  );
  expect(attempt?.failures).toBe(1);
  expect(attempt?.bannedAt).toBeUndefined();
});

test("attemptRedeem bans the IP on the third consecutive failure", async () => {
  const { t, asUser } = await signedIn();
  const wrong = { ip: IP, password: "nope" };
  expect(await asUser.mutation(internal.access.attemptRedeem, wrong)).toEqual({
    result: "wrong",
  });
  expect(await asUser.mutation(internal.access.attemptRedeem, wrong)).toEqual({
    result: "wrong",
  });
  expect(await asUser.mutation(internal.access.attemptRedeem, wrong)).toEqual({
    result: "banned",
  });

  const attempt = await t.run(async (ctx) =>
    ctx.db
      .query("accessAttempts")
      .withIndex("by_ip", (q) => q.eq("ip", IP))
      .unique(),
  );
  expect(attempt?.failures).toBe(3);
  expect(attempt?.bannedAt).toEqual(expect.any(Number));

  // The ban is checked before the password, so even the right one bounces.
  expect(
    await asUser.mutation(internal.access.attemptRedeem, {
      ip: IP,
      password: PASSWORD,
    }),
  ).toEqual({ result: "banned" });
});

test("attemptRedeem grants access and clears the attempt row", async () => {
  const { t, userId, asUser } = await signedIn();
  await asUser.mutation(internal.access.attemptRedeem, {
    ip: IP,
    password: "nope",
  });

  expect(
    await asUser.mutation(internal.access.attemptRedeem, {
      ip: IP,
      password: PASSWORD,
    }),
  ).toEqual({ result: "ok" });

  const attempts = await t.run(async (ctx) =>
    ctx.db.query("accessAttempts").collect(),
  );
  expect(attempts).toHaveLength(0);
  expect(
    await t.query(internal.access.hasAccessInternal, { userId }),
  ).toBe(true);
  // Signed-in redeem writes the user flag; no leftover ticket.
  expect(
    await t.run(async (ctx) => ctx.db.query("accessGrants").collect()),
  ).toHaveLength(0);
});

test("hasAccessInternal is false before the password is redeemed", async () => {
  const { t, userId } = await signedIn();
  expect(
    await t.query(internal.access.hasAccessInternal, { userId }),
  ).toBe(false);
});

test("a ban lifts on its own once it has served its time", async () => {
  const { t, asUser } = await signedIn();
  for (let attempt = 0; attempt < 3; attempt++) {
    await asUser.mutation(internal.access.attemptRedeem, {
      ip: IP,
      password: "wrong",
    });
  }
  expect(
    await asUser.mutation(internal.access.attemptRedeem, {
      ip: IP,
      password: PASSWORD,
    }),
  ).toEqual({ result: "banned" });

  // Reach back past the ban window rather than waiting a day for it.
  await t.run(async (ctx) => {
    const row = await ctx.db
      .query("accessAttempts")
      .withIndex("by_ip", (q) => q.eq("ip", IP))
      .unique();
    await ctx.db.patch(row!._id, {
      bannedAt: Date.now() - 25 * 60 * 60 * 1000,
    });
  });

  expect(
    await asUser.mutation(internal.access.attemptRedeem, {
      ip: IP,
      password: PASSWORD,
    }),
  ).toEqual({ result: "ok" });
});

test("an expired ban starts the count again rather than re-banning at once", async () => {
  const { t, asUser } = await signedIn();
  for (let attempt = 0; attempt < 3; attempt++) {
    await asUser.mutation(internal.access.attemptRedeem, {
      ip: IP,
      password: "wrong",
    });
  }
  await t.run(async (ctx) => {
    const row = await ctx.db
      .query("accessAttempts")
      .withIndex("by_ip", (q) => q.eq("ip", IP))
      .unique();
    await ctx.db.patch(row!._id, {
      bannedAt: Date.now() - 25 * 60 * 60 * 1000,
    });
  });

  // One wrong guess after the expiry is one wrong guess, not the fourth.
  expect(
    await asUser.mutation(internal.access.attemptRedeem, {
      ip: IP,
      password: "wrong",
    }),
  ).toEqual({ result: "wrong" });
  const row = await t.run(async (ctx) =>
    ctx.db
      .query("accessAttempts")
      .withIndex("by_ip", (q) => q.eq("ip", IP))
      .unique(),
  );
  expect(row?.failures).toBe(1);
  expect(row?.bannedAt).toBeUndefined();
});

test("claimGrant binds a ticket onto the signed-in user once", async () => {
  const { t, userId, asUser } = await signedIn();
  const issued = await t.mutation(internal.access.attemptRedeem, {
    ip: IP,
    password: PASSWORD,
  });
  if (issued.result !== "ok" || issued.grant === undefined) {
    throw new Error("expected a grant ticket");
  }

  expect(await asUser.mutation(api.access.claimGrant, { token: issued.grant })).toEqual({
    result: "ok",
  });
  expect(
    await t.query(internal.access.hasAccessInternal, { userId }),
  ).toBe(true);
  expect(
    await t.run(async (ctx) => ctx.db.query("accessGrants").collect()),
  ).toHaveLength(0);

  // Spent tickets do not unlock a second account.
  const otherId = await t.run(async (ctx) =>
    ctx.db.insert("users", { email: "other@example.com" }),
  );
  const asOther = t.withIdentity({ subject: `${otherId}|session2` });
  expect(
    await asOther.mutation(api.access.claimGrant, { token: issued.grant }),
  ).toEqual({ result: "invalid" });
  expect(
    await t.query(internal.access.hasAccessInternal, { userId: otherId }),
  ).toBe(false);
});

test("claimGrant is a no-op when the user is already unlocked", async () => {
  const { t, asUser } = await signedIn();
  await asUser.mutation(internal.access.attemptRedeem, {
    ip: IP,
    password: PASSWORD,
  });
  const leftover = await t.mutation(internal.access.attemptRedeem, {
    ip: "198.51.100.9",
    password: PASSWORD,
  });
  if (leftover.result !== "ok" || leftover.grant === undefined) {
    throw new Error("expected a grant ticket");
  }

  expect(
    await asUser.mutation(api.access.claimGrant, { token: leftover.grant }),
  ).toEqual({ result: "ok" });
  // Already-granted callers must not consume a ticket someone else could use.
  expect(
    await t.run(async (ctx) => ctx.db.query("accessGrants").collect()),
  ).toHaveLength(1);
});

test("claimGrant rejects a caller who is not signed in", async () => {
  const t = convexTest(schema, modules);
  expect(await t.mutation(api.access.claimGrant, { token: "nope" })).toEqual({
    result: "unauthenticated",
  });
});

test("claimGrant rejects an expired ticket", async () => {
  const { t, userId, asUser } = await signedIn();
  const issued = await t.mutation(internal.access.attemptRedeem, {
    ip: IP,
    password: PASSWORD,
  });
  if (issued.result !== "ok" || issued.grant === undefined) {
    throw new Error("expected a grant ticket");
  }
  await t.run(async (ctx) => {
    const grant = await ctx.db
      .query("accessGrants")
      .withIndex("by_token", (q) => q.eq("token", issued.grant!))
      .unique();
    await ctx.db.patch(grant!._id, { expiresAt: Date.now() - 1 });
  });

  expect(
    await asUser.mutation(api.access.claimGrant, { token: issued.grant }),
  ).toEqual({ result: "invalid" });
  expect(
    await t.query(internal.access.hasAccessInternal, { userId }),
  ).toBe(false);
});

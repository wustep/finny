/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test } from "vitest";
import { internal } from "./_generated/api";
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

test("attemptRedeem rejects a caller who is not signed in", async () => {
  const t = convexTest(schema, modules);
  const result = await t.mutation(internal.access.attemptRedeem, {
    ip: IP,
    password: PASSWORD,
  });
  expect(result).toBe("unauthenticated");
  // A signed-out caller must not be able to burn attempts for its IP.
  const attempts = await t.run(async (ctx) =>
    ctx.db.query("accessAttempts").collect(),
  );
  expect(attempts).toHaveLength(0);
});

test("attemptRedeem reports unconfigured when ACCESS_PASSWORD is unset", async () => {
  delete process.env.ACCESS_PASSWORD;
  const { asUser } = await signedIn();
  const result = await asUser.mutation(internal.access.attemptRedeem, {
    ip: IP,
    password: "anything",
  });
  expect(result).toBe("unconfigured");
});

test("attemptRedeem counts a wrong password against the IP", async () => {
  const { t, asUser } = await signedIn();
  expect(
    await asUser.mutation(internal.access.attemptRedeem, {
      ip: IP,
      password: "nope",
    }),
  ).toBe("wrong");

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
  expect(await asUser.mutation(internal.access.attemptRedeem, wrong)).toBe(
    "wrong",
  );
  expect(await asUser.mutation(internal.access.attemptRedeem, wrong)).toBe(
    "wrong",
  );
  expect(await asUser.mutation(internal.access.attemptRedeem, wrong)).toBe(
    "banned",
  );

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
  ).toBe("banned");
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
  ).toBe("ok");

  const attempts = await t.run(async (ctx) =>
    ctx.db.query("accessAttempts").collect(),
  );
  expect(attempts).toHaveLength(0);
  expect(
    await t.query(internal.access.hasAccessInternal, { userId }),
  ).toBe(true);
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
  ).toBe("banned");

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
  ).toBe("ok");
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
  ).toBe("wrong");
  const row = await t.run(async (ctx) =>
    ctx.db
      .query("accessAttempts")
      .withIndex("by_ip", (q) => q.eq("ip", IP))
      .unique(),
  );
  expect(row?.failures).toBe(1);
  expect(row?.bannedAt).toBeUndefined();
});

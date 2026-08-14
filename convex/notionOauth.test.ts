/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "./_generated/api";
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

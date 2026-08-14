/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

type Seeded = {
  userId: Id<"users">;
  connectionId: Id<"bankConnections">;
};

// One of everything the app can hold for a user, including Convex Auth's own
// rows, so a purge that misses a table fails a count somewhere below.
async function seed(
  t: ReturnType<typeof convexTest>,
  email: string,
): Promise<Seeded> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      email,
      accessGrantedAt: Date.now(),
    });
    const connectionId = await ctx.db.insert("bankConnections", {
      userId,
      plaidItemId: `item-${email}`,
      accessToken: `access-${email}`,
      institutionName: "Some Bank",
      status: "active",
    });
    await ctx.db.insert("accounts", {
      userId,
      connectionId,
      plaidAccountId: `acct-${email}`,
      name: "Checking",
      type: "depository",
      syncEnabled: true,
    });
    await ctx.db.insert("notionConnections", {
      userId,
      accessToken: `notion-${email}`,
      workspaceId: `ws-${email}`,
      botId: `bot-${email}`,
      modules: { balances: true, spending: true, investments: true },
    });
    await ctx.db.insert("notionPageMap", {
      userId,
      kind: "transaction",
      providerId: `txn-${email}`,
      notionPageId: `page-${email}`,
    });
    await ctx.db.insert("syncRuns", {
      userId,
      connectionId,
      trigger: "manual",
      status: "success",
      startedAt: Date.now(),
    });
    await ctx.db.insert("notionOauthStates", {
      userId,
      state: `state-${email}`,
      createdAt: Date.now(),
    });

    const sessionId = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 60_000,
    });
    await ctx.db.insert("authRefreshTokens", {
      sessionId,
      expirationTime: Date.now() + 60_000,
    });
    const authAccountId = await ctx.db.insert("authAccounts", {
      userId,
      provider: "google",
      providerAccountId: email,
    });
    await ctx.db.insert("authVerificationCodes", {
      accountId: authAccountId,
      provider: "google",
      code: `code-${email}`,
      expirationTime: Date.now() + 60_000,
    });

    return { userId, connectionId };
  });
}

// Every table the purge is responsible for, counted for one user.
async function countsFor(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
): Promise<Record<string, number>> {
  return await t.run(async (ctx) => {
    const own = <T extends { userId: Id<"users"> }>(rows: T[]) =>
      rows.filter((row) => row.userId === userId).length;
    const sessions = (await ctx.db.query("authSessions").collect()).filter(
      (session) => session.userId === userId,
    );
    const authAccounts = (await ctx.db.query("authAccounts").collect()).filter(
      (account) => account.userId === userId,
    );
    const sessionIds = new Set(sessions.map((session) => session._id));
    const authAccountIds = new Set(authAccounts.map((account) => account._id));
    return {
      user: (await ctx.db.get(userId)) === null ? 0 : 1,
      bankConnections: own(await ctx.db.query("bankConnections").collect()),
      accounts: own(await ctx.db.query("accounts").collect()),
      notionConnections: own(await ctx.db.query("notionConnections").collect()),
      notionPageMap: own(await ctx.db.query("notionPageMap").collect()),
      syncRuns: own(await ctx.db.query("syncRuns").collect()),
      notionOauthStates: own(
        await ctx.db.query("notionOauthStates").collect(),
      ),
      authSessions: sessions.length,
      authRefreshTokens: (
        await ctx.db.query("authRefreshTokens").collect()
      ).filter((token) => sessionIds.has(token.sessionId)).length,
      authAccounts: authAccounts.length,
      authVerificationCodes: (
        await ctx.db.query("authVerificationCodes").collect()
      ).filter((code) => authAccountIds.has(code.accountId)).length,
    };
  });
}

const SEEDED = {
  user: 1,
  bankConnections: 1,
  accounts: 1,
  notionConnections: 1,
  notionPageMap: 1,
  syncRuns: 1,
  notionOauthStates: 1,
  authSessions: 1,
  authRefreshTokens: 1,
  authAccounts: 1,
  authVerificationCodes: 1,
};

const PURGED = Object.fromEntries(
  Object.keys(SEEDED).map((table) => [table, 0]),
);

test("deleteAccount erases every row the account owns", async () => {
  const t = convexTest(schema, modules);
  const alice = await seed(t, "alice@example.com");
  expect(await countsFor(t, alice.userId)).toEqual(SEEDED);

  const result = await t
    .withIdentity({ subject: `${alice.userId}|session-alice` })
    .mutation(api.users.deleteAccount, {});

  expect(result).toEqual({ done: true });
  expect(await countsFor(t, alice.userId)).toEqual(PURGED);
});

test("deleteAccount leaves another user's data alone", async () => {
  const t = convexTest(schema, modules);
  const alice = await seed(t, "alice@example.com");
  const bob = await seed(t, "bob@example.com");

  await t
    .withIdentity({ subject: `${alice.userId}|session-alice` })
    .mutation(api.users.deleteAccount, {});

  expect(await countsFor(t, alice.userId)).toEqual(PURGED);
  expect(await countsFor(t, bob.userId)).toEqual(SEEDED);
});

test("deleteAccount refuses a caller who is not signed in", async () => {
  const t = convexTest(schema, modules);
  const alice = await seed(t, "alice@example.com");

  await expect(t.mutation(api.users.deleteAccount, {})).rejects.toThrow(
    "Not signed in",
  );
  expect(await countsFor(t, alice.userId)).toEqual(SEEDED);
});

// A user with a long history has more page-map rows than one transaction may
// delete. The first pass has to leave the user document behind and hand the
// rest to a scheduled continuation.
test("deleteAccount finishes a large history across scheduled passes", async () => {
  const t = convexTest(schema, modules);
  const alice = await seed(t, "alice@example.com");
  const bob = await seed(t, "bob@example.com");
  await t.run(async (ctx) => {
    for (let index = 0; index < 450; index++) {
      await ctx.db.insert("notionPageMap", {
        userId: alice.userId,
        kind: "transaction",
        providerId: `bulk-${index}`,
        notionPageId: `page-${index}`,
      });
    }
  });

  const result = await t
    .withIdentity({ subject: `${alice.userId}|session-alice` })
    .mutation(api.users.deleteAccount, {});

  expect(result).toEqual({ done: false });
  // Still there, and that is the point: while rows remain, so does the row
  // that says whose they are.
  expect((await countsFor(t, alice.userId)).user).toBe(1);

  vi.useFakeTimers();
  try {
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  } finally {
    vi.useRealTimers();
  }

  expect(await countsFor(t, alice.userId)).toEqual(PURGED);
  expect(await countsFor(t, bob.userId)).toEqual(SEEDED);
});

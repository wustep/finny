/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

// Rows one reconciliation page reads (syncData.RECONCILE_BATCH). Mirrored
// here so the fixtures below are deliberately bigger than one page.
const RECONCILE_BATCH = 200;

// Rows one backfill pass patches (syncData.BACKFILL_BATCH), same idea.
const BACKFILL_BATCH = 200;

type Seeded = {
  userId: Id<"users">;
  connectionId: Id<"bankConnections">;
  runId: Id<"syncRuns">;
  staleRunId: Id<"syncRuns">;
};

async function seed(t: ReturnType<typeof convexTest>): Promise<Seeded> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      email: "investor@example.com",
      accessGrantedAt: Date.now(),
    });
    const connectionId = await ctx.db.insert("bankConnections", {
      userId,
      plaidItemId: "item-1",
      accessToken: "access-1",
      institutionName: "Brokerage",
      status: "active",
    });
    for (const plaidAccountId of ["acct-a", "acct-b"]) {
      await ctx.db.insert("accounts", {
        userId,
        connectionId,
        plaidAccountId,
        name: plaidAccountId,
        type: "investment",
        syncEnabled: true,
      });
    }
    const runId = await ctx.db.insert("syncRuns", {
      userId,
      connectionId,
      trigger: "cron",
      status: "running",
      startedAt: Date.now(),
    });
    const staleRunId = await ctx.db.insert("syncRuns", {
      userId,
      connectionId,
      trigger: "cron",
      status: "success",
      startedAt: Date.now() - 86_400_000,
    });
    return { userId, connectionId, runId, staleRunId };
  });
}

// Walk one account the way reconcileInvestmentTransactions does: a page at a
// time, resuming from the providerId the last page ended on. Returns the
// vanished rows plus how many pages it took, so a test can prove the walk
// really did continue rather than getting everything in one read.
async function walkAccount(
  t: ReturnType<typeof convexTest>,
  args: { userId: Id<"users">; runId: Id<"syncRuns">; accountId: string },
): Promise<{ providerIds: string[]; pages: number; maxPage: number }> {
  const providerIds: string[] = [];
  let after: string | undefined = undefined;
  let pages = 0;
  let maxPage = 0;
  do {
    // Annotated because the inferred type flows back into `after`, which this
    // call's own arguments read.
    const page: {
      vanished: Array<{ providerId: string; notionPageId: string }>;
      nextProviderId: string | null;
    } = await t.query(
      internal.syncData.getVanishedInvestmentTransactions,
      { ...args, afterProviderId: after },
    );
    pages++;
    maxPage = Math.max(maxPage, page.vanished.length);
    providerIds.push(...page.vanished.map((row) => row.providerId));
    after = page.nextProviderId ?? undefined;
  } while (after !== undefined);
  return { providerIds, pages, maxPage };
}

const providerId = (prefix: string, index: number) =>
  `${prefix}-${String(index).padStart(4, "0")}`;

test("vanished investment transactions are found across continuation pages", async () => {
  const t = convexTest(schema, modules);
  const seeded = await seed(t);

  // More rows than one page, so a walk that stops after the first read misses
  // most of them. Every third row was seen by this run and must survive.
  const expected: string[] = [];
  await t.run(async (ctx) => {
    for (let index = 0; index < RECONCILE_BATCH * 2 + 50; index++) {
      const seen = index % 3 === 0;
      const key = providerId("a", index);
      await ctx.db.insert("notionPageMap", {
        userId: seeded.userId,
        kind: "investmentTransaction",
        providerId: key,
        notionPageId: `page-${key}`,
        accountId: "acct-a",
        lastSeenRunId: seen ? seeded.runId : seeded.staleRunId,
      });
      if (!seen) {
        expected.push(key);
      }
    }
    // An in-flight claim is not a page, so there is nothing to archive.
    await ctx.db.insert("notionPageMap", {
      userId: seeded.userId,
      kind: "investmentTransaction",
      providerId: providerId("a", 9998),
      notionPageId: "",
      accountId: "acct-a",
      claimedAt: Date.now(),
    });
  });

  const walk = await walkAccount(t, {
    userId: seeded.userId,
    runId: seeded.runId,
    accountId: "acct-a",
  });

  expect(walk.providerIds).toEqual(expected);
  expect(walk.pages).toBeGreaterThan(2);
  expect(walk.maxPage).toBeLessThanOrEqual(RECONCILE_BATCH);
});

test("rows with no account scope are never reported as vanished", async () => {
  const t = convexTest(schema, modules);
  const seeded = await seed(t);

  await t.run(async (ctx) => {
    // Legacy rows: written before accountId was tracked, so nothing can say
    // which connection they belong to.
    for (let index = 0; index < 5; index++) {
      await ctx.db.insert("notionPageMap", {
        userId: seeded.userId,
        kind: "investmentTransaction",
        providerId: providerId("legacy", index),
        notionPageId: `page-legacy-${index}`,
        lastSeenRunId: seeded.staleRunId,
      });
    }
    await ctx.db.insert("notionPageMap", {
      userId: seeded.userId,
      kind: "investmentTransaction",
      providerId: providerId("a", 0),
      notionPageId: "page-a-0",
      accountId: "acct-a",
      lastSeenRunId: seeded.staleRunId,
    });
  });

  const walk = await walkAccount(t, {
    userId: seeded.userId,
    runId: seeded.runId,
    accountId: "acct-a",
  });
  expect(walk.providerIds).toEqual([providerId("a", 0)]);

  // They are counted, though, so a run can say what it is leaving behind.
  expect(
    await t.query(internal.syncData.countUnscopedInvestmentTransactions, {
      userId: seeded.userId,
    }),
  ).toEqual({ count: 5, more: false });
});

test("a walk of one account leaves another account's rows alone", async () => {
  const t = convexTest(schema, modules);
  const seeded = await seed(t);
  const other = await t.run(async (ctx) =>
    ctx.db.insert("users", { email: "someone-else@example.com" }),
  );

  await t.run(async (ctx) => {
    for (const [userId, accountId, key] of [
      [seeded.userId, "acct-a", providerId("a", 0)],
      [seeded.userId, "acct-b", providerId("b", 0)],
      [other, "acct-a", providerId("other", 0)],
    ] as const) {
      await ctx.db.insert("notionPageMap", {
        userId,
        kind: "investmentTransaction",
        providerId: key,
        notionPageId: `page-${key}`,
        accountId,
        lastSeenRunId: seeded.staleRunId,
      });
    }
  });

  const a = await walkAccount(t, {
    userId: seeded.userId,
    runId: seeded.runId,
    accountId: "acct-a",
  });
  const b = await walkAccount(t, {
    userId: seeded.userId,
    runId: seeded.runId,
    accountId: "acct-b",
  });

  expect(a.providerIds).toEqual([providerId("a", 0)]);
  expect(b.providerIds).toEqual([providerId("b", 0)]);
});

test("getAllMapEntries refuses the kinds that grow with history", async () => {
  const t = convexTest(schema, modules);
  const seeded = await seed(t);

  for (const kind of ["transaction", "investmentTransaction", "balanceSnapshot"] as const) {
    await expect(
      t.query(internal.syncData.getAllMapEntries, {
        userId: seeded.userId,
        kind,
      }),
    ).rejects.toThrow("not safe for kind");
  }
  // The bounded kinds still work.
  expect(
    await t.query(internal.syncData.getAllMapEntries, {
      userId: seeded.userId,
      kind: "category",
    }),
  ).toEqual({});
});

// providerId -> accountId for every map row of a user, so a test can assert on
// what the backfill did and did not scope.
async function scopesFor(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
): Promise<Record<string, string | null>> {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query("notionPageMap").collect();
    return Object.fromEntries(
      rows
        .filter((row) => row.userId === userId)
        .map((row) => [row.providerId, row.accountId ?? null]),
    );
  });
}

test("backfillMapScopes scopes the rows whose keys say where they belong", async () => {
  const t = convexTest(schema, modules);
  const seeded = await seed(t);

  await t.run(async (ctx) => {
    const insert = (
      kind:
        | "account"
        | "holding"
        | "balanceSnapshot"
        | "transaction"
        | "investmentTransaction"
        | "category",
      providerId: string,
      accountId?: string,
    ) =>
      ctx.db.insert("notionPageMap", {
        userId: seeded.userId,
        kind,
        providerId,
        notionPageId: `page-${providerId}`,
        accountId,
      });

    await insert("account", "acct-a");
    // A Plaid account this user does not have: nothing may invent a scope for
    // it, or reconciliation would start archiving from it.
    await insert("account", "acct-gone");
    await insert("holding", "acct-b|sec-1");
    await insert("holding", "malformed-no-separator");
    await insert("balanceSnapshot", "acct-a|2026-08-13");
    // Opaque Plaid ids: no account in the key, and Finny stores nothing to
    // look them up against.
    await insert("transaction", "txn-opaque");
    await insert("investmentTransaction", "inv-opaque");
    await insert("category", "FOOD_AND_DRINK_COFFEE");
    // Already scoped, including to an account that no longer exists: the
    // backfill must not second-guess a row a sync wrote.
    await insert("holding", "acct-b|sec-2", "acct-stale");
  });

  const result = await t.mutation(internal.syncData.backfillMapScopes, {});
  expect(result).toMatchObject({ done: true, scoped: 3 });

  expect(await scopesFor(t, seeded.userId)).toEqual({
    "acct-a": "acct-a",
    "acct-gone": null,
    "acct-b|sec-1": "acct-b",
    "malformed-no-separator": null,
    "acct-a|2026-08-13": "acct-a",
    "txn-opaque": null,
    "inv-opaque": null,
    FOOD_AND_DRINK_COFFEE: null,
    "acct-b|sec-2": "acct-stale",
  });

  // Idempotent: a second run finds nothing left to do.
  expect(
    await t.mutation(internal.syncData.backfillMapScopes, {}),
  ).toMatchObject({ done: true, scoped: 0 });
});

test("backfillMapScopes finishes a large map across scheduled passes", async () => {
  const t = convexTest(schema, modules);
  const seeded = await seed(t);
  const TOTAL = BACKFILL_BATCH * 2 + 30;
  await t.run(async (ctx) => {
    for (let index = 0; index < TOTAL; index++) {
      await ctx.db.insert("notionPageMap", {
        userId: seeded.userId,
        kind: "holding",
        providerId: `acct-a|sec-${index}`,
        notionPageId: `page-${index}`,
      });
    }
  });

  const first = await t.mutation(internal.syncData.backfillMapScopes, {});
  expect(first).toMatchObject({
    done: false,
    scanned: BACKFILL_BATCH,
    scoped: BACKFILL_BATCH,
  });

  vi.useFakeTimers();
  try {
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  } finally {
    vi.useRealTimers();
  }

  const scopes = await scopesFor(t, seeded.userId);
  expect(Object.keys(scopes)).toHaveLength(TOTAL);
  expect(Object.values(scopes).every((accountId) => accountId === "acct-a")).toBe(
    true,
  );

  // And what it scoped is now reconcilable through the account-scoped index.
  const holdings = await t.query(internal.syncData.getAccountMapEntries, {
    userId: seeded.userId,
    kind: "holding",
    accountId: "acct-a",
  });
  expect(Object.keys(holdings)).toHaveLength(TOTAL);
});

test("the daily sweep schedules every connection across batched passes", async () => {
  const t = convexTest(schema, modules);
  const seeded = await seed(t);
  const TOTAL = 120;
  await t.run(async (ctx) => {
    for (let index = 1; index < TOTAL; index++) {
      await ctx.db.insert("bankConnections", {
        userId: seeded.userId,
        plaidItemId: `item-${index}`,
        accessToken: `access-${index}`,
        institutionName: "Brokerage",
        status: "active",
      });
    }
  });

  await t.mutation(internal.syncData.sweep, {});

  const scheduled = await t.run(async (ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  const syncs = scheduled.filter((job) => job.name.includes("runForConnection"));
  const continuations = scheduled.filter((job) => job.name.includes("sweep"));
  // One pass takes a bounded bite and hands the rest to itself.
  expect(syncs.length).toBe(100);
  expect(continuations.length).toBe(1);
  // The stagger carries into the continuation rather than restarting at zero.
  expect(continuations[0].args[0]).toMatchObject({ delayMs: 100 * 15 * 1000 });
});

// convex-test keeps _creationTime monotonically increasing per test, so a row
// can only be given an old one if nothing has been inserted since. Every
// fixture below therefore starts in the past and works forwards.
async function atTime<T>(when: number, work: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  vi.setSystemTime(when);
  try {
    return await work();
  } finally {
    vi.useRealTimers();
  }
}

test("pruneHistory drops finished runs past retention and keeps live ones", async () => {
  const t = convexTest(schema, modules);
  const OLD = Date.now() - 31 * 24 * 60 * 60 * 1000;

  const old = await atTime(OLD, async () =>
    t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "old@example.com" });
      const finished = await ctx.db.insert("syncRuns", {
        userId,
        trigger: "cron",
        status: "success",
        startedAt: OLD,
        finishedAt: OLD,
      });
      // Still claiming to run. Whether that is a corpse is sweepStuckRuns'
      // call, not this one's, however old the row is.
      const running = await ctx.db.insert("syncRuns", {
        userId,
        trigger: "cron",
        status: "running",
        startedAt: OLD,
      });
      return { userId, finished, running };
    }),
  );

  const recent = await t.run(async (ctx) =>
    ctx.db.insert("syncRuns", {
      userId: old.userId,
      trigger: "manual",
      status: "success",
      startedAt: Date.now(),
      finishedAt: Date.now(),
    }),
  );

  expect(await t.mutation(internal.syncData.pruneHistory, {})).toMatchObject({
    runs: 1,
  });

  const left = await t.run(async (ctx) =>
    ctx.db
      .query("syncRuns")
      .withIndex("by_user", (q) => q.eq("userId", old.userId))
      .collect(),
  );
  expect(left.map((run) => run._id).sort()).toEqual(
    [old.running, recent].sort(),
  );
});

test("pruneHistory clears OAuth states left behind by abandoned flows", async () => {
  const t = convexTest(schema, modules);

  const userId = await atTime(Date.now() - 2 * 60 * 60 * 1000, async () =>
    t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        email: "abandoned@example.com",
      });
      await ctx.db.insert("notionOauthStates", {
        userId,
        state: "abandoned",
        createdAt: Date.now(),
      });
      return userId;
    }),
  );

  await t.run(async (ctx) => {
    await ctx.db.insert("notionOauthStates", {
      userId,
      state: "in-flight",
      createdAt: Date.now(),
    });
  });

  expect(await t.mutation(internal.syncData.pruneHistory, {})).toMatchObject({
    oauthStates: 1,
  });

  const left = await t.run(async (ctx) =>
    ctx.db.query("notionOauthStates").collect(),
  );
  expect(left.map((row) => row.state)).toEqual(["in-flight"]);
});

test("pruneHistory drops balance snapshot page ids for days gone by", async () => {
  const t = convexTest(schema, modules);
  const OLD = Date.now() - 91 * 24 * 60 * 60 * 1000;

  const userId = await atTime(OLD, async () =>
    t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "saver@example.com" });
      await ctx.db.insert("notionPageMap", {
        userId,
        kind: "balanceSnapshot",
        providerId: "acct-a|2026-05-01",
        notionPageId: "page-old",
        accountId: "acct-a",
      });
      // Only the snapshot kind is prunable: a transaction id can come back
      // from Plaid at any time, so its mapping has to outlive the row's age.
      await ctx.db.insert("notionPageMap", {
        userId,
        kind: "transaction",
        providerId: "txn-old",
        notionPageId: "page-txn",
        accountId: "acct-a",
      });
      return userId;
    }),
  );

  await t.run(async (ctx) => {
    await ctx.db.insert("notionPageMap", {
      userId,
      kind: "balanceSnapshot",
      providerId: "acct-a|2026-08-15",
      notionPageId: "page-today",
      accountId: "acct-a",
    });
  });

  expect(await t.mutation(internal.syncData.pruneHistory, {})).toMatchObject({
    balanceSnapshots: 1,
  });

  const left = await t.run(async (ctx) =>
    ctx.db.query("notionPageMap").collect(),
  );
  expect(left.map((row) => row.notionPageId).sort()).toEqual([
    "page-today",
    "page-txn",
  ]);
});

test("pruneHistory forgets a quiet access attempt but keeps a live one", async () => {
  const t = convexTest(schema, modules);
  const DAY = 24 * 60 * 60 * 1000;

  await atTime(Date.now() - 2 * DAY, async () =>
    t.run(async (ctx) => {
      await ctx.db.insert("accessAttempts", {
        ip: "quiet",
        failures: 3,
        lastAttemptAt: Date.now(),
        bannedAt: Date.now(),
      });
      // Same age, still being tried against — creation time alone would drop
      // it, which is why the check is on lastAttemptAt.
      await ctx.db.insert("accessAttempts", {
        ip: "persistent",
        failures: 3,
        lastAttemptAt: Date.now(),
        bannedAt: Date.now(),
      });
    }),
  );
  await t.run(async (ctx) => {
    const persistent = await ctx.db
      .query("accessAttempts")
      .withIndex("by_ip", (q) => q.eq("ip", "persistent"))
      .unique();
    await ctx.db.patch(persistent!._id, { lastAttemptAt: Date.now() });
  });

  expect(await t.mutation(internal.syncData.pruneHistory, {})).toMatchObject({
    accessAttempts: 1,
  });

  const left = await t.run(async (ctx) =>
    ctx.db.query("accessAttempts").collect(),
  );
  expect(left.map((row) => row.ip)).toEqual(["persistent"]);
});

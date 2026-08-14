/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

// Rows one reconciliation page reads (syncData.RECONCILE_BATCH). Mirrored
// here so the fixtures below are deliberately bigger than one page.
const RECONCILE_BATCH = 200;

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

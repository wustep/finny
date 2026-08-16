import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { claimAndCreatePage } from "./syncPages";
import { fakeCtx, fakeNotion, type FakeNotion } from "./syncTestCtx";

const USER = "user-1" as any;
let notion: FakeNotion;
const realFetch = globalThis.fetch;

beforeEach(() => {
  notion = fakeNotion();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

// Claim, create, map — in that order, always. Creating first and mapping
// afterwards is the bug this protocol exists to prevent: a crash in between
// leaves a Notion row nothing points at, and the retry makes a second one.
function claiming(
  claims: Array<{ status: string; notionPageId?: string; reclaimed?: boolean }>,
) {
  let index = 0;
  return fakeCtx({
    "syncData:claimMapEntry": () => claims[Math.min(index++, claims.length - 1)],
    "syncData:putMapEntries": () => null,
    "syncData:deleteMapEntries": () => null,
  });
}

test("a fresh key is claimed, then created, then mapped — in that order", async () => {
  notion.reply("/pages", { id: "page-new" });
  const fake = claiming([{ status: "create", reclaimed: false }]);

  const result = await claimAndCreatePage(fake.ctx, {
    userId: USER,
    kind: "transaction",
    providerId: "txn-1",
    token: "tok",
    databaseId: "db-1",
    properties: { Name: "x" },
  });

  expect(result).toEqual({ pageId: "page-new", created: true });
  expect(fake.names()).toEqual([
    "syncData:claimMapEntry",
    "syncData:putMapEntries",
  ]);
  // The map is written with the id the create returned, not before it.
  expect(fake.calls[1].args.entries).toEqual([
    { providerId: "txn-1", notionPageId: "page-new", accountId: undefined },
  ]);
});

test("a key that already has a page creates nothing", async () => {
  const fake = claiming([{ status: "ready", notionPageId: "page-old" }]);

  const result = await claimAndCreatePage(fake.ctx, {
    userId: USER,
    kind: "transaction",
    providerId: "txn-1",
    token: "tok",
    databaseId: "db-1",
    properties: {},
  });

  expect(result).toEqual({ pageId: "page-old", created: false });
  expect(notion.requests).toEqual([]);
});

test("a reclaimed claim looks for the page the dead attempt may have left", async () => {
  // The previous holder may have created the row and died before mapping it.
  // Adopting it is the difference between one Notion row and two.
  notion.reply("/query", { results: [{ id: "page-orphan" }] });
  const fake = claiming([{ status: "create", reclaimed: true }]);

  const result = await claimAndCreatePage(fake.ctx, {
    userId: USER,
    kind: "transaction",
    providerId: "txn-1",
    token: "tok",
    databaseId: "db-1",
    properties: {},
  });

  expect(result).toEqual({ pageId: "page-orphan", created: false });
  expect(notion.requests.map((request) => request.path)).toEqual([
    "/databases/db-1/query",
  ]);
  // Searched by the provider id, which is what the ID column holds.
  expect(notion.requests[0].body.filter).toMatchObject({
    property: "ID",
    rich_text: { equals: "txn-1" },
  });
});

test("a first claim does not go looking, because there is nothing to find", async () => {
  // Notion's rate limit is the binding constraint on a backfill; the extra
  // query only earns its place where a duplicate is actually plausible.
  notion.reply("/pages", { id: "page-new" });
  const fake = claiming([{ status: "create", reclaimed: false }]);

  await claimAndCreatePage(fake.ctx, {
    userId: USER,
    kind: "transaction",
    providerId: "txn-1",
    token: "tok",
    databaseId: "db-1",
    properties: {},
  });

  expect(notion.requests.map((request) => request.path)).toEqual(["/pages"]);
});

test("alwaysAdopt looks even on a first claim", async () => {
  // Categories outlive the map — resetAndResync forgets them and they are
  // still in Notion — so for those the query is worth it every time.
  notion.reply("/query", { results: [{ id: "page-category" }] });
  const fake = claiming([{ status: "create", reclaimed: false }]);

  const result = await claimAndCreatePage(fake.ctx, {
    userId: USER,
    kind: "category",
    providerId: "FOOD_AND_DRINK_COFFEE",
    token: "tok",
    databaseId: "db-cat",
    properties: {},
    alwaysAdopt: true,
  });

  expect(result).toEqual({ pageId: "page-category", created: false });
});

test("a kind with no ID column never queries, and simply creates", async () => {
  // Holdings and balance snapshots are keyed on their title, so there is no
  // property to adopt by; the claim is the only thing between a retry and a
  // duplicate.
  notion.reply("/pages", { id: "page-holding" });
  const fake = claiming([{ status: "create", reclaimed: true }]);

  const result = await claimAndCreatePage(fake.ctx, {
    userId: USER,
    kind: "holding",
    providerId: "acct|sec",
    token: "tok",
    databaseId: "db-hold",
    properties: {},
  });

  expect(result).toEqual({ pageId: "page-holding", created: true });
  expect(notion.requests.map((request) => request.path)).toEqual(["/pages"]);
});

test("a failed create drops the claim so the next run retries", async () => {
  // Left in place, the claim would make every later attempt wait it out.
  notion.reply("/pages", { message: "Currency is not a property" }, 400);
  const fake = claiming([{ status: "create", reclaimed: false }]);

  await expect(
    claimAndCreatePage(fake.ctx, {
      userId: USER,
      kind: "transaction",
      providerId: "txn-1",
      token: "tok",
      databaseId: "db-1",
      properties: {},
    }),
  ).rejects.toThrow(/400/);

  expect(fake.names()).toEqual([
    "syncData:claimMapEntry",
    "syncData:deleteMapEntries",
  ]);
});

test("a claim someone else holds is waited on, then given up on", async () => {
  vi.useFakeTimers();
  const fake = claiming([{ status: "pending" }]);

  const pending = claimAndCreatePage(fake.ctx, {
    userId: USER,
    kind: "transaction",
    providerId: "txn-1",
    token: "tok",
    databaseId: "db-1",
    properties: {},
  });
  await vi.runAllTimersAsync();

  // Null rather than a duplicate: the caller counts it as a failed row, which
  // holds the Plaid cursor so the page is tried again.
  expect(await pending).toBeNull();
  expect(notion.requests).toEqual([]);
  expect(fake.names().filter((name) => name === "syncData:claimMapEntry")).toHaveLength(6);
});

test("a claim that resolves while waiting is picked up", async () => {
  vi.useFakeTimers();
  const fake = claiming([
    { status: "pending" },
    { status: "ready", notionPageId: "page-theirs" },
  ]);

  const pending = claimAndCreatePage(fake.ctx, {
    userId: USER,
    kind: "transaction",
    providerId: "txn-1",
    token: "tok",
    databaseId: "db-1",
    properties: {},
  });
  await vi.runAllTimersAsync();

  expect(await pending).toEqual({ pageId: "page-theirs", created: false });
  expect(notion.requests).toEqual([]);
});

import { afterEach, beforeEach, expect, test } from "vitest";
import type { Transaction } from "plaid";
import type { Rule } from "./rulesEngine";
import { upsertTransaction } from "./syncTransactionWriter";
import { fakeCtx, fakeNotion, type FakeNotion } from "./syncTestCtx";

const USER = "user-1" as any;
let notion: FakeNotion;
const realFetch = globalThis.fetch;

beforeEach(() => {
  notion = fakeNotion();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function txn(overrides: Partial<Transaction> = {}): Transaction {
  return {
    transaction_id: "txn-posted",
    account_id: "acct-1",
    name: "SQ *BLUE BOTTLE",
    merchant_name: "Blue Bottle Coffee",
    original_description: "SQ *BLUE BOTTLE COFFEE",
    amount: 6.25,
    date: "2026-08-14",
    pending: false,
    pending_transaction_id: null,
    personal_finance_category: {
      primary: "FOOD_AND_DRINK",
      detailed: "FOOD_AND_DRINK_COFFEE",
    },
    ...overrides,
  } as Transaction;
}

function writer(
  claims: Array<{ status: string; notionPageId?: string; reclaimed?: boolean }> = [
    { status: "create", reclaimed: false },
  ],
) {
  let index = 0;
  return fakeCtx({
    "syncData:claimMapEntry": () => claims[Math.min(index++, claims.length - 1)],
    "syncData:putMapEntries": () => null,
    "syncData:deleteMapEntries": () => null,
    "syncData:rekeyMapEntry": () => null,
  });
}

const noCategory = async () => null;

test("a transaction with no page yet is created and mapped", async () => {
  notion.reply("/pages", { id: "page-new" });
  const fake = writer();
  const txnPages: Record<string, string> = {};

  const result = await upsertTransaction(fake.ctx, {
    userId: USER,
    token: "tok",
    databaseId: "db",
    txn: txn(),
    accountPage: "page-acct",
    rules: [],
    ensureCategory: noCategory,
    txnPages,
  });

  expect(result).toBe("added");
  // The caller's map is updated in place, so a later row in the same page
  // sees it without another query.
  expect(txnPages["txn-posted"]).toBe("page-new");
});

test("a transaction that already has a page is updated, never created twice", async () => {
  const fake = writer();

  const result = await upsertTransaction(fake.ctx, {
    userId: USER,
    token: "tok",
    databaseId: "db",
    txn: txn(),
    accountPage: "page-acct",
    rules: [],
    ensureCategory: noCategory,
    txnPages: { "txn-posted": "page-existing" },
  });

  expect(result).toBe("modified");
  expect(notion.requests.map((request) => request.path)).toEqual([
    "/pages/page-existing",
  ]);
  expect(notion.requests[0].method).toBe("PATCH");
});

test("pending -> posted updates the pending row and re-keys it", async () => {
  // The single most expensive thing to get wrong here: creating a second page
  // when a pending transaction posts leaves the ledger double-counted.
  const fake = writer();
  const txnPages: Record<string, string> = { "txn-pending": "page-pending" };

  const result = await upsertTransaction(fake.ctx, {
    userId: USER,
    token: "tok",
    databaseId: "db",
    txn: txn({ pending_transaction_id: "txn-pending" }),
    accountPage: "page-acct",
    rules: [],
    ensureCategory: noCategory,
    txnPages,
  });

  expect(result).toBe("modified");
  expect(notion.requests.map((request) => request.path)).toEqual([
    "/pages/page-pending",
  ]);
  expect(fake.names()).toEqual(["syncData:rekeyMapEntry"]);
  expect(fake.calls[0].args).toMatchObject({
    fromProviderId: "txn-pending",
    toProviderId: "txn-posted",
  });
  // And the caller's map follows, so the pending id is not reused.
  expect(txnPages).toEqual({ "txn-posted": "page-pending" });
});

test("a posted transaction whose pending row was never mapped is created once", async () => {
  notion.reply("/pages", { id: "page-new" });
  const fake = writer();

  const result = await upsertTransaction(fake.ctx, {
    userId: USER,
    token: "tok",
    databaseId: "db",
    txn: txn({ pending_transaction_id: "txn-pending" }),
    accountPage: "page-acct",
    rules: [],
    ensureCategory: noCategory,
    txnPages: {},
  });

  expect(result).toBe("added");
  expect(fake.names()).toEqual([
    "syncData:claimMapEntry",
    "syncData:putMapEntries",
  ]);
});

const hideRule: Rule = {
  id: "rule-1",
  priority: 1,
  enabled: true,
  conditions: [
    { kind: "text", field: "merchant", op: "contains", values: ["blue bottle"] },
  ],
  actions: [{ kind: "hide" }],
};

test("a hidden transaction with no page writes nothing at all", async () => {
  const fake = writer();

  const result = await upsertTransaction(fake.ctx, {
    userId: USER,
    token: "tok",
    databaseId: "db",
    txn: txn(),
    accountPage: "page-acct",
    rules: [hideRule],
    ensureCategory: noCategory,
    txnPages: {},
  });

  expect(result).toBe("hidden");
  expect(notion.requests).toEqual([]);
  expect(fake.names()).toEqual([]);
});

test("a hidden transaction that already has a page is archived and unmapped", async () => {
  // Both halves matter: without the unmap, the next sync updates a row the
  // user asked to be gone.
  const fake = writer();
  const txnPages: Record<string, string> = { "txn-posted": "page-existing" };

  const result = await upsertTransaction(fake.ctx, {
    userId: USER,
    token: "tok",
    databaseId: "db",
    txn: txn(),
    accountPage: "page-acct",
    rules: [hideRule],
    ensureCategory: noCategory,
    txnPages,
  });

  expect(result).toBe("removed");
  expect(notion.requests[0]).toMatchObject({
    method: "PATCH",
    path: "/pages/page-existing",
    body: { archived: true },
  });
  expect(fake.names()).toEqual(["syncData:deleteMapEntries"]);
  expect(txnPages).toEqual({});
});

test("hiding follows a pending row to the page it made", async () => {
  const fake = writer();
  const txnPages: Record<string, string> = { "txn-pending": "page-pending" };

  const result = await upsertTransaction(fake.ctx, {
    userId: USER,
    token: "tok",
    databaseId: "db",
    txn: txn({ pending_transaction_id: "txn-pending" }),
    accountPage: "page-acct",
    rules: [hideRule],
    ensureCategory: noCategory,
    txnPages,
  });

  expect(result).toBe("removed");
  expect(notion.requests[0].path).toBe("/pages/page-pending");
  expect(txnPages).toEqual({});
});

test("a failed archive throws, so the row counts as failed and holds the cursor", async () => {
  notion.reply("/pages/page-existing", { message: "gone" }, 400);
  const fake = writer();

  await expect(
    upsertTransaction(fake.ctx, {
      userId: USER,
      token: "tok",
      databaseId: "db",
      txn: txn(),
      accountPage: "page-acct",
      rules: [hideRule],
      ensureCategory: noCategory,
      txnPages: { "txn-posted": "page-existing" },
    }),
  ).rejects.toThrow(/400/);
});

test("a rule's rename and property writes reach the page", async () => {
  notion.reply("/pages", { id: "page-new" });
  const fake = writer();

  await upsertTransaction(fake.ctx, {
    userId: USER,
    token: "tok",
    databaseId: "db",
    txn: txn(),
    accountPage: "page-acct",
    rules: [
      {
        ...hideRule,
        actions: [
          { kind: "rename", value: "Coffee" },
          {
            kind: "setProperty",
            property: "Review",
            value: { type: "select", option: "Treat" },
          },
          {
            kind: "setProperty",
            property: "Reviewed",
            value: { type: "checkbox", checked: true },
          },
        ],
      },
    ],
    ensureCategory: noCategory,
    txnPages: {},
  });

  const created = notion.requests.find((request) => request.path === "/pages");
  expect(created?.body.properties.Name.title[0].text.content).toBe("Coffee");
  // The user's own columns, written by name, in the shape Notion wants for
  // each type.
  expect(created?.body.properties.Review).toEqual({
    select: { name: "Treat" },
  });
  expect(created?.body.properties.Reviewed).toEqual({ checkbox: true });
});

test("a title format names the row when no rule renames it", async () => {
  notion.reply("/pages", { id: "page-new" });
  const fake = writer();

  await upsertTransaction(fake.ctx, {
    userId: USER,
    token: "tok",
    databaseId: "db",
    txn: txn(),
    accountPage: "page-acct",
    rules: [],
    ensureCategory: noCategory,
    txnPages: {},
    titleFormats: { transactions: "[{date}] {merchant}" },
  });

  const created = notion.requests.find((request) => request.path === "/pages");
  expect(created?.body.properties.Name.title[0].text.content).toBe(
    "[2026-08-14] Blue Bottle Coffee",
  );
});

test("a rule's rename beats the title format", async () => {
  // The specific case wins over the general one, which is the whole reason
  // formats and rules can coexist.
  notion.reply("/pages", { id: "page-new" });
  const fake = writer();

  await upsertTransaction(fake.ctx, {
    userId: USER,
    token: "tok",
    databaseId: "db",
    txn: txn(),
    accountPage: "page-acct",
    rules: [{ ...hideRule, actions: [{ kind: "rename", value: "Coffee" }] }],
    ensureCategory: noCategory,
    txnPages: {},
    titleFormats: { transactions: "[{date}] {merchant}" },
  });

  const created = notion.requests.find((request) => request.path === "/pages");
  expect(created?.body.properties.Name.title[0].text.content).toBe("Coffee");
});

test("a row a rule did not touch carries none of the user's columns", async () => {
  // Writing a property speculatively is a 400 for the whole row if the column
  // is not there, so nothing is written unless a rule asked for it.
  notion.reply("/pages", { id: "page-new" });
  const fake = writer();

  await upsertTransaction(fake.ctx, {
    userId: USER,
    token: "tok",
    databaseId: "db",
    txn: txn(),
    accountPage: "page-acct",
    rules: [],
    ensureCategory: noCategory,
    txnPages: {},
  });

  const created = notion.requests.find((request) => request.path === "/pages");
  expect(Object.keys(created!.body.properties).sort()).toEqual([
    "Account",
    "Amount",
    "Category",
    "Date",
    "ID",
    "Name",
    "Original Description",
    "Pending",
  ]);
});

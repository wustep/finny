import { expect, test } from "vitest";
import { classifyPlaidWebhook } from "./plaidWebhooks";

test("ITEM ERROR and USER_PERMISSION_REVOKED mark the connection broken", () => {
  expect(classifyPlaidWebhook("ITEM", "ERROR", "ITEM_LOGIN_REQUIRED")).toEqual({
    action: "item_status",
    status: "error",
    errorCode: "ITEM_LOGIN_REQUIRED",
  });
  expect(classifyPlaidWebhook("ITEM", "USER_PERMISSION_REVOKED")).toEqual({
    action: "item_status",
    status: "error",
    errorCode: "USER_PERMISSION_REVOKED",
  });
});

test("pending expiration and pending disconnect share the expiring status", () => {
  expect(classifyPlaidWebhook("ITEM", "PENDING_EXPIRATION")).toEqual({
    action: "item_status",
    status: "pending_expiration",
  });
  expect(classifyPlaidWebhook("ITEM", "PENDING_DISCONNECT")).toEqual({
    action: "item_status",
    status: "pending_expiration",
  });
});

test("LOGIN_REPAIRED clears the error", () => {
  expect(classifyPlaidWebhook("ITEM", "LOGIN_REPAIRED")).toEqual({
    action: "item_status",
    status: "active",
  });
});

test("account-level Item events schedule a sync rather than breaking the bank", () => {
  expect(classifyPlaidWebhook("ITEM", "NEW_ACCOUNTS_AVAILABLE")).toEqual({
    action: "sync",
  });
  expect(classifyPlaidWebhook("ITEM", "USER_ACCOUNT_REVOKED")).toEqual({
    action: "sync",
  });
});

test("transaction, investment, liability, and recurring updates schedule a sync", () => {
  for (const [type, code] of [
    ["TRANSACTIONS", "SYNC_UPDATES_AVAILABLE"],
    ["TRANSACTIONS", "INITIAL_UPDATE"],
    ["TRANSACTIONS", "HISTORICAL_UPDATE"],
    ["TRANSACTIONS", "DEFAULT_UPDATE"],
    ["TRANSACTIONS", "TRANSACTIONS_REMOVED"],
    ["TRANSACTIONS", "RECURRING_TRANSACTIONS_UPDATE"],
    ["HOLDINGS", "DEFAULT_UPDATE"],
    ["INVESTMENTS_TRANSACTIONS", "DEFAULT_UPDATE"],
    ["LIABILITIES", "DEFAULT_UPDATE"],
  ] as const) {
    expect(classifyPlaidWebhook(type, code), `${type} ${code}`).toEqual({
      action: "sync",
    });
  }
});

test("unknown or acknowledgement webhooks are ignored", () => {
  expect(classifyPlaidWebhook("ITEM", "WEBHOOK_UPDATE_ACKNOWLEDGED")).toEqual({
    action: "ignore",
  });
  expect(classifyPlaidWebhook("TRANSACTIONS", "SOMETHING_NEW")).toEqual({
    action: "ignore",
  });
  expect(classifyPlaidWebhook(undefined, undefined)).toEqual({
    action: "ignore",
  });
});

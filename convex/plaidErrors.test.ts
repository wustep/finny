import { expect, test } from "vitest";
import { plaidErrorInfo } from "./plaidClient";

// Shaped like what the plaid package throws: an axios error whose only useful
// part is the response body.
function plaidThrow(code: string, message = "something the bank said") {
  return {
    message: "Request failed with status code 400",
    response: { data: { error_code: code, error_message: message } },
  };
}

test("a Plaid failure reports its code and message rather than the status", () => {
  const info = plaidErrorInfo(plaidThrow("ITEM_LOGIN_REQUIRED", "the login details are no longer valid"));
  expect(info.code).toBe("ITEM_LOGIN_REQUIRED");
  expect(info.message).toBe(
    "Plaid ITEM_LOGIN_REQUIRED: the login details are no longer valid",
  );
  expect(info.message).not.toContain("status code");
});

test("codes that need the user mark the Item broken", () => {
  for (const code of [
    "ITEM_LOGIN_REQUIRED",
    "INVALID_CREDENTIALS",
    "USER_PERMISSION_REVOKED",
    "ITEM_LOCKED",
    "ACCESS_NOT_GRANTED",
  ]) {
    expect(plaidErrorInfo(plaidThrow(code)).itemBroken).toBe(true);
  }
});

test("codes that pass on their own do not", () => {
  // Sending someone to a reconnect flow fixes none of these, and marking the
  // connection broken would hide the banks that really are.
  for (const code of [
    "RATE_LIMIT_EXCEEDED",
    "INSTITUTION_DOWN",
    "INSTITUTION_NOT_RESPONDING",
    "INTERNAL_SERVER_ERROR",
    "PRODUCTS_NOT_READY",
    "PRODUCTS_NOT_SUPPORTED",
  ]) {
    expect(plaidErrorInfo(plaidThrow(code)).itemBroken).toBe(false);
  }
});

test("a non-Plaid failure keeps its own message and marks nothing", () => {
  const info = plaidErrorInfo(new Error("Notion API /pages failed (409)"));
  expect(info.code).toBeUndefined();
  expect(info.itemBroken).toBe(false);
  expect(info.message).toContain("Notion API /pages failed (409)");
});

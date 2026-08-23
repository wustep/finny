import { expect, test } from "vitest";
import { NotionApiError } from "./notionApi";
import { describeRunFailure } from "./syncRun";

test("a Notion 401 is not retryable and does not look like a broken bank", () => {
  const failure = describeRunFailure(
    "Transactions",
    new NotionApiError("/pages", 401, "API token is invalid."),
  );
  expect(failure.retryable).toBe(false);
  expect(failure.itemBroken).toBe(false);
  expect(failure.error).toContain("401");
  expect(failure.error).toContain("Reconnect Notion");
  expect(failure.error).toContain("cursor was left in place");
});

test("a Notion 502 is still worth retrying", () => {
  const failure = describeRunFailure(
    "Transactions",
    new NotionApiError("/pages", 502, "Bad gateway"),
  );
  expect(failure.retryable).toBe(true);
  expect(failure.itemBroken).toBe(false);
  expect(failure.error).toContain("502");
});

test("a broken Item stays the non-retryable Plaid case", () => {
  const failure = describeRunFailure("Transactions", {
    message: "Request failed with status code 400",
    response: {
      data: {
        error_code: "ITEM_LOGIN_REQUIRED",
        error_message: "the login details are no longer valid",
      },
    },
  });
  expect(failure.retryable).toBe(false);
  expect(failure.itemBroken).toBe(true);
  expect(failure.errorCode).toBe("ITEM_LOGIN_REQUIRED");
});

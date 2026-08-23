// What a verified Plaid webhook should do. Pure, so handleWebhook (node)
// and the tests share one table of type/code pairs.
//
// Plaid's ITEM ERROR webhook is not the only way an Item dies, and it is
// not the only webhook that means "run a sync". Codes added after the
// first handler — USER_PERMISSION_REVOKED, RECURRING_TRANSACTIONS_UPDATE,
// LIABILITIES DEFAULT_UPDATE — were arriving, being verified, and then
// ignored.

export type WebhookDisposition =
  | { action: "ignore" }
  | { action: "sync" }
  | { action: "sync_recurring" }
  | {
      action: "item_status";
      status: "error" | "pending_expiration" | "active";
      errorCode?: string;
    };

export function classifyPlaidWebhook(
  type: string | undefined,
  code: string | undefined,
  errorCode?: string,
): WebhookDisposition {
  if (type === "ITEM") {
    switch (code) {
      case "ERROR":
      case "USER_PERMISSION_REVOKED":
        return {
          action: "item_status",
          status: "error",
          errorCode: errorCode ?? code,
        };
      case "PENDING_EXPIRATION":
      // US/CA counterpart of PENDING_EXPIRATION (UK/EU). Same product
      // meaning: the Item is about to stop sharing, reconnect soon.
      case "PENDING_DISCONNECT":
        return { action: "item_status", status: "pending_expiration" };
      case "LOGIN_REPAIRED":
        return { action: "item_status", status: "active" };
      case "NEW_ACCOUNTS_AVAILABLE":
      // One account on a still-working Item (Chase today). A sync is
      // what notices it is gone; marking the whole connection broken
      // would hide the accounts that still work.
      case "USER_ACCOUNT_REVOKED":
        return { action: "sync" };
      default:
        return { action: "ignore" };
    }
  }

  if (
    (type === "TRANSACTIONS" &&
      (code === "SYNC_UPDATES_AVAILABLE" ||
        code === "INITIAL_UPDATE" ||
        code === "HISTORICAL_UPDATE" ||
        code === "DEFAULT_UPDATE" ||
        code === "TRANSACTIONS_REMOVED")) ||
    (type === "HOLDINGS" && code === "DEFAULT_UPDATE") ||
    (type === "INVESTMENTS_TRANSACTIONS" && code === "DEFAULT_UPDATE") ||
    (type === "LIABILITIES" && code === "DEFAULT_UPDATE")
  ) {
    return { action: "sync" };
  }

  // Recurring streams are tens of rows and do not consume the
  // transactions/sync cursor. A full run would walk that cursor and
  // investments before the Recurring database moved; this one writes
  // only the streams Plaid said changed.
  if (type === "TRANSACTIONS" && code === "RECURRING_TRANSACTIONS_UPDATE") {
    return { action: "sync_recurring" };
  }

  return { action: "ignore" };
}

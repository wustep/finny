import { expect, test } from "vitest";
import { connectionAlert, statusLabels } from "./connection-status";

test("a revoke names reconnect as the next step", () => {
  const alert = connectionAlert({
    status: "error",
    errorCode: "USER_PERMISSION_REVOKED",
  });
  expect(alert.title).toBe("This connection stopped working");
  expect(alert.detail).toMatch(/revoked/);
  expect(alert.nextStep).toMatch(/Reconnect/);
  expect(alert.button).toBe("Reconnect");
});

test("pending expiration still syncs and asks for a bank login", () => {
  const alert = connectionAlert({ status: "pending_expiration" });
  expect(statusLabels.pending_expiration).toBe("Expiring soon");
  expect(alert.title).toMatch(/soon/i);
  expect(alert.nextStep).toMatch(/Reconnect/);
  expect(alert.nextStep).toMatch(/bank/);
});

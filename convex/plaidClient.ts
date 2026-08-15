// Shared Plaid client factory. Only import from "use node" files.
import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";
import { env } from "./_generated/server";

export type PlaidEnv = "sandbox" | "production";

export function configuredPlaidEnv(): PlaidEnv {
  return env.PLAID_ENV === "production" ? "production" : "sandbox";
}

// Local development always talks to the Sandbox, even when the deployment
// is pointed at production, so testing never burns real Plaid Items (the
// Trial plan's 10-Item cap is a lifetime one). Requires
// PLAID_SANDBOX_SECRET; without it there's nothing to fall back to.
export function plaidEnvForOrigin(origin: string | undefined): PlaidEnv {
  if (configuredPlaidEnv() === "sandbox") {
    return "sandbox";
  }
  const isLocal = !!origin && /^https?:\/\/localhost(:\d+)?$/.test(origin);
  return isLocal && env.PLAID_SANDBOX_SECRET ? "sandbox" : "production";
}

// Access tokens are environment-specific, so every call for an existing
// connection must use the environment that connection was created in.
export function plaidClient(forEnv?: PlaidEnv) {
  const resolved = forEnv ?? configuredPlaidEnv();
  const clientId = env.PLAID_CLIENT_ID;
  const secret =
    resolved === "sandbox"
      ? (env.PLAID_SANDBOX_SECRET ?? env.PLAID_SECRET)
      : env.PLAID_SECRET;
  if (!clientId || !secret) {
    throw new Error("PLAID_CLIENT_ID / PLAID_SECRET not set — see README.md");
  }
  return new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments[resolved],
      baseOptions: {
        headers: { "PLAID-CLIENT-ID": clientId, "PLAID-SECRET": secret },
      },
    }),
  );
}

// Plaid's error codes that mean this Item needs the user, not another try.
// Anything else — a rate limit, an institution outage, a 5xx — is transient,
// and marking the connection broken over one would send the user to a
// reconnect flow that fixes nothing.
const ITEM_BROKEN_CODES: ReadonlySet<string> = new Set([
  "ITEM_LOGIN_REQUIRED",
  "ITEM_LOCKED",
  "ITEM_NOT_FOUND",
  "ITEM_NOT_SUPPORTED",
  "INVALID_CREDENTIALS",
  "INVALID_MFA",
  "INVALID_UPDATED_USERNAME",
  "INSUFFICIENT_CREDENTIALS",
  "USER_PERMISSION_REVOKED",
  "ACCESS_NOT_GRANTED",
]);

export interface PlaidErrorInfo {
  code?: string;
  // Already fit to show a user or write on a run row.
  message: string;
  // True when the connection should be marked broken so the app offers a
  // reconnect, rather than waiting for a webhook that may never come.
  itemBroken: boolean;
}

// Read Plaid's error body off a thrown axios error.
//
// Without this a failed Plaid call reaches a run row as
// "Error: Request failed with status code 400", which says nothing about
// which of the two dozen reasons it was. The body carries error_code and
// error_message; both only live on error.response.data.
export function plaidErrorInfo(error: any): PlaidErrorInfo {
  const body = error?.response?.data;
  const code: string | undefined = body?.error_code;
  const detail: string | undefined = body?.error_message;
  return {
    code,
    message: code
      ? `Plaid ${code}: ${detail ?? "no further detail"}`
      : `Plaid request failed: ${error?.message ?? String(error)}`,
    itemBroken: code !== undefined && ITEM_BROKEN_CODES.has(code),
  };
}

// Plaid's error body (error_code, error_message, ...) only lives on
// error.response.data — axios errors otherwise log as a bare status code.
// Wrap calls with this so Convex logs show the actual Plaid error.
export async function withPlaidError<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error: any) {
    const plaidError = error?.response?.data;
    if (plaidError) {
      console.error("Plaid API error:", JSON.stringify(plaidError));
      throw new Error(
        `Plaid error ${plaidError.error_code ?? "UNKNOWN"}: ${plaidError.error_message ?? error.message}`,
      );
    }
    throw error;
  }
}

// Shared Plaid client factory. Only import from "use node" files.
import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

export type PlaidEnv = "sandbox" | "production";

export function configuredPlaidEnv(): PlaidEnv {
  return process.env.PLAID_ENV === "production" ? "production" : "sandbox";
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
  return isLocal && process.env.PLAID_SANDBOX_SECRET ? "sandbox" : "production";
}

// Access tokens are environment-specific, so every call for an existing
// connection must use the environment that connection was created in.
export function plaidClient(env?: PlaidEnv) {
  const resolved = env ?? configuredPlaidEnv();
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret =
    resolved === "sandbox"
      ? (process.env.PLAID_SANDBOX_SECRET ?? process.env.PLAID_SECRET)
      : process.env.PLAID_SECRET;
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

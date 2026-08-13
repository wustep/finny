// Shared Plaid client factory. Only import from "use node" files.
import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

export function plaidClient() {
  const env = process.env.PLAID_ENV ?? "sandbox";
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  if (!clientId || !secret) {
    throw new Error("PLAID_CLIENT_ID / PLAID_SECRET not set — see README.md");
  }
  return new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments[env],
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

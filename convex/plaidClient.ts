// Shared Plaid client factory. Only import from "use node" files.
import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

export function plaidClient() {
  const env = process.env.PLAID_ENV ?? "sandbox";
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  if (!clientId || !secret) {
    throw new Error("PLAID_CLIENT_ID / PLAID_SECRET not set — see SETUP.md");
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

"use node";

import { createHash } from "node:crypto";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import { CountryCode, Products } from "plaid";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { action, internalAction, type ActionCtx } from "./_generated/server";
import { allowedOrigins } from "./origins";
import {
  plaidClient,
  plaidEnvForOrigin,
  withPlaidError,
  type PlaidEnv,
} from "./plaidClient";
import { classifyPlaidWebhook } from "./plaidWebhooks";

const WEBHOOK_URL = () => `${process.env.CONVEX_SITE_URL}/plaid/webhook`;

// OAuth institutions (Chase etc.) bounce the user to the bank and back to
// this app URL. Only used in production; the exact URIs must be registered
// in the Plaid dashboard under Allowed redirect URIs.
function oauthRedirectUri(
  origin: string | undefined,
  env: PlaidEnv,
): string | undefined {
  if (env !== "production") {
    return undefined;
  }
  if (!origin || !allowedOrigins().includes(origin)) {
    return undefined;
  }
  return `${origin}/plaid-oauth`;
}

// Actions that consume Plaid Items are gated behind the access password.
async function requireAccess(
  ctx: { runQuery: (ref: any, args: any) => Promise<any> },
  userId: string,
): Promise<void> {
  const ok = await ctx.runQuery(internal.access.hasAccessInternal, { userId });
  if (!ok) {
    throw new Error("Access password required");
  }
}

export const createLinkToken = action({
  args: { origin: v.optional(v.string()) },
  handler: async (ctx, args): Promise<string> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not signed in");
    }
    await requireAccess(ctx, userId);
    const env = plaidEnvForOrigin(args.origin);
    const client = plaidClient(env);
    const response = await withPlaidError(
      client.linkTokenCreate({
        user: { client_user_id: userId },
        client_name: "Finny",
        language: "en",
        country_codes: [CountryCode.Us, CountryCode.Ca],
        // Transactions required; investments/liabilities picked up when the
        // institution supports them (avoids Plaid's "no accounts found" trap
        // when all products are required).
        products: [Products.Transactions],
        optional_products: [Products.Investments, Products.Liabilities],
        transactions: { days_requested: 730 },
        webhook: WEBHOOK_URL(),
        redirect_uri: oauthRedirectUri(args.origin, env),
      }),
    );
    return response.data.link_token;
  },
});

// Link update mode, for reconnecting a broken connection.
export const createUpdateLinkToken = action({
  args: {
    connectionId: v.id("bankConnections"),
    origin: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<string> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not signed in");
    }
    await requireAccess(ctx, userId);
    const connection = await ctx.runQuery(internal.connections.getInternal, {
      connectionId: args.connectionId,
    });
    if (!connection || connection.userId !== userId) {
      throw new Error("Connection not found");
    }
    const env: PlaidEnv = connection.plaidEnv ?? "production";
    const client = plaidClient(env);
    const response = await withPlaidError(
      client.linkTokenCreate({
        user: { client_user_id: userId },
        client_name: "Finny",
        language: "en",
        country_codes: [CountryCode.Us, CountryCode.Ca],
        access_token: connection.accessToken,
        webhook: WEBHOOK_URL(),
        redirect_uri: oauthRedirectUri(args.origin, env),
      }),
    );
    return response.data.link_token;
  },
});

export const exchangePublicToken = action({
  args: { publicToken: v.string(), origin: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not signed in");
    }
    await requireAccess(ctx, userId);
    // Must match the environment createLinkToken used, or the public token
    // won't be recognized.
    const env = plaidEnvForOrigin(args.origin);
    const client = plaidClient(env);

    const exchange = await withPlaidError(
      client.itemPublicTokenExchange({ public_token: args.publicToken }),
    );
    const accessToken = exchange.data.access_token;
    const itemId = exchange.data.item_id;

    const item = await withPlaidError(
      client.itemGet({ access_token: accessToken }),
    );
    const institutionId = item.data.item.institution_id ?? undefined;

    let institutionName = "Bank";
    let institutionLogo: string | undefined;
    if (institutionId) {
      const institution = await withPlaidError(
        client.institutionsGetById({
          institution_id: institutionId,
          country_codes: [CountryCode.Us, CountryCode.Ca],
          options: { include_optional_metadata: true },
        }),
      );
      institutionName = institution.data.institution.name;
      const logo = institution.data.institution.logo;
      institutionLogo = logo ? `data:image/png;base64,${logo}` : undefined;
    }

    const accounts = await withPlaidError(
      client.accountsGet({ access_token: accessToken }),
    );

    const connectionId = await ctx.runMutation(internal.connections.saveConnection, {
      userId,
      plaidItemId: itemId,
      accessToken,
      plaidEnv: env,
      institutionId,
      institutionName,
      institutionLogo,
      accounts: accounts.data.accounts.map((account) => ({
        plaidAccountId: account.account_id,
        name: account.name,
        officialName: account.official_name ?? undefined,
        mask: account.mask ?? undefined,
        type: account.type,
        subtype: account.subtype ?? undefined,
      })),
    });

    // If the Notion destination is already set up, backfill this bank now.
    const notion = await ctx.runQuery(internal.notion.getConnectionInternal, {
      userId,
    });
    if (notion?.databases) {
      await ctx.scheduler.runAfter(0, internal.sync.runForConnection, {
        connectionId,
        trigger: "initial",
      });
    }
  },
});

// Revoke one Item at Plaid, then drop this app's rows for it. Reports whether
// Plaid accepted the revocation; the rows go either way, since an Item Plaid
// has already forgotten — or a Plaid outage — must not leave an access token
// sitting in the database.
async function revokeAndForget(
  ctx: ActionCtx,
  connection: Doc<"bankConnections">,
): Promise<boolean> {
  let revoked = true;
  try {
    await plaidClient(connection.plaidEnv ?? "production").itemRemove({
      access_token: connection.accessToken,
    });
  } catch (error) {
    console.error("itemRemove failed", error);
    revoked = false;
  }
  await ctx.runMutation(internal.connections.deleteCascade, {
    connectionId: connection._id,
  });
  return revoked;
}

export const removeConnection = action({
  args: { connectionId: v.id("bankConnections") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not signed in");
    }
    const connection = await ctx.runQuery(internal.connections.getInternal, {
      connectionId: args.connectionId,
    });
    if (!connection || connection.userId !== userId) {
      throw new Error("Connection not found");
    }
    await revokeAndForget(ctx, connection);
  },
});

// Revoke every bank this user has linked. Deliberately not gated on the
// access password: someone who cannot get past the gate must still be able to
// hand their Plaid tokens back.
//
// One Item's failure at Plaid must not strand the rest, so each is attempted
// on its own and the failures are named in the result rather than thrown.
export const disconnectAllBanks = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ removed: number; revokeFailures: string[] }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not signed in");
    }
    const connections = await ctx.runQuery(
      internal.connections.listByUserInternal,
      { userId },
    );
    const revokeFailures: string[] = [];
    for (const connection of connections) {
      if (!(await revokeAndForget(ctx, connection))) {
        revokeFailures.push(connection.institutionName);
      }
    }
    return { removed: connections.length, revokeFailures };
  },
});

// Called by the /plaid/webhook http action. Verifies the Plaid-Verification
// JWT, then routes by webhook type.
export const handleWebhook = internalAction({
  args: { body: v.string(), signature: v.optional(v.string()) },
  handler: async (ctx, args) => {
    // Read the item id before verifying, only to look up which environment
    // issued this Item — verification keys are environment-specific. The
    // signature check below still gates everything that follows.
    let payload: {
      webhook_type?: string;
      webhook_code?: string;
      item_id?: string;
      error?: { error_code?: string } | null;
    };
    try {
      payload = JSON.parse(args.body) as typeof payload;
    } catch {
      console.error("plaid webhook: body was not JSON, dropping");
      return;
    }
    if (payload === null || typeof payload !== "object") {
      console.error("plaid webhook: body was not an object, dropping");
      return;
    }
    const { webhook_type: type, webhook_code: code, item_id: itemId } =
      payload;
    if (typeof itemId !== "string" || itemId.length === 0) {
      return;
    }
    const connection = await ctx.runQuery(
      internal.connections.getByItemInternal,
      { plaidItemId: itemId },
    );
    if (!connection) {
      console.log("plaid webhook for unknown item, ignoring", itemId);
      return;
    }
    const env: PlaidEnv = connection.plaidEnv ?? "production";

    if (!(await verifyWebhook(args.body, args.signature, env))) {
      console.error("plaid webhook: verification failed, dropping");
      return;
    }
    console.log("plaid webhook", type, code, itemId);

    const disposition = classifyPlaidWebhook(
      type,
      code,
      payload.error?.error_code,
    );
    if (disposition.action === "ignore") {
      console.log("plaid webhook: no handler", type, code);
      return;
    }
    if (disposition.action === "item_status") {
      // A broken Item stops syncing, so the sync is no longer what keeps the
      // Notion row honest — each status change pushes itself.
      await ctx.runMutation(internal.connections.setStatusByItem, {
        plaidItemId: itemId,
        status: disposition.status,
        errorCode: disposition.errorCode,
      });
      await ctx.scheduler.runAfter(0, internal.sync.pushConnectionStatusToNotion, {
        connectionId: connection._id,
      });
      return;
    }
    await ctx.scheduler.runAfter(0, internal.sync.runForConnection, {
      connectionId: connection._id,
      trigger: "webhook",
    });
  },
});

async function verifyWebhook(
  body: string,
  signature: string | undefined,
  env: PlaidEnv,
): Promise<boolean> {
  if (!signature) {
    return false;
  }
  try {
    const { kid } = decodeProtectedHeader(signature);
    if (!kid) {
      return false;
    }
    const keyResponse = await plaidClient(env).webhookVerificationKeyGet({
      key_id: kid,
    });
    const key = await importJWK(keyResponse.data.key, "ES256");
    const { payload } = await jwtVerify(signature, key, {
      // Plaid issues a 5-minute JWT. We ack 200 immediately and verify in a
      // scheduled action, so a Convex delay past that window used to drop a
      // real, signed webhook. The signature and body hash still bind the
      // payload to Plaid; a replay only re-triggers an idempotent sync.
      clockTolerance: 60 * 60,
    });
    const bodyHash = createHash("sha256").update(body).digest("hex");
    return payload.request_body_sha256 === bodyHash;
  } catch (error) {
    console.error("webhook verification error", error);
    return false;
  }
}

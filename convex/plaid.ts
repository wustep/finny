"use node";

import { createHash } from "node:crypto";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import { CountryCode, Products } from "plaid";
import { internal } from "./_generated/api";
import { action, internalAction } from "./_generated/server";
import { allowedOrigins } from "./origins";
import { plaidClient, withPlaidError } from "./plaidClient";

const WEBHOOK_URL = () => `${process.env.CONVEX_SITE_URL}/plaid/webhook`;

// OAuth institutions (Chase etc.) bounce the user to the bank and back to
// this app URL. Only used in production; the exact URIs must be registered
// in the Plaid dashboard under Allowed redirect URIs.
function oauthRedirectUri(origin: string | undefined): string | undefined {
  if (process.env.PLAID_ENV !== "production") {
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
    const client = plaidClient();
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
        redirect_uri: oauthRedirectUri(args.origin),
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
    const client = plaidClient();
    const response = await withPlaidError(
      client.linkTokenCreate({
        user: { client_user_id: userId },
        client_name: "Finny",
        language: "en",
        country_codes: [CountryCode.Us, CountryCode.Ca],
        access_token: connection.accessToken,
        webhook: WEBHOOK_URL(),
        redirect_uri: oauthRedirectUri(args.origin),
      }),
    );
    return response.data.link_token;
  },
});

export const exchangePublicToken = action({
  args: { publicToken: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not signed in");
    }
    await requireAccess(ctx, userId);
    const client = plaidClient();

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
    try {
      await plaidClient().itemRemove({
        access_token: connection.accessToken,
      });
    } catch (error) {
      // Still delete our records if Plaid already considers the item gone.
      console.error("itemRemove failed", error);
    }
    await ctx.runMutation(internal.connections.deleteCascade, {
      connectionId: args.connectionId,
    });
  },
});

// Called by the /plaid/webhook http action. Verifies the Plaid-Verification
// JWT, then routes by webhook type.
export const handleWebhook = internalAction({
  args: { body: v.string(), signature: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!(await verifyWebhook(args.body, args.signature))) {
      console.error("plaid webhook: verification failed, dropping");
      return;
    }

    const payload = JSON.parse(args.body) as {
      webhook_type?: string;
      webhook_code?: string;
      item_id?: string;
      error?: { error_code?: string } | null;
    };
    const { webhook_type: type, webhook_code: code, item_id: itemId } =
      payload;
    console.log("plaid webhook", type, code, itemId);
    if (!itemId) {
      return;
    }

    if (type === "ITEM") {
      if (code === "ERROR") {
        await ctx.runMutation(internal.connections.setStatusByItem, {
          plaidItemId: itemId,
          status: "error",
          errorCode: payload.error?.error_code,
        });
      } else if (code === "PENDING_EXPIRATION") {
        await ctx.runMutation(internal.connections.setStatusByItem, {
          plaidItemId: itemId,
          status: "pending_expiration",
        });
      } else if (code === "LOGIN_REPAIRED") {
        await ctx.runMutation(internal.connections.setStatusByItem, {
          plaidItemId: itemId,
          status: "active",
        });
      }
      return;
    }

    if (
      (type === "TRANSACTIONS" && code === "SYNC_UPDATES_AVAILABLE") ||
      (type === "TRANSACTIONS" && code === "INITIAL_UPDATE") ||
      (type === "TRANSACTIONS" && code === "HISTORICAL_UPDATE") ||
      (type === "HOLDINGS" && code === "DEFAULT_UPDATE") ||
      (type === "INVESTMENTS_TRANSACTIONS" && code === "DEFAULT_UPDATE")
    ) {
      const connection = await ctx.runQuery(
        internal.connections.getByItemInternal,
        { plaidItemId: itemId },
      );
      if (connection) {
        await ctx.scheduler.runAfter(0, internal.sync.runForConnection, {
          connectionId: connection._id,
          trigger: "webhook",
        });
      }
    }
  },
});

async function verifyWebhook(
  body: string,
  signature: string | undefined,
): Promise<boolean> {
  if (!signature) {
    return false;
  }
  try {
    const { kid } = decodeProtectedHeader(signature);
    if (!kid) {
      return false;
    }
    const keyResponse = await plaidClient().webhookVerificationKeyGet({
      key_id: kid,
    });
    const key = await importJWK(keyResponse.data.key, "ES256");
    const { payload } = await jwtVerify(signature, key, {
      maxTokenAge: "5 min",
    });
    const bodyHash = createHash("sha256").update(body).digest("hex");
    return payload.request_body_sha256 === bodyHash;
  } catch (error) {
    console.error("webhook verification error", error);
    return false;
  }
}

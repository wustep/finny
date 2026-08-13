import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Config and sync bookkeeping only — no financial data (amounts, merchants,
// balances, dates of transactions) is ever stored here. See PLAN.md.
export default defineSchema({
  ...authTables,

  // Convex Auth's users table, extended with the access-password flag.
  users: defineTable({
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    // Set once the user enters the shared ACCESS_PASSWORD; gates every
    // action that consumes Plaid Items or writes to Notion.
    accessGrantedAt: v.optional(v.number()),
  })
    .index("email", ["email"])
    .index("phone", ["phone"]),

  bankConnections: defineTable({
    userId: v.id("users"),
    plaidItemId: v.string(),
    accessToken: v.string(),
    institutionId: v.optional(v.string()),
    institutionName: v.string(),
    institutionLogo: v.optional(v.string()),
    // Which Plaid environment this Item lives in — access tokens only work
    // against the environment that issued them. Absent on connections made
    // before this was tracked; those predate local sandbox linking and are
    // production.
    plaidEnv: v.optional(
      v.union(v.literal("sandbox"), v.literal("production")),
    ),
    // Notion file upload id for institutionLogo, so the logo is uploaded
    // once and then reused as the page icon for this connection and every
    // account under it.
    notionIconFileUploadId: v.optional(v.string()),
    status: v.union(
      v.literal("active"),
      v.literal("error"),
      v.literal("pending_expiration"),
    ),
    errorCode: v.optional(v.string()),
    // Plaid transactions/sync cursor
    transactionsCursor: v.optional(v.string()),
    lastSyncedAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_plaid_item", ["plaidItemId"]),

  accounts: defineTable({
    userId: v.id("users"),
    connectionId: v.id("bankConnections"),
    plaidAccountId: v.string(),
    name: v.string(),
    officialName: v.optional(v.string()),
    mask: v.optional(v.string()),
    type: v.string(),
    subtype: v.optional(v.string()),
    syncEnabled: v.boolean(),
    // User-chosen display name; overrides the derived
    // "<Institution> <Product> *<mask>" title everywhere it's synced.
    customName: v.optional(v.string()),
  })
    .index("by_user", ["userId"])
    .index("by_connection", ["connectionId"])
    .index("by_plaid_account", ["plaidAccountId"]),

  notionConnections: defineTable({
    userId: v.id("users"),
    accessToken: v.string(),
    workspaceId: v.string(),
    workspaceName: v.optional(v.string()),
    workspaceIcon: v.optional(v.string()),
    botId: v.string(),
    // Page the Finny databases live under
    parentPageId: v.optional(v.string()),
    modules: v.object({
      balances: v.boolean(),
      spending: v.boolean(),
      investments: v.boolean(),
    }),
    // ISO date; how far back the initial backfill goes
    startDate: v.optional(v.string()),
    // logical database key (e.g. "transactions") -> Notion database/data source id
    databases: v.optional(v.record(v.string(), v.string())),
  }).index("by_user", ["userId"]),

  // Access-password attempts per IP. 3 consecutive failures bans the IP
  // (cleared manually from the dashboard).
  accessAttempts: defineTable({
    ip: v.string(),
    failures: v.number(),
    lastAttemptAt: v.number(),
    bannedAt: v.optional(v.number()),
  }).index("by_ip", ["ip"]),

  // Short-lived CSRF states for the Notion OAuth flow. `origin` records
  // which app origin started the flow so the callback returns there.
  notionOauthStates: defineTable({
    userId: v.id("users"),
    state: v.string(),
    createdAt: v.number(),
    origin: v.optional(v.string()),
  }).index("by_state", ["state"]),

  // providerId -> Notion page id, so syncs update-in-place instead of
  // duplicating. Opaque ids only.
  notionPageMap: defineTable({
    userId: v.id("users"),
    kind: v.union(
      v.literal("bankConnection"),
      v.literal("account"),
      v.literal("transaction"),
      v.literal("security"),
      v.literal("holding"),
      v.literal("investmentTransaction"),
      v.literal("category"),
      v.literal("balanceSnapshot"),
    ),
    // Plaid id, or composite key: holdings = `${accountId}|${securityId}`,
    // balance snapshots = `${accountId}|${YYYY-MM-DD}`
    providerId: v.string(),
    // Set while a sync holds a claim on this key but has not created the
    // Notion page yet; such a row carries an empty notionPageId.
    claimedAt: v.optional(v.number()),
    notionPageId: v.string(),
  }).index("by_user_kind_provider", ["userId", "kind", "providerId"]),

  syncRuns: defineTable({
    userId: v.id("users"),
    connectionId: v.optional(v.id("bankConnections")),
    trigger: v.union(
      v.literal("initial"),
      v.literal("webhook"),
      v.literal("manual"),
      v.literal("cron"),
    ),
    status: v.union(
      v.literal("running"),
      v.literal("success"),
      v.literal("error"),
    ),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    stats: v.optional(
      v.object({
        added: v.number(),
        modified: v.number(),
        removed: v.number(),
      }),
    ),
    error: v.optional(v.string()),
  })
    .index("by_user", ["userId"])
    .index("by_connection", ["connectionId"]),
});

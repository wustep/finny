import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// A text match a rule condition can ask for. `contains` and `equals` ignore
// case; `regex` is a JavaScript regular expression, compiled defensively by
// the engine (an invalid one matches nothing rather than throwing).
export const ruleTextConditionValidator = v.object({
  op: v.union(v.literal("contains"), v.literal("equals"), v.literal("regex")),
  value: v.string(),
});

// Compared against Plaid's amount, where positive means money left the
// account. Notion shows the same transaction with the sign flipped, which the
// Rules page spells out next to the field.
export const ruleAmountConditionValidator = v.object({
  op: v.union(
    v.literal("lt"),
    v.literal("lte"),
    v.literal("gt"),
    v.literal("gte"),
    v.literal("eq"),
  ),
  value: v.number(),
});

// Conditions AND together; a rule needs at least one (enforced in rules.ts,
// and again by the engine, because a rule that asks nothing plus a hide
// outcome empties the Transactions database).
export const ruleConditionsValidator = v.object({
  // Plaid's enriched merchant name, falling back to the raw description —
  // the same string the Notion title uses.
  merchant: v.optional(ruleTextConditionValidator),
  // The bank's own string, as synced to Original Description.
  description: v.optional(ruleTextConditionValidator),
  amount: v.optional(ruleAmountConditionValidator),
  accountId: v.optional(v.id("accounts")),
});

// What a matching rule changes about the Notion row. At least one is
// required; all of them apply together.
export const ruleOutcomesValidator = v.object({
  // A Plaid personal finance category, e.g. GENERAL_MERCHANDISE_ELECTRONICS,
  // replacing the one Plaid assigned. Validated against the taxonomy in
  // rulesEngine.ts on write.
  categoryId: v.optional(v.string()),
  // Replaces the Notion title; Original Description is left alone.
  rename: v.optional(v.string()),
  // No Notion row: skip the create, and archive + unmap a row that already
  // exists (see upsertTransaction in sync.ts).
  hide: v.optional(v.boolean()),
});

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
    // Consecutive runs that failed to write every row of the page at the
    // current cursor. Reset whenever the cursor moves; once it hits the
    // retry limit the page is skipped so one unwritable row cannot stall
    // the Item forever.
    cursorFailures: v.optional(v.number()),
    lastSyncedAt: v.optional(v.number()),
    // Exclusive sync lease. Only one run may touch this connection at a
    // time, or two runs race the shared Plaid cursor and duplicate Notion
    // pages. The lease is heartbeated by each batch and released by
    // finishRun; the expiry is what frees it when a run dies mid-chain.
    syncLockExpiresAt: v.optional(v.number()),
    activeRunId: v.optional(v.id("syncRuns")),
    // When a webhook arrived while the lease was held, the time the retry
    // it queued is due. Keeps a burst of webhooks to one pending follow-up.
    syncFollowUpAt: v.optional(v.number()),
    // The `status:errorCode` this connection was last commented about in
    // Notion. The daily sweep pushes the status of a broken Item every
    // morning, so without a record of what has already been said, every
    // morning would be a fresh comment about the same dead bank.
    notifiedStatusKey: v.optional(v.string()),
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
    // Set when a sync found this account at Plaid after the connection was
    // first linked — the user has never been asked whether to sync it, so
    // it starts disabled and the UI flags it. Cleared once they answer.
    discoveredAt: v.optional(v.number()),
    // Set when the account is switched on. The transactions/sync cursor is
    // shared by the whole Item and moves on whether or not this account was
    // syncing, so everything that streamed past while it was off is gone
    // from that stream; the next run fetches the window separately. Cleared
    // once that catch-up completes without failures.
    needsBackfill: v.optional(v.boolean()),
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
      // Optional because every connection made before this module existed has
      // a row without it. Absent reads as off, which is what it was.
      recurring: v.optional(v.boolean()),
    }),
    // ISO date; how far back the initial backfill goes
    startDate: v.optional(v.string()),
    // logical database key (e.g. "transactions") -> Notion database/data source id
    databases: v.optional(v.record(v.string(), v.string())),
  }).index("by_user", ["userId"]),

  // Access-password attempts per IP. 3 consecutive failures bans the IP for
  // ACCESS_BAN_MS (see access.ts); the row is cleared by the daily prune once
  // it has been quiet that long.
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
      v.literal("recurringStream"),
    ),
    // Plaid id, or composite key: holdings = `${accountId}|${securityId}`,
    // balance snapshots = `${accountId}|${YYYY-MM-DD}`
    providerId: v.string(),
    // Set while a sync holds a claim on this key but has not created the
    // Notion page yet; such a row carries an empty notionPageId.
    claimedAt: v.optional(v.number()),
    notionPageId: v.string(),
    // Which Plaid account this row belongs to. The map is keyed by user, so
    // without this a reconciliation pass for one Item cannot tell its own
    // rows from another connection's — and, more to the point, could not read
    // its own rows without scanning every transaction the user has ever
    // synced. Absent on rows written before this was tracked; those are left
    // alone (never archived) until syncData.backfillMapScopes or a sync
    // scopes them.
    accountId: v.optional(v.string()),
    // The last run that saw this provider id still present at Plaid. Lets a
    // full-window walk find the rows that have since vanished without
    // carrying the seen set through scheduler arguments.
    lastSeenRunId: v.optional(v.id("syncRuns")),
  })
    .index("by_user_kind_provider", ["userId", "kind", "providerId"])
    // The only index a reconciliation pass may read through: the unbounded
    // kinds (transaction, investmentTransaction, balanceSnapshot) grow with
    // history, so they can only be walked one account at a time, with
    // providerId as the continuation cursor. Rows with no accountId are not
    // in the range an `.eq("accountId", id)` scan reads, which is what keeps
    // legacy rows out of archival by construction.
    //
    // Not staged: this table is small today (tens of thousands of rows at
    // most), so the deploy-blocking backfill is seconds. A user base with
    // millions of mapped rows would want `staged: true` here and a follow-up
    // deploy to drop the flag.
    .index("by_user_kind_account_provider", [
      "userId",
      "kind",
      "accountId",
      "providerId",
    ])
    // Oldest rows of one kind, across all users — every Convex index ends in
    // _creationTime, which is what makes this a bounded read. Only the daily
    // prune uses it, to drop balance-snapshot rows whose key (account + a past
    // date) can never be looked up again.
    .index("by_kind", ["kind"]),

  // User overrides applied to transactions as they sync: recategorise,
  // retitle, or keep out of Notion. Config, not data — the conditions are
  // what to look for, never what was found.
  rules: defineTable({
    userId: v.id("users"),
    name: v.string(),
    // Evaluation order, ascending: the first enabled rule whose conditions
    // all match wins outright and no later rule is consulted (see
    // rulesEngine.ts). Unique per user by construction — create takes max + 1
    // and reorder swaps two values — rather than by an index, since Convex
    // has no unique indexes.
    priority: v.number(),
    enabled: v.boolean(),
    conditions: ruleConditionsValidator,
    outcomes: ruleOutcomesValidator,
  }).index("by_user_priority", ["userId", "priority"]),

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
        // Rows abandoned after repeated write failures, so a run that
        // advanced the cursor past a poison page says how much it dropped.
        skipped: v.optional(v.number()),
      }),
    ),
    error: v.optional(v.string()),
  })
    .index("by_user", ["userId"])
    .index("by_connection", ["connectionId"])
    // Finds runs left saying "running" by an action that died before
    // finishRun, oldest first — see syncData.sweepStuckRuns.
    .index("by_status_and_startedAt", ["status", "startedAt"]),
});

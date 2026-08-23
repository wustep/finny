import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  env,
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";

const TEST_EMAIL = "test@wustep.me";

// The identity behind the local-only "Continue as tester" button (see
// convex/auth.ts). Pre-unlocked, since the access password exists to keep
// strangers off the deployed app, not to slow down local development.
export const ensureTestUser = internalMutation({
  args: {},
  handler: async (ctx) => {
    const email = env.TEST_LOGIN_EMAIL ?? TEST_EMAIL;
    const existing = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .unique();
    if (existing) {
      if (existing.accessGrantedAt === undefined) {
        await ctx.db.patch(existing._id, { accessGrantedAt: Date.now() });
      }
      return existing._id;
    }
    return await ctx.db.insert("users", {
      email,
      name: "Tester",
      emailVerificationTime: Date.now(),
      accessGrantedAt: Date.now(),
    });
  },
});

export const viewer = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return null;
    }
    const user = await ctx.db.get(userId);
    if (user === null) {
      return null;
    }
    return {
      name: user.name,
      email: user.email,
      image: user.image,
      accessGranted: user.accessGrantedAt !== undefined,
    };
  },
});

// ---------- account deletion ----------

// Rows of one table a single pass deletes. A user with years of history has
// far more notionPageMap rows than one transaction may write, so a pass that
// fills a batch schedules another instead of trying to finish.
const PURGE_BATCH = 200;

// Sessions and auth accounts each fan out into a second query, so they take a
// smaller bite to keep the reads of one pass bounded.
const PURGE_FANOUT_BATCH = 25;

// Rows scanned looking for a user's OAuth states. That table has no by-user
// index and no reason to be large — the callback consumes each row — so a
// bounded scan of it is the whole table in practice.
const OAUTH_STATE_SCAN = 1000;

// Delete as much of one user's data as fits in a single transaction. Returns
// true while rows remain, in which case the caller schedules another pass.
//
// The user document goes last, on the pass that finds nothing left: while it
// exists there is still a row that says the account is being torn down, and
// something to reconcile against if a pass fails.
//
// Plaid revocation is not done here — a mutation cannot call Plaid. The
// off-ramp in Settings runs plaid.disconnectAllBanks first; the deletes below
// are what makes the tokens gone from Finny either way.
async function purgePass(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<boolean> {
  let more = false;

  // Take one row past the batch to learn whether more remain without a
  // second query.
  const overflow = <T>(rows: T[]): T[] => {
    if (rows.length > PURGE_BATCH) {
      more = true;
    }
    return rows.slice(0, PURGE_BATCH);
  };

  const connections = overflow(
    await ctx.db
      .query("bankConnections")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(PURGE_BATCH + 1),
  );
  for (const connection of connections) {
    await ctx.db.delete(connection._id);
  }

  const accounts = overflow(
    await ctx.db
      .query("accounts")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(PURGE_BATCH + 1),
  );
  for (const account of accounts) {
    await ctx.db.delete(account._id);
  }

  const notionConnections = overflow(
    await ctx.db
      .query("notionConnections")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(PURGE_BATCH + 1),
  );
  for (const notionConnection of notionConnections) {
    await ctx.db.delete(notionConnection._id);
  }

  const mapEntries = overflow(
    await ctx.db
      .query("notionPageMap")
      .withIndex("by_user_kind_provider", (q) => q.eq("userId", userId))
      .take(PURGE_BATCH + 1),
  );
  for (const entry of mapEntries) {
    await ctx.db.delete(entry._id);
  }

  const runs = overflow(
    await ctx.db
      .query("syncRuns")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(PURGE_BATCH + 1),
  );
  for (const run of runs) {
    await ctx.db.delete(run._id);
  }

  const abandoned = overflow(
    await ctx.db
      .query("abandonedPages")
      .withIndex("by_user_and_abandonedAt", (q) => q.eq("userId", userId))
      .take(PURGE_BATCH + 1),
  );
  for (const page of abandoned) {
    await ctx.db.delete(page._id);
  }

  const states = await ctx.db.query("notionOauthStates").take(OAUTH_STATE_SCAN);
  let deletedStates = 0;
  for (const state of states) {
    if (state.userId === userId) {
      await ctx.db.delete(state._id);
      deletedStates++;
    }
  }
  // Only ask for another pass if this one made progress, or a table full of
  // other users' states would reschedule forever.
  if (states.length === OAUTH_STATE_SCAN && deletedStates > 0) {
    more = true;
  }

  // Convex Auth's own tables. Sign-in sessions and their refresh tokens go,
  // which is what stops the deleted account being usable from a browser that
  // still holds a token. authVerifiers (short-lived OAuth PKCE state) is
  // indexed only by signature and carries no userId, so it is left to the
  // sign-in flow that created it; authRateLimits is keyed by identifier, not
  // by user.
  const sessions = await ctx.db
    .query("authSessions")
    .withIndex("userId", (q) => q.eq("userId", userId))
    .take(PURGE_FANOUT_BATCH + 1);
  if (sessions.length > PURGE_FANOUT_BATCH) {
    more = true;
  }
  for (const session of sessions.slice(0, PURGE_FANOUT_BATCH)) {
    const tokens = await ctx.db
      .query("authRefreshTokens")
      .withIndex("sessionId", (q) => q.eq("sessionId", session._id))
      .take(PURGE_BATCH + 1);
    for (const token of tokens.slice(0, PURGE_BATCH)) {
      await ctx.db.delete(token._id);
    }
    if (tokens.length > PURGE_BATCH) {
      // Refresh tokens chain, so a long-lived session can hold more than one
      // batch of them. The session row stays until they are all gone.
      more = true;
      continue;
    }
    await ctx.db.delete(session._id);
  }

  const authAccounts = await ctx.db
    .query("authAccounts")
    .withIndex("userIdAndProvider", (q) => q.eq("userId", userId))
    .take(PURGE_FANOUT_BATCH + 1);
  if (authAccounts.length > PURGE_FANOUT_BATCH) {
    more = true;
  }
  for (const authAccount of authAccounts.slice(0, PURGE_FANOUT_BATCH)) {
    const codes = await ctx.db
      .query("authVerificationCodes")
      .withIndex("accountId", (q) => q.eq("accountId", authAccount._id))
      .take(PURGE_BATCH + 1);
    for (const code of codes.slice(0, PURGE_BATCH)) {
      await ctx.db.delete(code._id);
    }
    if (codes.length > PURGE_BATCH) {
      more = true;
      continue;
    }
    await ctx.db.delete(authAccount._id);
  }

  if (more) {
    return true;
  }
  const user = await ctx.db.get(userId);
  if (user) {
    await ctx.db.delete(userId);
  }
  return false;
}

// Delete the signed-in user's account and everything Finny holds about them.
//
// The identity comes from ctx.auth and nowhere else — there is no userId
// argument, because this is the one mutation where being wrong about who is
// asking is unrecoverable.
//
// Pages already written to the user's Notion workspace are not touched: they
// are the user's data in the user's workspace, and this app never deletes
// from Notion. Signing up again therefore duplicates them, since the map that
// made syncs update in place is gone.
export const deleteAccount = mutation({
  args: {},
  handler: async (ctx): Promise<{ done: boolean }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Not signed in");
    }
    if (await purgePass(ctx, userId)) {
      await ctx.scheduler.runAfter(0, internal.users.purgeUser, { userId });
      return { done: false };
    }
    return { done: true };
  },
});

// Continuation of deleteAccount for an account with more rows than one
// transaction may delete. Internal only: it takes a userId because a
// scheduled pass has no caller to authenticate, and it is only ever scheduled
// by deleteAccount, which took that id from ctx.auth.
export const purgeUser = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    if (await purgePass(ctx, args.userId)) {
      await ctx.scheduler.runAfter(0, internal.users.purgeUser, {
        userId: args.userId,
      });
    }
  },
});

import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import {
  env,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { timingSafeEqualish } from "./secureCompare";

const MAX_FAILURES = 3;

// How long a ban holds. Three guesses a day is still an impossible rate
// against a shared password, and the alternative — a ban only a Convex
// dashboard visit can lift — is a good way to lock yourself out of your own
// app from a hotel wifi. syncData.pruneHistory deletes the row afterwards;
// this is what stops it counting in the meantime.
export const ACCESS_BAN_MS = 24 * 60 * 60 * 1000;

// How long a pre-sign-in grant ticket stays valid. Long enough to finish
// Google OAuth in another tab; short enough that a leaked ticket is not a
// standing invite.
export const ACCESS_GRANT_MS = 60 * 60 * 1000;

type RedeemResult =
  | { result: "ok"; grant?: string }
  | { result: "wrong" | "banned" | "unconfigured" };

function newGrantToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

// Whether the invite password is set. The UI skips the password screen when
// it is not, so local testers can still reach sign-in; Plaid/Notion actions
// stay gated on the user flag either way.
export const isConfigured = query({
  args: {},
  handler: async () => env.ACCESS_PASSWORD !== undefined,
});

// Called from the /access/redeem http action (never directly from the
// client — mutations over the websocket can't see the caller's IP, and the
// ban must be checked before the password).
//
// Works signed-out: a correct password issues a short-lived grant ticket
// the client later claims onto their user. A signed-in caller is granted
// on the user row immediately, same as before.
export const attemptRedeem = internalMutation({
  args: { ip: v.string(), password: v.string() },
  handler: async (ctx, args): Promise<RedeemResult> => {
    const attempt = await ctx.db
      .query("accessAttempts")
      .withIndex("by_ip", (q) => q.eq("ip", args.ip))
      .unique();
    if (
      attempt?.bannedAt !== undefined &&
      Date.now() - attempt.bannedAt < ACCESS_BAN_MS
    ) {
      return { result: "banned" };
    }
    if (attempt?.bannedAt !== undefined) {
      // Served its time. Clear the count as well as the ban, or the next
      // wrong guess bans again immediately and the expiry means nothing.
      await ctx.db.patch(attempt._id, { failures: 0, bannedAt: undefined });
      attempt.failures = 0;
      attempt.bannedAt = undefined;
    }

    const expected = env.ACCESS_PASSWORD;
    if (!expected) {
      return { result: "unconfigured" };
    }

    if (!timingSafeEqualish(args.password, expected)) {
      const failures = (attempt?.failures ?? 0) + 1;
      const banned = failures >= MAX_FAILURES;
      if (attempt) {
        await ctx.db.patch(attempt._id, {
          failures,
          lastAttemptAt: Date.now(),
          bannedAt: banned ? Date.now() : undefined,
        });
      } else {
        await ctx.db.insert("accessAttempts", {
          ip: args.ip,
          failures,
          lastAttemptAt: Date.now(),
          bannedAt: banned ? Date.now() : undefined,
        });
      }
      return { result: banned ? "banned" : "wrong" };
    }

    if (attempt) {
      await ctx.db.delete(attempt._id);
    }

    const userId = await getAuthUserId(ctx);
    if (userId !== null) {
      await ctx.db.patch(userId, { accessGrantedAt: Date.now() });
      return { result: "ok" };
    }

    const token = newGrantToken();
    const now = Date.now();
    await ctx.db.insert("accessGrants", {
      token,
      createdAt: now,
      expiresAt: now + ACCESS_GRANT_MS,
    });
    return { result: "ok", grant: token };
  },
});

// Consume a pre-sign-in grant ticket onto the signed-in user. The password
// was already checked when the ticket was issued; this only binds it.
export const claimGrant = mutation({
  args: { token: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ result: "ok" | "invalid" | "unauthenticated" }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return { result: "unauthenticated" };
    }
    const user = await ctx.db.get(userId);
    if (user?.accessGrantedAt !== undefined) {
      return { result: "ok" };
    }

    const grant = await ctx.db
      .query("accessGrants")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (grant) {
      await ctx.db.delete(grant._id);
    }
    if (!grant || grant.expiresAt < Date.now()) {
      return { result: "invalid" };
    }

    await ctx.db.patch(userId, { accessGrantedAt: Date.now() });
    return { result: "ok" };
  },
});

export const hasAccessInternal = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    return user?.accessGrantedAt !== undefined;
  },
});

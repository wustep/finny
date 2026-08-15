import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { env, internalMutation, internalQuery } from "./_generated/server";
import { timingSafeEqualish } from "./secureCompare";

const MAX_FAILURES = 3;

// How long a ban holds. Three guesses a day is still an impossible rate
// against a shared password, and the alternative — a ban only a Convex
// dashboard visit can lift — is a good way to lock yourself out of your own
// app from a hotel wifi. syncData.pruneHistory deletes the row afterwards;
// this is what stops it counting in the meantime.
export const ACCESS_BAN_MS = 24 * 60 * 60 * 1000;

// Called from the /access/redeem http action (never directly from the
// client — mutations over the websocket can't see the caller's IP, and the
// ban must be checked before the password).
export const attemptRedeem = internalMutation({
  args: { ip: v.string(), password: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<"ok" | "wrong" | "banned" | "unauthenticated" | "unconfigured"> => {
    const attempt = await ctx.db
      .query("accessAttempts")
      .withIndex("by_ip", (q) => q.eq("ip", args.ip))
      .unique();
    if (
      attempt?.bannedAt !== undefined &&
      Date.now() - attempt.bannedAt < ACCESS_BAN_MS
    ) {
      return "banned";
    }
    if (attempt?.bannedAt !== undefined) {
      // Served its time. Clear the count as well as the ban, or the next
      // wrong guess bans again immediately and the expiry means nothing.
      await ctx.db.patch(attempt._id, { failures: 0, bannedAt: undefined });
      attempt.failures = 0;
      attempt.bannedAt = undefined;
    }

    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return "unauthenticated";
    }
    const expected = env.ACCESS_PASSWORD;
    if (!expected) {
      return "unconfigured";
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
      return banned ? "banned" : "wrong";
    }

    if (attempt) {
      await ctx.db.delete(attempt._id);
    }
    await ctx.db.patch(userId, { accessGrantedAt: Date.now() });
    return "ok";
  },
});

export const hasAccessInternal = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    return user?.accessGrantedAt !== undefined;
  },
});

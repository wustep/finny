import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { timingSafeEqualish } from "./secureCompare";

const MAX_FAILURES = 3;

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
    if (attempt?.bannedAt !== undefined) {
      return "banned";
    }

    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return "unauthenticated";
    }
    const expected = process.env.ACCESS_PASSWORD;
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

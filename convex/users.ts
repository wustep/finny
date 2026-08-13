import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, query } from "./_generated/server";

const TEST_EMAIL = "test@wustep.me";

// The identity behind the local-only "Continue as tester" button (see
// convex/auth.ts). Pre-unlocked, since the access password exists to keep
// strangers off the deployed app, not to slow down local development.
export const ensureTestUser = internalMutation({
  args: {},
  handler: async (ctx) => {
    const email = process.env.TEST_LOGIN_EMAIL ?? TEST_EMAIL;
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

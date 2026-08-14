import Google from "@auth/core/providers/google";
import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { convexAuth } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import { env } from "./_generated/server";
import { resolveRedirect } from "./origins";
import { timingSafeEqualish } from "./secureCompare";

// Local-development sign-in that skips Google and lands on a fixed test
// identity. Two independent conditions must hold, so this can't become a
// backdoor on the deployed app: TEST_LOGIN_SECRET must be set on the
// deployment, AND the caller must present that exact secret. The secret
// lives only in a local .env.local (VITE_TEST_LOGIN_SECRET) and is never
// configured in Vercel, so the public build has no copy to send.
const TestLogin = ConvexCredentials({
  id: "test",
  authorize: async (credentials: Record<string, unknown>, ctx: any) => {
    const expected = env.TEST_LOGIN_SECRET;
    if (!expected || typeof credentials.secret !== "string") {
      return null;
    }
    if (!timingSafeEqualish(credentials.secret, expected)) {
      return null;
    }
    const userId = await ctx.runMutation(internal.users.ensureTestUser, {});
    return { userId };
  },
});

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Google, TestLogin],
  callbacks: {
    // The app runs on more than one origin (localhost + Vercel), so accept
    // absolute redirect targets as long as the origin is allowlisted.
    async redirect({ redirectTo }) {
      return resolveRedirect(redirectTo);
    },
  },
});

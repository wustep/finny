import Google from "@auth/core/providers/google";
import { convexAuth } from "@convex-dev/auth/server";
import { resolveRedirect } from "./origins";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Google],
  callbacks: {
    // The app runs on more than one origin (localhost + Vercel), so accept
    // absolute redirect targets as long as the origin is allowlisted.
    async redirect({ redirectTo }) {
      return resolveRedirect(redirectTo);
    },
  },
});

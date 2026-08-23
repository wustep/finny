import { defineApp } from "convex/server";
import { v } from "convex/values";

// Every environment variable the backend reads, in one place. Declaring them
// here makes `env` from ./_generated/server typed: required vars are `string`,
// optional ones are `string | undefined`, and a push fails fast if a required
// one is missing from the deployment instead of the app half-working.
//
// Set them with `npx convex env set KEY value` — see README.md. Vite-side vars
// (VITE_*) are not deployment vars and do not belong here. CONVEX_SITE_URL is
// provided by the deployment itself, so it is not declared either.
const app = defineApp({
  env: {
    SITE_URL: v.string(),

    // Convex Auth token signing; set by `npx @convex-dev/auth`.
    JWT_PRIVATE_KEY: v.string(),
    JWKS: v.string(),

    AUTH_GOOGLE_ID: v.string(),
    AUTH_GOOGLE_SECRET: v.string(),

    PLAID_CLIENT_ID: v.string(),
    PLAID_SECRET: v.string(),
    PLAID_ENV: v.union(v.literal("sandbox"), v.literal("production")),

    NOTION_CLIENT_ID: v.string(),
    NOTION_CLIENT_SECRET: v.string(),

    // Required to use the app, but optional to deploy: without it, the
    // password screen is skipped and redeeming reports "unconfigured" (a
    // 503) rather than the backend refusing to start, which is the
    // difference between a diagnosable app and a dead one.
    ACCESS_PASSWORD: v.optional(v.string()),

    // Lets connections started from localhost use the Plaid Sandbox while the
    // deployment is pointed at production.
    PLAID_SANDBOX_SECRET: v.optional(v.string()),

    // Presence of the secret is what enables the local-only test sign-in.
    TEST_LOGIN_SECRET: v.optional(v.string()),
    TEST_LOGIN_EMAIL: v.optional(v.string()),

    // Comma-separated extra app origins allowed as OAuth redirect targets.
    APP_ORIGINS: v.optional(v.string()),
  },
});

export default app;

# Finny

Sync your financial data to Notion. Connect banks through Plaid; Finny creates
and maintains databases (bank connections, accounts, balance history,
transactions, categories, securities, holdings, investment transactions)
inside a Notion page you choose. One-way sync, webhook-driven, updates rows
in place — no financial data is stored anywhere except Notion.

**Stack:** Vite + React + TanStack Router/Query + Tailwind + shadcn/ui
frontend; [Convex](https://convex.dev) for auth, config, and the sync engine;
Plaid for bank data; the Notion API for the destination. See
[PLAN.md](PLAN.md) for architecture and the exact Notion schema.

What Convex stores: users, Plaid access tokens, Notion tokens, module/page
config, sync cursors, and a providerId → Notion-page-ID map (opaque IDs that
make syncs idempotent). Amounts, merchants, and balances are never at rest
outside Notion.

---

## Set up your own instance

### Prerequisites

- Node 20+ and npm
- A [Convex](https://dashboard.convex.dev) account (free)
- A Google Cloud project (for Google sign-in)
- A [Plaid](https://dashboard.plaid.com) account (Sandbox is free; the Trial
  plan gives 10 free production bank connections)
- A [Notion integration](https://www.notion.so/profile/integrations)
  (public type, for OAuth)

### 1. Install and provision Convex

```bash
npm install
npx convex dev
```

Log in / create the project when prompted. This writes `.env.local`
(`CONVEX_DEPLOYMENT`, `VITE_CONVEX_URL`) and generates `convex/_generated/`.
This first run is interactive; from then on `npm run dev` starts it for you
alongside the app (step 8).

Your deployment has two URLs you'll use below:

- **API**: `https://<deployment>.convex.cloud`
- **HTTP**: `https://<deployment>.convex.site` (OAuth callbacks + webhooks)

### 2. Convex Auth (JWT keys + app origin)

```bash
npx @convex-dev/auth
```

Accept the defaults — it sets `JWT_PRIVATE_KEY`, `JWKS`, and `SITE_URL` on
the deployment. If you skip the CLI, set those manually; `SITE_URL` must be
the origin the app runs on in dev:

```bash
npx convex env set SITE_URL http://localhost:3466
```

(The dev server is pinned to port 3466 — "FINN" on a phone keypad — in
[vite.config.ts](vite.config.ts).)

### 3. Google sign-in

[Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials)
→ Create OAuth client ID → **Web application**. If prompted, configure the
consent screen first (External; add yourself as a test user). Authorized
redirect URI — note **.site**, not .cloud:

```
https://<deployment>.convex.site/api/auth/callback/google
```

```bash
npx convex env set AUTH_GOOGLE_ID <client-id>
npx convex env set AUTH_GOOGLE_SECRET <client-secret>
```

### 4. Plaid

Get your client ID and Sandbox secret from the
[Plaid dashboard Keys page](https://dashboard.plaid.com/developers/keys):

```bash
npx convex env set PLAID_CLIENT_ID <client-id>
npx convex env set PLAID_SECRET <sandbox-secret>
npx convex env set PLAID_ENV sandbox
```

Webhooks are configured automatically per connection and arrive at
`https://<deployment>.convex.site/plaid/webhook` (signature-verified).

### 5. Notion integration

Create a **public** integration at
[notion.so/profile/integrations](https://www.notion.so/profile/integrations)
with redirect URI:

```
https://<deployment>.convex.site/notion/oauth/callback
```

```bash
npx convex env set NOTION_CLIENT_ID <client-id>
npx convex env set NOTION_CLIENT_SECRET <client-secret>
```

### 6. Access password

Sign-in is open to any Google account, so an extra shared password gates
everything that consumes Plaid connections or writes to Notion. Wrong
guesses are rate-limited: **3 consecutive failures ban the caller's IP**
(delete the row in the `accessAttempts` table to unban).

```bash
npx convex env set ACCESS_PASSWORD <password-you-share-with-users>
```

### 7. Local development shortcuts (optional)

Two conveniences that only ever apply locally:

**Sign in without Google.** Set a secret on the deployment and the same
value in `.env.local` (gitignored, and never set in Vercel):

```bash
npx convex env set TEST_LOGIN_SECRET "$(openssl rand -hex 24)"
```

Put that value in `.env.local` as `VITE_TEST_LOGIN_SECRET=…`. A
"Continue as tester" button then appears on the sign-in card and logs you
in as `test@wustep.me`, pre-cleared past the access password. Deployed
builds have no copy of the secret, so the button is absent there and the
backend rejects the provider without it.

**Link banks against the Sandbox even when the deployment is on
production.** Add the Sandbox secret from the Plaid dashboard:

```bash
npx convex env set PLAID_SANDBOX_SECRET <sandbox-secret>
```

Connections started from `localhost` then use the Sandbox
(`user_good` / `pass_good`), while the deployed app keeps using
production — so local testing never burns real Plaid Items. Each
connection records which environment it belongs to, and every later call
for it (sync, reconnect, remove, webhooks) uses that environment.

### 8. Run it

```bash
npm run dev
```

This runs both halves in one terminal: `convex dev` (pushes backend changes
and keeps `.env.local` current) and the Vite dev server. Quitting stops both;
if either exits, the other is killed with it. To run them apart, use
`npm run convex:dev` and `npm run dev:app`. On a brand new checkout do step 1
(`npx convex dev`) once first — that login and project picker is interactive.

Open http://localhost:3466 → sign in with Google → enter the access
password → **Accounts → Add connection** (Sandbox credentials:
`user_good` / `pass_good`) → **Notion → Connect Notion** → pick a page,
modules, and start date → **Create databases**. The initial backfill starts
automatically; after that, syncs run on Plaid webhooks plus a daily 11:00 UTC
sweep (balance snapshots + missed-webhook safety net), and manually via
**Sync now** on each connection.

---

## Deploy to Vercel (via GitHub)

1. Push the repo to GitHub and import it at [vercel.com/new](https://vercel.com/new)
   (Vite is auto-detected; [vercel.json](vercel.json) handles SPA rewrites).
2. Add one environment variable: `VITE_CONVEX_URL` = `https://<deployment>.convex.cloud`.
3. Deploy, then allowlist your Vercel origin for OAuth redirects:

```bash
npx convex env set APP_ORIGINS https://<your-app>.vercel.app
```

Every push to `main` auto-deploys. The same Convex deployment serves
localhost and production.

> For a real multi-user production setup you'd typically create a separate
> Convex prod deployment (`npx convex deploy`) with its own copies of all the
> env vars above — and register its `.convex.site` URLs with Google/Notion.

## Real banks (Plaid production)

1. In the Plaid dashboard: unlock Production (Trial plan is auto-approved
   for most; **10 production Items lifetime** — deleting one does not refund
   the slot), and complete the app branding/display profile.
2. Register OAuth redirect URIs (Dashboard → Developers → API →
   Allowed redirect URIs) — required for OAuth banks like Chase, which may
   take a few days to activate:

```
https://<your-app>.vercel.app/plaid-oauth
http://localhost:3466/plaid-oauth
```

3. Remove any sandbox connections in the app, then flip:

```bash
npx convex env set PLAID_SECRET <production-secret>
npx convex env set PLAID_ENV production
```

## Environment variable reference

All on the Convex deployment (`npx convex env set KEY value`) unless noted.
Every deployment variable is declared, with its type and whether it is
optional, in [`convex/convex.config.ts`](convex/convex.config.ts); the backend
reads them through the typed `env` from `convex/_generated/server` rather than
`process.env`, so that declaration is the one list to keep in step with this
table.

| Variable | Purpose |
|---|---|
| `SITE_URL` | App origin in dev; base for auth redirects |
| `JWT_PRIVATE_KEY`, `JWKS` | Convex Auth token signing (set by `npx @convex-dev/auth`) |
| `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | Google OAuth client |
| `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` | Plaid credentials (`sandbox` or `production`) |
| `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET` | Notion public integration |
| `ACCESS_PASSWORD` | Shared invite password (plaintext env var) |
| `TEST_LOGIN_SECRET` | Optional; enables the local "Continue as tester" button |
| `TEST_LOGIN_EMAIL` | Optional; email for the test identity (default `test@wustep.me`) |
| `PLAID_SANDBOX_SECRET` | Optional; lets localhost link Sandbox banks while prod stays production |
| `VITE_TEST_LOGIN_SECRET` | **`.env.local` only**: must match `TEST_LOGIN_SECRET` |
| `APP_ORIGINS` | Optional comma-separated extra app origins (e.g. your Vercel URL) |
| `VITE_CONVEX_URL` | **Vercel/build-time**: the deployment's .convex.cloud URL |

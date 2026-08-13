# Finny setup

One-time steps that need your logins (Claude can't do these for you).

## 1. Provision Convex

```bash
npx convex dev
```

Log in / create the project when prompted. This writes `.env.local`
(`VITE_CONVEX_URL`, `CONVEX_DEPLOYMENT`) and regenerates `convex/_generated/`.
Leave it running while developing.

## 2. Configure Convex Auth

```bash
npx @convex-dev/auth
```

Accept the defaults — it sets `JWT_PRIVATE_KEY`, `JWKS`, and `SITE_URL` on the
dev deployment.

## 3. Google OAuth client

1. [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials) → Create OAuth client ID → Web application.
2. Authorized redirect URI: `https://<your-deployment>.convex.site/api/auth/callback/google`
   (deployment name is in `.env.local`; note **.site**, not .cloud).
3. Set the secrets:

```bash
npx convex env set AUTH_GOOGLE_ID <client-id>
npx convex env set AUTH_GOOGLE_SECRET <client-secret>
```

## 4. Run the app

```bash
npm run dev
```

Vite on http://localhost:3466, sign in with Google.

## Later phases

- **Plaid (phase 2):** `npx convex env set PLAID_CLIENT_ID/PLAID_SECRET/PLAID_ENV`,
  webhook URL is `https://<deployment>.convex.site/plaid/webhook`.
- **Notion OAuth (phase 3):** create a public integration at
  notion.so/my-integrations, redirect URI
  `https://<deployment>.convex.site/notion/oauth/callback`.

---
name: finny-sync
description: Invariants of Finny's Plaid → Notion sync — what Convex may store, sync engine rules, money sign conventions, the webhook path, and local dev quirks. Use when changing anything in convex/ or debugging a sync.
---

# Finny sync invariants

Rules that are cheap to break and expensive to notice. Read the pointed-at
file before changing behavior it owns.

## 1. What Convex may store

`convex/schema.ts` is config and bookkeeping only: users, Plaid access
tokens, Notion tokens, module/page config, `transactionsCursor`, the
`notionPageMap` (providerId → Notion page id), and `rules`. Amounts,
merchants, balances, and transaction dates never live at rest outside Notion
— every new field has to pass that test. A rule stores what to look for
("merchant contains amzn"), never what was found, which is what keeps it on
the right side of that line.

## 2. Sync engine (`convex/sync.ts`, `convex/syncData.ts`)

- One run per connection, held by a lease on the connection
  (`syncLockExpiresAt` / `activeRunId`): `syncData.beginRun` takes it, every
  hop heartbeats it, `syncData.finishRun` releases it — which is why it sits
  on every exit path. A trigger that finds the lease held bails; a webhook
  that loses the race queues itself one retry.
- `runForConnection` chains actions (connection page → accounts/balances →
  holdings/securities → `accountBackfill`, once per account flagged
  `needsBackfill` → `transactionsBatch` → `investmentsBatch` → `finishRun`)
  so a backfill never hits the action time limit.
- `accountBackfill` is the catch-up for an account switched back on. The
  Item's transactions/sync cursor moved on while it was off, so that history
  is gone from the stream; the catch-up reads the same window through
  `transactions/get`, which consumes no cursor, and clears `needsBackfill`
  once a walk finishes without failures.
- A run that dies without reaching `finishRun` keeps its row on "running"
  forever. The daily sweep (`syncData.sweepStuckRuns`) closes those out as
  "timed out" — but only when the lease is not held by that run, since the
  heartbeat is the only signal separating a corpse from a slow backfill.
- Advance `transactionsCursor` only after a page has been fully written to
  Notion (`syncData.setCursor`, end of `transactionsBatch`). Advancing early
  drops transactions permanently — Plaid does not resend a consumed page.
- Creating a page is claim-then-create: `syncData.claimMapEntry` returns
  `create` | `pending` | `ready`; only the `create` winner calls the Notion
  API, then `putMapEntries` writes the page id. A `notionPageMap` row with an
  empty `notionPageId` is an in-flight claim, not a page — readers skip it.
  This exists because user-scoped keys (categories, securities) are reachable
  from several connections' syncs at the same time.
- Pending → posted: when an added transaction carries a
  `pending_transaction_id` that is already mapped, update that page and
  `syncData.rekeyMapEntry` to the posted id. Never create a second page.
- Everything is keyed through `notionPageMap`, so every step must be safe to
  rerun; reruns update in place.

## 3. Money conventions (`convex/syncMappers.ts` — pure, unit tested)

- Transactions: Plaid positive = money out, Notion gets `-txn.amount`.
- Investment transactions: `type === "cash"` flips sign so deposits read
  positive; trades (buy/sell) keep Plaid's sign.
- Credit-card balances arrive positive (amount owed) and stay positive.
- APR is `apr_percentage / 100` — Notion's percent format renders 0.2499 as
  24.99%.
- The Notion property names in this file are a live contract with the
  databases built by `convex/notionSchemas.ts`; renaming one renames a
  column users already have data in.

## 4. Transaction rules (`convex/rulesEngine.ts`, `convex/rules.ts`)

- Evaluation happens in the sync pass-through — `upsertTransaction` in
  `convex/sync.ts`, so both the transactions/sync stream and the
  `accountBackfill` catch-up go through it. There is no stored transaction
  to re-run a rule against later; the next sync event for that transaction
  is the only chance a changed rule gets.
- Priority ascending, and the first enabled rule whose conditions all match
  wins outright: its outcomes (category, rename, hide) apply together and no
  later rule is consulted. A rule with no conditions matches nothing.
- Amount conditions use Plaid's sign (positive = money out), the opposite of
  the Notion column. Regexes are compiled defensively — an invalid one
  matches nothing rather than throwing and failing the row.
- `hide` = do not create the page; if one already exists, `archivePage` it
  **and** delete its `notionPageMap` entry, or the next sync updates a row
  the user asked to be gone. A failed archive throws, which counts as a row
  failure and holds the cursor, like any other failed Notion write.
- Rules are loaded once per batch (`internal.rules.listEnabledInternal`),
  never per transaction, and capped (`MAX_RULES`) so that stays one query.
- One-way sync still wins: a rename or category set in Notion is overwritten
  by the next `updatePage`. Rules are the supported way to change either.

## 5. Webhooks (`convex/http.ts` → `convex/plaid.ts`)

`/plaid/webhook` acks 200 immediately and schedules
`internal.plaid.handleWebhook`. That action reads `item_id` from the unverified
body only to pick the Plaid environment (verification keys are per-env),
verifies the `Plaid-Verification` JWT, and routes after that: ITEM webhooks
set connection status/error code, TRANSACTIONS codes schedule
`sync.runForConnection` with trigger `webhook`. Nothing acts on an
unverified body.

## 6. Local dev

`npm run dev` runs `convex dev` and Vite together. The port is pinned to
3466 and `SITE_URL` on the deployment must match it. `TEST_LOGIN_SECRET`
plus `VITE_TEST_LOGIN_SECRET` in `.env.local` enable the local-only
"Continue as tester" sign-in. With `PLAID_ENV=production`, links started
from `localhost` go to the Sandbox when `PLAID_SANDBOX_SECRET` is set
(`convex/plaidClient.ts`) — otherwise local testing burns real production
Items. Each connection stores its `plaidEnv` and every later call for it
reuses that; access tokens do not work across environments.

## 7. Docs

PLAN.md's Notion property tables are stale — `convex/notionSchemas.ts` is
the live schema.

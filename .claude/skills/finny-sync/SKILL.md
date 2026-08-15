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
- A run that fails for a passing reason schedules its own next attempt:
  callers pass `retryable` to `syncData.finishRun`, which backs off 5m / 20m /
  1h through `syncRetryCount` and then gives up to the daily sweep. `failRun`
  passes `!itemBroken`, since a bank that needs reconnecting is exactly what a
  retry cannot fix; the direct `finishRun` calls pass `false` for anything a
  human has to resolve — a destination that went away, a page deliberately
  abandoned, a lost lease. Scheduling lives in `finishRun` because that is
  where the lease is released, so a retry can never arrive to find the
  connection still locked by the run that scheduled it.
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
- `notionPageMap` rows for transactions, investment transactions and balance
  snapshots grow with a user's history, so no read may span a whole
  `(userId, kind)` range: `syncData.getAllMapEntries` throws for those kinds,
  and everything else goes one Plaid account at a time through
  `by_user_kind_account_provider` in bounded pages (`accountId` is written at
  claim time). A row with no `accountId` is outside every scoped read, so it
  is never archived — unattributable rows are left in Notion rather than
  guessed at. `syncData.backfillMapScopes` (batched, idempotent, run by hand)
  scopes the rows whose key proves the account: `account` keys are the account
  id, `holding` / `balanceSnapshot` keys are prefixed with it. Transaction and
  investment-transaction ids carry nothing, so those stay unscoped until a sync
  mentions them again.
- Vanished investment transactions: Plaid drops a canceled one out of the
  window instead of listing it as removed, so after a complete failure-free
  walk each of the Item's accounts is paged for rows this run never marked
  seen, and those are archived (capped per run). A short walk archives live
  history, which is why `pageErrors` gates it.
- The daily sweep walks all users' connections in batched passes, carrying its
  15s stagger and its creation-time cursor through the continuation. Before it
  schedules anything it closes out stale runs and then prunes history
  (`syncData.pruneHistory`: finished runs past 30 days, OAuth states past an
  hour, balance-snapshot map rows past 90 days — the one map kind nothing
  reads again — and access attempts quiet for a day, which is also what lifts
  their ban) — in that order, so a run the sweep just failed is never also deleted.
- A failed run says what failed: every catch goes through `failRun`, which
  unwraps Plaid's `error_code`/`error_message` (`plaidErrorInfo` in
  `plaidClient.ts`) instead of letting `String(error)` write "Request failed
  with status code 400". Codes in `ITEM_BROKEN_CODES` also mark the connection
  `error` and mirror that to Notion, because a sync is where most broken Items
  are found and the ITEM ERROR webhook does not cover every case. Transient
  codes (rate limits, institution outages, 5xx) must stay out of that set — a
  reconnect fixes none of them. `failRun` is the only thing that marks a
  connection, and it always fails the run in the same breath: `finishRun`'s
  success path forces the connection back to `active`, so a stage that marked
  the Item and let the chain carry on would flip the card between states once
  a day.
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

## 3b. Talking to Notion (`convex/notionApi.ts`)

Every Notion call goes through `notionFetch` — the setup actions in
`notion.ts` included. It spaces requests ~340ms apart (Notion allows about
three a second and answers a burst with 429s, which cost more than the wait)
and retries 429/409/5xx with jittered exponential backoff, honouring
`Retry-After`. Do not add a second fetch path; the one exception is
`notion.checkHealth`, which wants the status code rather than a thrown error.

## 4. Transaction rules (`convex/rulesEngine.ts`, `convex/rules.ts`)

- Evaluation happens in the sync pass-through — `upsertTransaction` in
  `convex/sync.ts`, so both the transactions/sync stream and the
  `accountBackfill` catch-up go through it. There is no stored transaction
  to re-run a rule against later; the next sync event for that transaction
  is the only chance a changed rule gets.
- Priority ascending, and the first enabled rule whose conditions all match
  wins outright: its outcomes (category, rename, hide) apply together and no
  later rule is consulted. That one-rule-per-row semantics is load-bearing,
  not a simplification — Finny stores no transactions, so a row's fate can
  only be explained if exactly one rule decided it.
- A rule is two lists: conditions (ANDed) and actions (applied in order). If
  all of these, then do all of these. Several values inside one text or
  category condition are ORed, and a range is two amount conditions. No
  nesting, no OR across fields. A rule with no conditions matches nothing.
- `evaluate` returns a resolved `RuleMatch` (categoryId / rename / tags / hide)
  rather than the action list, so the sync never learns about action kinds.
  Colliding actions resolve last-wins; tags accumulate; hide is a latch.
- `addTags` writes the Tags multi-select on Transactions. A database built
  before Tags existed has no such column and writing to one that is not there
  fails the whole row — so `transactionProperties` omits Tags when there are
  none, and saving a rule with an addTags action schedules
  `notion.ensureTransactionColumns` to add the column. Commas are stripped
  from tags: Notion refuses them inside an option name.
- A category *condition* may name a primary group; a category *action* may
  not. A row lands in one category, not a group of them.
- Rules written before either list existed are still on disk in the old
  shapes: conditions as a one-slot-per-field record, effects in `outcomes`.
  Nothing has to be migrated first — `rules.ts` normalises on read
  (`normalizeConditions` / `normalizeActions`), so the engine and the UI only
  ever see lists, and `rules.migrateConditions` tidies rows at rest. Writes
  only ever produce lists, and clear `outcomes` so no read has to guess which
  field is authoritative.
- `rules.applyToHistory` is the only way a rule reaches rows that already
  exist: there is nothing stored to re-run against, so it rewinds the Plaid
  cursors and replays through the sync, where the rules live.
- A category condition may name a whole primary group (`FOOD_AND_DRINK`),
  which matches every detailed category under it, or one detailed category.
  An outcome may only name a detailed one — a Notion row lands in a category,
  not a group.
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

## 6b. Destination integrity (`convex/notion.ts`)

`checkHealth` asks whether the token works. `checkDatabases` asks the question
after it — every database Finny recorded is fetched and compared against its
spec (missing / trashed / missing columns / retyped columns). `repairDatabases`
adds missing columns, and rebuilds a database that is gone: the rows went with
it, so it also drops the `notionPageMap` entries pointing into it (they address
pages that no longer exist) and repoints every relation that named it — a
relation stores the target's id, not its name. The relation graph is derived
from `DATABASE_SPECS` by probing it, so it cannot drift from the specs. A
retyped column is reported and never repaired: changing a Notion property's
type discards what was in it.

## 6c. Reset & resync (`convex/sync.ts`)

`resetAndResync` takes `existingRows`. `leave` is the old behaviour — forget
the map, rebuild alongside whatever is still in Notion. `archive` hands the
teardown to `sync.archiveMappedPages`, a self-rescheduling chain that reads the
first `ARCHIVE_HOP` rows still in the map, archives those Notion pages, and
deletes the rows — so the map is its own queue and no cursor is needed. Rows
are dropped whether or not the archive worked, or a failed one would be read
again forever; a 404 is the outcome we wanted. Cursors are only rewound and
syncs only scheduled at the end of the chain (`startRebuild`), so a rebuild
never races the teardown.

## 6d. Telling the user a bank broke (`convex/sync.ts`)

`pushConnectionStatusToNotion` writes the Status property and then leaves a
comment on the same row when the state has actually changed. The comment is
the notification: it lands in the user's Notion inbox, needs no email
provider, and carries only an institution name and a Plaid error code — which
is the only reason this is allowed to exist at all.

The claim is what stops it repeating: `syncData.claimStatusNotification` reads
and sets `notifiedStatusKey` (`status:errorCode`) in one mutation, so the
webhook, the run it schedules, and the daily sweep — all of which push the
status of a broken Item — say it once between them. A first-ever claim on an
`active` connection returns null, because "still fine" is not news.
`finishRun` schedules a push only when a run actually recovers a broken
connection. Commenting never throws: the integration may not have the
insert-comments capability, which is a 403 forever.

## 6e. Recurring streams (`convex/sync.ts`)

An optional module. Plaid's `transactions/recurring/get` works out the streams
itself, so Finny computes nothing and keeps nothing — the amounts go straight
to Notion like every other figure. One pass in stage 1 rather than a chain,
because streams number in the tens. Nothing is archived: a cancelled
subscription becomes `is_active: false` and stays.

Two things to keep right. The Category relation only exists when Spending
built the Categories database, so both the spec and the mapper omit it
otherwise — writing a property a database does not have is a 400 for that row.
And amounts are negated like transactions (Plaid positive = money out), with
Direction carrying what the sign used to imply.

`modules.recurring` is optional in the schema because every connection made
before the module existed has a row without it; absent reads as off.

## 7. Docs

PLAN.md's Notion property tables are stale — `convex/notionSchemas.ts` is
the live schema.

# Finny — Plaid → Notion sync (Notion-only)

Personal finance sync: connect banks via Plaid, sync accounts / transactions / investments into Notion databases. No charts, no MCP/API, no storage of financial data — purely sync.

## Core sync behavior (research summary)

Distilled from researching commercial Plaid → Notion sync products and inspecting a live synced Notion workspace.

- **One-way sync**, Finny → Notion. User edits to Finny-owned properties get overwritten; users are encouraged to add their *own* extra properties/rollups/formulas, which Finny never touches.
- **Event-driven**: Plaid webhooks trigger syncs "within minutes"; periodic backfill catches missed webhooks; manual sync button.
- **Dedup/update-in-place** keyed on provider transaction ID: pending → posted updates the existing Notion page rather than inserting a new one. Removed transactions are handled via Plaid's `removed` list.
- **Setup flow**: sign in → Plaid Link a bank → connect Notion (OAuth) → pick a page → pick tracking modules → Finny creates databases inside that page → first sync runs immediately.
- **Tracking modules** determine which databases get created:
  - *Balances*: Bank Connections (Institutions), Accounts, Balance History
  - *Spending*: Accounts, Transactions, Categories
  - *Investments*: Accounts, Securities, Holdings, Investment Transactions
- **Categories** = Plaid Personal Finance Categories (the "AI categorization" toggle), synced into a Categories DB with a relation from Transactions.
- **Rules engine** (phase 2 for us): conditions on merchant/summary/amount/account/day with contains/equals/regex; outcomes: set category, rename merchant, hide transaction. Priority-ordered, manual assignment always wins.

## Notion schema (baseline + approved changes)

> Superseded by [convex/notionSchemas.ts](convex/notionSchemas.ts) — that file
> is the live schema; the tables below record the original intent.

Baseline verified from a live reference Notion page (8 full-page databases, one table view each). All money fields: number, dollar format, 2 precision. Every DB has an `ID` text property holding the provider ID — **except** Balance History (no ID at all in our version) and Holdings (none).

**Approved deviations from the baseline (2026-08-12):**
- *Balance History*: title is `YYYY-MM-DD · <Account Name>` (keyed on account+date); the UUID title property is dropped.
- *Holdings*: add **Cost Basis** ($). The baseline's "Formula" (market value) is not created — Notion rejects a rollup pointing at a relation made in the same request, so the Security Price rollup and the `Quantity * price` formula are left for the user to add by hand.
- *Transactions*: title is the **cleaned merchant name** (fallback: Plaid's `name`); raw bank string goes to a new **Original Description** text property; "Is Pending?" renamed **Pending**.
- *Accounts*: add credit liability fields — **Next Payment Due** (date), **Minimum Payment** ($), **Last Statement Balance** ($), **APR** (%); row icon = institution logo.
- *Bank Connections*: add **Status** select (Active / Error / Pending expiration); row icon = institution logo.
- *Securities*: add **Type** select (equity, etf, mutual fund, cash, …).
- *Investment Transactions*: use Plaid's full type/subtype option sets (adds `sell`, `fee`, `transfer`, …).

### Bank Connections
| Property | Type |
|---|---|
| Name (title) | Institution name |
| ID | text |
| Last Update | datetime |

### Accounts — title format: `<Institution> <Product> *<last4>`
| Property | Type |
|---|---|
| Account Name (title) | |
| ID | text |
| Account Type | select: `investment`, `credit`, `depository` |
| Account Subtype | select: `checking`, `credit card`, `brokerage`, `ira`, `roth`, `401k`, `529`, … |
| Current Balance / Available Balance / Account Limit | number ($) — credit card balances stored **positive** |
| Bank Connection | relation → Bank Connections |

Sorted by Account Name asc.

### Balance History — one snapshot row per account per day
| Property | Type |
|---|---|
| ID (title) | UUID v4 |
| Account | relation → Accounts |
| Balance | number ($) |
| Date | date (no time) |

### Securities
| Property | Type |
|---|---|
| Symbol (title) | ticker |
| Security Name | text |
| ID | text |
| Close Price | number ($) |
| Close Price As Of | date |

Sorted Symbol asc.

### Holdings — title format: `<SYMBOL> Holding`; cash positions (e.g. SPAXX) are holdings too
| Property | Type |
|---|---|
| Summary (title) | |
| Account | relation → Accounts |
| Security | relation → Securities |
| Quantity | number (plain, fractional) |
| Last Update | datetime |
| Formula | formula — market value (Quantity × Security close-price rollup); exact expression to confirm in Notion UI |

View grouped by Account.

### Investment Transactions
| Property | Type |
|---|---|
| Transaction Summary (title) | e.g. "Buy", "Funds Received", "VANGUARD TARGET 2065 - withdrawal" |
| Transaction ID | text |
| Transaction Type | select: `buy`, `cash`, (`sell`, `fee`, `transfer` per Plaid) |
| Transaction Subtype | select: `buy`, `dividend`, `deposit`, `withdrawal`, `contribution`, … |
| Amount / Price | number ($) — withdrawals negative |
| Quantity / Fees | number (plain) |
| Date | date |
| Related Account | relation → Accounts |
| Related Security | relation → Securities (nullable) |

View grouped by Related Account, Date desc.

### Categories — Plaid PFC taxonomy
| Property | Type |
|---|---|
| Name (title) | e.g. "Electronics" |
| ID | text — Plaid enum, e.g. `GENERAL_MERCHANDISE_ELECTRONICS` |
| Category Group | select — 15 groups (Merchandise, Food and Drink, Income, Travel, …) |

Sorted Name asc.

### Transactions
| Property | Type |
|---|---|
| Summary (title) | raw statement descriptor |
| ID | text |
| Account | relation → Accounts |
| Category | relation → Categories |
| Amount | number ($) — **negative = outflow** |
| Date | datetime |
| Is Pending? | checkbox |
| Merchant Name | text (nullable) |

Sorted Date desc.

Notes:
- Relations are one-directional (no reverse properties on the target DBs).
- Each DB gets an emoji or one of our own hosted icons.
- The Notion API has limited control over view config (sorts/grouping); replicate what's possible, don't block on it.

## Architecture

```
React SPA (Vite + TanStack Router/Query + Tailwind + shadcn)
        │ Convex client
        ▼
Convex (data store + functions)
  ├─ mutations/queries: users, bank connections, notion destination, sync state
  ├─ actions: Plaid API calls, Notion API calls, sync engine
  ├─ http actions: /plaid/webhook  (and /notion/oauth/callback if OAuth)
  └─ cron: daily balance snapshot + safety backfill sync
        │                          │
        ▼                          ▼
     Plaid API                 Notion API
```

### What Convex stores (and doesn't)

Stored — config and sync bookkeeping only:
- `users` — auth identity
- `bankConnections` — Plaid item ID, **access token** (Plaid tokens are scoped, read-only), institution name/ID, status (active/error), last sync
- `accounts` — Plaid account ID, name, mask, type/subtype, selected-for-sync flag. (Metadata needed for the UI; balances are fetched live and written straight to Notion.)
- `notionConnections` — Notion token, workspace, target page ID, created database IDs, module toggles, sync start date
- `syncState` — Plaid `transactions/sync` cursor per item; **providerId → Notion page ID map** (transactions, holdings, securities, investment txns); sync run log for the UI
- `rules` (phase 2) — rule config

Not stored: amounts, merchants, dates, balances, holdings — no financial data at rest. The ID map is the one thing that makes update-in-place/dedup possible without querying Notion per-transaction (Notion's ~3 req/s rate limit makes query-based dedup impractical). It's opaque IDs only. (Open question #3 if you want it even leaner.)

### Sync engine (Convex actions)

1. **Trigger**: Plaid webhook (`SYNC_UPDATES_AVAILABLE`, `HOLDINGS: DEFAULT_UPDATE`, `INVESTMENTS_TRANSACTIONS: DEFAULT_UPDATE`) → Convex http action → schedule sync for that item. Also: manual "Sync now" button, daily cron.
2. **Transactions**: `transactions/sync` with stored cursor → `added` (create Notion pages), `modified` (patch existing page via ID map — pending→posted, amount fixups), `removed` (archive the Notion page). Categories: ensure PFC category page exists, relate.
3. **Accounts/balances**: `accounts/get` → update Accounts DB rows; daily cron appends Balance History rows (one per account per day, keyed so re-runs don't duplicate).
4. **Investments**: `investments/holdings/get` + `investments/transactions/get` → upsert Securities, Holdings, Investment Transactions.
5. Notion writes go through a rate-limited queue (≤3 rps, retry on 409/429), batched via Convex scheduler so long backfills survive.
6. First sync: backfill from the configured start date (default 2 years).

### App pages

- **Onboarding**: sign in → connect Notion → pick page → pick modules + start date → connect bank(s) via Plaid Link → first sync with progress.
- **Accounts**: bank connections with status, last sync, account list with sync toggles; add connection (Plaid Link); reconnect (Link update mode); remove.
- **Destination (Notion)**: target page, modules, start date, manual sync, sync history log.
- **Rules** (phase 2), **Settings** (profile, disconnect everything).

## Phases

1. **Scaffold** — Vite + React + TS, TanStack Router/Query, Tailwind, shadcn (base theme), Convex, auth. Deploy skeleton.
2. **Plaid connect** — Link flow, token exchange, connections/accounts in Convex, Accounts UI, webhook endpoint + signature verification.
3. **Notion connect + DB creation** — token/OAuth, page picker, create the 8 databases with exact schema above.
4. **Core sync** — transactions sync (cursor, upsert, pending→posted, removals), accounts + balance history, categories, manual sync, cron backfill, sync log UI.
5. **Investments** — securities/holdings/investment transactions sync.
6. **Rules + polish** — rules engine (categorize/rename/hide), reconnect flow, error states, empty states.

## Decisions (2026-08-12)

1. **Multi-user** — Notion public OAuth integration; Plaid production eventually.
2. Stephen has a Plaid account; develop on Sandbox first.
3. **ID map in Convex approved** (cursor + providerId→Notion page id, opaque ids only).
4. **Convex Auth with Google sign-in.**
5. v1 always creates fresh databases; rules engine and map-to-existing deferred.
6. Schema need not replicate the baseline exactly — improvements proposed and pending Stephen's sign-off (see conversation).

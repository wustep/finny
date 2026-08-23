# Finny

Phases 1–6 shipped. Product and setup live in the
[README](README.md). The live Notion schema is
[`convex/notionSchemas.ts`](convex/notionSchemas.ts) — the property tables
that used to live here were the original intent, not the current contract.

## Decisions (2026-08-12)

1. **Multi-user** — Notion public OAuth integration; Plaid production eventually.
2. Stephen has a Plaid account; develop on Sandbox first.
3. **ID map in Convex approved** (cursor + providerId→Notion page id, opaque ids only).
4. **Convex Auth with Google sign-in.**
5. v1 always creates fresh databases; rules engine and map-to-existing deferred.
6. Schema need not replicate the baseline exactly — improvements proposed and pending Stephen's sign-off (see conversation).

# Finny

Sync your financial data to Notion. Connect banks through Plaid; Finny creates
and maintains databases (accounts, transactions, balances, investments) inside
a Notion page you choose. One-way sync, no financial data stored anywhere but
Notion.

- **Stack**: Vite + React + TanStack Router/Query + Tailwind + shadcn/ui,
  Convex (auth, config, sync engine), Plaid, Notion API.
- **[PLAN.md](PLAN.md)** — architecture, Notion schema, phases.
- **[SETUP.md](SETUP.md)** — one-time provisioning (Convex, Google OAuth,
  Plaid, Notion).

```bash
npm install
npx convex dev   # first run provisions the backend (see SETUP.md)
npm run dev
```

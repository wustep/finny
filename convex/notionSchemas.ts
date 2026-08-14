// Notion database property schemas (API version 2022-06-28).
// The baseline schema with the deviations approved in PLAN.md.

type Props = Record<string, unknown>;

const dollar = { number: { format: "dollar" } };
const percent = { number: { format: "percent" } };
const plainNumber = { number: { format: "number" } };
const text = { rich_text: {} };
const date = { date: {} };

function select(options: Array<[name: string, color: string]>) {
  return { select: { options: options.map(([name, color]) => ({ name, color })) } };
}

function relation(databaseId: string) {
  return {
    relation: {
      database_id: databaseId,
      type: "single_property",
      single_property: {},
    },
  };
}

export interface DatabaseSpec {
  key: string;
  title: string;
  emoji: string;
  properties: (ids: Record<string, string>) => Props;
}

export const DATABASE_SPECS: DatabaseSpec[] = [
  {
    key: "bankConnections",
    title: "Bank Connections",
    emoji: "🏦",
    properties: () => ({
      Name: { title: {} },
      ID: text,
      Status: select([
        ["Active", "green"],
        ["Error", "red"],
        ["Pending expiration", "yellow"],
      ]),
      "Last Update": date,
    }),
  },
  {
    key: "accounts",
    title: "Accounts",
    emoji: "💳",
    properties: (ids) => ({
      "Account Name": { title: {} },
      ID: text,
      "Account Type": select([
        ["depository", "red"],
        ["credit", "brown"],
        ["investment", "gray"],
        ["loan", "purple"],
        ["other", "default"],
      ]),
      "Account Subtype": select([
        ["checking", "gray"],
        ["savings", "blue"],
        ["credit card", "orange"],
        ["brokerage", "green"],
        ["ira", "blue"],
        ["roth", "red"],
        ["401k", "yellow"],
        ["529", "pink"],
        ["hsa", "purple"],
        ["money market", "brown"],
        ["cd", "default"],
      ]),
      "Current Balance": dollar,
      "Available Balance": dollar,
      "Account Limit": dollar,
      "Next Payment Due": date,
      "Minimum Payment": dollar,
      "Last Statement Balance": dollar,
      APR: percent,
      "Bank Connection": relation(ids.bankConnections),
    }),
  },
  {
    key: "balanceHistory",
    title: "Balance History",
    emoji: "📈",
    properties: (ids) => ({
      Summary: { title: {} },
      Account: relation(ids.accounts),
      Balance: dollar,
      Date: date,
    }),
  },
  {
    key: "categories",
    title: "Categories",
    emoji: "🏷️",
    properties: () => ({
      Name: { title: {} },
      ID: text,
      "Category Group": select([
        ["Income", "default"],
        ["Transfer", "yellow"],
        ["Loan Payment", "red"],
        ["Bank Fees", "orange"],
        ["Entertainment", "pink"],
        ["Food and Drink", "blue"],
        ["Merchandise", "orange"],
        ["Home Improvement", "purple"],
        ["Medical", "green"],
        ["Personal Care", "gray"],
        ["General Services", "red"],
        ["Government and Non-Profit", "gray"],
        ["Transportation", "brown"],
        ["Travel", "default"],
        ["Rent and Utilities", "orange"],
      ]),
    }),
  },
  {
    key: "transactions",
    title: "Transactions",
    emoji: "🧾",
    properties: (ids) => ({
      Name: { title: {} },
      ID: text,
      "Original Description": text,
      Account: relation(ids.accounts),
      Category: relation(ids.categories),
      Amount: dollar,
      Date: date,
      Pending: { checkbox: {} },
    }),
  },
  {
    key: "securities",
    title: "Securities",
    emoji: "📊",
    properties: () => ({
      Symbol: { title: {} },
      "Security Name": text,
      ID: text,
      Type: select([
        ["equity", "green"],
        ["etf", "blue"],
        ["mutual fund", "purple"],
        ["cash", "gray"],
        ["fixed income", "brown"],
        ["cryptocurrency", "orange"],
        ["derivative", "red"],
        ["other", "default"],
      ]),
      "Close Price": dollar,
      "Close Price As Of": date,
    }),
  },
  {
    key: "holdings",
    title: "Holdings",
    emoji: "💼",
    properties: (ids) => ({
      Summary: { title: {} },
      Account: relation(ids.accounts),
      Security: relation(ids.securities),
      Quantity: plainNumber,
      "Cost Basis": dollar,
      // Market value is left to the user: Notion rejects a rollup that points
      // at a relation created in the same request, so a Security Price rollup
      // and a Quantity * price formula have to be added by hand afterwards.
      "Last Update": date,
    }),
  },
  {
    key: "investmentTransactions",
    title: "Investment Transactions",
    emoji: "🔁",
    properties: (ids) => ({
      "Transaction Summary": { title: {} },
      "Transaction ID": text,
      "Transaction Type": select([
        ["buy", "green"],
        ["sell", "red"],
        ["cash", "gray"],
        ["fee", "orange"],
        ["transfer", "blue"],
      ]),
      "Transaction Subtype": select([
        ["buy", "green"],
        ["sell", "red"],
        ["dividend", "blue"],
        ["deposit", "orange"],
        ["withdrawal", "yellow"],
        ["contribution", "brown"],
        ["interest", "purple"],
        ["transfer", "default"],
        ["distribution", "pink"],
      ]),
      Amount: dollar,
      Price: dollar,
      Quantity: plainNumber,
      Fees: dollar,
      Date: date,
      "Related Account": relation(ids.accounts),
      "Related Security": relation(ids.securities),
    }),
  },
];

// Which logical databases each tracking module needs. Bank Connections and
// Accounts are always created (everything relates to them).
export const MODULE_DATABASES: Record<string, string[]> = {
  base: ["bankConnections", "accounts"],
  balances: ["balanceHistory"],
  spending: ["categories", "transactions"],
  investments: ["securities", "holdings", "investmentTransactions"],
};

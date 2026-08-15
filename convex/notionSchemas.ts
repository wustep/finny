// Notion database property schemas (API version 2022-06-28).
// The baseline schema with the deviations approved in PLAN.md.

import { PFC_TAXONOMY } from "./rulesEngine";
import { titleCase } from "./syncMappers";

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

// The Category Group options, derived from the taxonomy rather than listed
// again beside it. The hand-written list had drifted: it was missing Transfer
// In, Transfer Out, Loan Disbursements and Other outright, and called two
// others by names titleCase does not produce ("Merchandise" for General
// Merchandise, "Government and Non-Profit" for Government and Non Profit).
// Every one of those made Notion auto-create the option with a random colour
// the first time a category landed in it.
const GROUP_COLORS: Record<string, string> = {
  INCOME: "green",
  TRANSFER_IN: "yellow",
  TRANSFER_OUT: "yellow",
  LOAN_DISBURSEMENTS: "red",
  LOAN_PAYMENTS: "red",
  BANK_FEES: "orange",
  ENTERTAINMENT: "pink",
  FOOD_AND_DRINK: "blue",
  GENERAL_MERCHANDISE: "orange",
  HOME_IMPROVEMENT: "purple",
  MEDICAL: "green",
  PERSONAL_CARE: "gray",
  GENERAL_SERVICES: "red",
  GOVERNMENT_AND_NON_PROFIT: "gray",
  TRANSPORTATION: "brown",
  TRAVEL: "default",
  RENT_AND_UTILITIES: "orange",
  OTHER: "default",
};

export const CATEGORY_GROUP_OPTIONS: Array<[name: string, color: string]> =
  Object.keys(PFC_TAXONOMY).map((primary) => [
    // The same name categoryName gives the row, so the option always exists
    // before a row needs it.
    titleCase(primary),
    GROUP_COLORS[primary] ?? "default",
  ]);

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
      // Plaid Link is configured for the US and Canada, and every money
      // column here is dollar-formatted. Without this a CAD account's numbers
      // sit in a $ column with nothing saying which dollar.
      Currency: select([
        ["USD", "green"],
        ["CAD", "red"],
      ]),
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
      "Category Group": select(CATEGORY_GROUP_OPTIONS),
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
    key: "recurring",
    title: "Recurring",
    emoji: "🔄",
    properties: (ids) => ({
      Stream: { title: {} },
      ID: text,
      Account: relation(ids.accounts),
      // Plaid works out which transactions belong to a stream, so this is one
      // row per subscription or paycheque rather than per payment.
      Direction: select([
        ["Inflow", "green"],
        ["Outflow", "red"],
      ]),
      Frequency: select([
        ["Weekly", "blue"],
        ["Biweekly", "purple"],
        ["Semi Monthly", "pink"],
        ["Monthly", "orange"],
        ["Annually", "brown"],
        ["Unknown", "default"],
      ]),
      "Average Amount": dollar,
      "Last Amount": dollar,
      "First Date": date,
      "Last Date": date,
      "Predicted Next Date": date,
      Active: { checkbox: {} },
      // Plaid keeps a stream around once it has seen one, so a cancelled
      // subscription becomes inactive rather than disappearing — which is
      // more useful than deleting it, and means nothing here ever needs
      // archiving.
      Status: select([
        ["Mature", "green"],
        ["Early Detection", "yellow"],
        ["Tombstoned", "gray"],
        ["Unknown", "default"],
      ]),
      // Only when Spending is on, since that is what builds Categories. A
      // relation to a database that was never created is not a relation.
      ...(ids.categories ? { Category: relation(ids.categories) } : {}),
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
  recurring: ["recurring"],
};

// Which notionPageMap kinds keep their page ids in each database. A database
// that had to be rebuilt takes its rows with it, so the map entries pointing
// into it are addresses of pages that no longer exist and have to go too —
// otherwise every later sync patches a 404 and the whole page fails.
export const MAP_KINDS_BY_DATABASE: Record<string, string[]> = {
  bankConnections: ["bankConnection"],
  accounts: ["account"],
  recurring: ["recurringStream"],
  balanceHistory: ["balanceSnapshot"],
  categories: ["category"],
  transactions: ["transaction"],
  securities: ["security"],
  holdings: ["holding"],
  investmentTransactions: ["investmentTransaction"],
};

export const SPEC_BY_KEY: Record<string, DatabaseSpec> = Object.fromEntries(
  DATABASE_SPECS.map((spec) => [spec.key, spec]),
);

// The Notion property type each spec asks for, as property name -> type
// ("title", "rich_text", "number", …). A spec's property value is a one-key
// object whose key is the type, which is what this reads.
export function propertyTypes(spec: DatabaseSpec): Record<string, string> {
  const types: Record<string, string> = {};
  for (const [name, definition] of Object.entries(spec.properties(RELATION_PROBE))) {
    const type = Object.keys(definition as object)[0];
    if (type) {
      types[name] = type;
    }
  }
  return types;
}

// Hands every spec a marked string for any database id it asks for, so the
// relations it builds can be read back out of the result. Deriving the
// dependency graph this way rather than writing it down twice means a spec
// that gains or loses a relation cannot get out of step with it.
const RELATION_PROBE = new Proxy({} as Record<string, string>, {
  get: (_target, key) => `__depends-on:${String(key)}__`,
});

export interface RelationDependency {
  // The database holding the relation property.
  from: string;
  // The database it points at.
  to: string;
  // The property on `from` that holds it.
  property: string;
}

// Every relation between the databases Finny creates.
//
// Needed because a database that has to be rebuilt gets a new id, and every
// relation pointing at the old one goes dead: Notion stores the target's id in
// the property, not its name. Rebuilding Accounts without repointing
// Transactions leaves a relation column that can never be filled in again.
export function relationDependencies(): RelationDependency[] {
  const dependencies: RelationDependency[] = [];
  for (const spec of DATABASE_SPECS) {
    for (const [property, definition] of Object.entries(
      spec.properties(RELATION_PROBE),
    )) {
      const target = (definition as { relation?: { database_id?: string } })
        .relation?.database_id;
      const match = target?.match(/^__depends-on:(.+)__$/);
      if (match) {
        dependencies.push({ from: spec.key, to: match[1], property });
      }
    }
  }
  return dependencies;
}

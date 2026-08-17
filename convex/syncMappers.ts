// Pure Plaid -> Notion value mapping: property names, naming rules, and the
// money/sign conventions.
//
// This file deliberately imports nothing but Plaid *types*. It is not a
// Convex function module and never talks to Plaid or Notion, so the
// conventions below can be unit tested without a runtime (see
// syncMappers.test.ts). The Notion property names here are a live contract
// with the databases created by notionSchemas.ts — changing one renames a
// column users already have data in.

import type {
  AccountBase,
  CreditCardLiability,
  Holding,
  InvestmentTransaction,
  Transaction,
  TransactionStream,
} from "plaid";
import type { PropertyValue, RuleTransaction } from "./rulesEngine";
import { renderTitle } from "./titleFormats";

// The title templates a destination has set, keyed by database. Threaded
// through every mapper so a title is decided in one place rather than by
// whichever line of code happened to build the row.
export type TitleFormats = Record<string, string> | undefined;

// ---------- property value builders ----------

const clip = (s: string) => s.slice(0, 2000);

export const P = {
  title: (s: string) => ({
    title: [{ type: "text", text: { content: clip(s || "Untitled") } }],
  }),
  text: (s: string | null | undefined) => ({
    rich_text: s ? [{ type: "text", text: { content: clip(s) } }] : [],
  }),
  number: (n: number | null | undefined) => ({
    number: typeof n === "number" && Number.isFinite(n) ? n : null,
  }),
  date: (s: string | null | undefined) => ({
    date: s ? { start: s } : null,
  }),
  // Select option names cannot contain commas.
  select: (name: string | null | undefined) =>
    name ? { select: { name: clip(name).replaceAll(",", " ") } } : { select: null },
  relation: (pageId: string | null | undefined) => ({
    relation: pageId ? [{ id: pageId }] : [],
  }),
  // Notion creates the options as they are used, so anything here is valid —
  // except a comma, which it refuses inside an option name.
  multiSelect: (names: string[]) => ({
    multi_select: names.map((name) => ({
      name: clip(name).replaceAll(",", " "),
    })),
  }),
  checkbox: (b: boolean) => ({ checkbox: b }),
  status: (name: string | null | undefined) =>
    name ? { status: { name: clip(name).replaceAll(",", " ") } } : { status: null },
};

// One of the user's own properties, as Notion wants it written. Each shape is
// a different key in Notion's API, which is why the rule stores which one it
// meant rather than guessing from the value.
export function propertyValue(value: PropertyValue): unknown {
  switch (value.type) {
    case "select":
      return P.select(value.option);
    case "status":
      return P.status(value.option);
    case "multiSelect":
      return P.multiSelect(value.options);
    case "checkbox":
      return P.checkbox(value.checked);
  }
}

// An icon hosted elsewhere. Notion stores the URL and renders it directly,
// so unlike an uploaded file this costs nothing and needs no bookkeeping —
// but it breaks if whoever hosts it stops serving that URL.
export function externalIcon(url: string): Record<string, unknown> {
  return { type: "external", external: { url } };
}

// ---------- naming helpers ----------

// "FOOD_AND_DRINK" -> "Food and Drink"
export function titleCase(enumValue: string): string {
  return enumValue
    .toLowerCase()
    .split("_")
    .map((word) =>
      word === "and" || word === "of" ? word : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
}

// "Chase" + "Freedom Unlimited" + "7449" -> "Chase Freedom Unlimited *7449",
// unless the user renamed the account, in which case their name wins.
export function accountTitle(
  institutionName: string,
  account: {
    name: string;
    official_name?: string | null;
    mask?: string | null;
  },
  customName?: string,
): string {
  if (customName) {
    return customName;
  }
  const base =
    account.official_name && account.official_name.length >= account.name.length
      ? account.official_name
      : account.name;
  const institutionWord = institutionName.split(" ")[0]?.toLowerCase() ?? "";
  const withInstitution =
    institutionWord && base.toLowerCase().startsWith(institutionWord)
      ? base
      : `${institutionName} ${base}`;
  return account.mask ? `${withInstitution} *${account.mask}` : withInstitution;
}

// ---------- property mappers ----------

// Plaid: positive = money out. Notion convention: negative = outflow.
// Plaid enriches known merchants with a hosted logo. Coverage is partial —
// card transactions far more often than ACH — and a transaction with no
// merchant behind it simply keeps Notion's default icon.
export function transactionIcon(txn: Transaction) {
  const url = txn.logo_url ?? txn.counterparties?.[0]?.logo_url;
  return url ? externalIcon(url) : undefined;
}

// The title a transaction row gets: Plaid's cleaned merchant name, falling
// back to the raw description. A rule's rename outcome replaces it — and only
// it, so Original Description still carries what the bank actually said.
export function transactionTitle(txn: Transaction, rename?: string): string {
  return rename || txn.merchant_name || txn.name || "Transaction";
}

// What a rule looks at, out of a Plaid transaction.
//
// `merchant` is the same string the Notion title uses, so a merchant rule
// matches what the user sees rather than a field that is null for most ACH
// transactions. `description` is the bank's own string, as synced to Original
// Description. `amount` keeps Plaid's sign (positive = money out); Notion's
// column has it flipped. `accountRowId` is the Convex accounts id, which is
// what a rule's account condition stores. `category` is what Plaid decided
// before any rule had a say — a rule that overrides the category still
// matches on the original, which is the only stable thing to match on.
export function ruleTransaction(
  txn: Transaction,
  accountRowId?: string,
): RuleTransaction {
  return {
    merchant: txn.merchant_name ?? txn.name,
    description: txn.original_description ?? txn.name,
    amount: txn.amount,
    accountId: accountRowId,
    category: txn.personal_finance_category?.detailed,
    pending: txn.pending,
  };
}

export function transactionProperties(
  txn: Transaction,
  accountPageId: string,
  categoryPageId: string | null,
  rename?: string,
  // The user's own properties a rule set, already resolved. Written only when
  // a rule set some: writing a property the database does not have fails the
  // whole row, so nothing here is written speculatively.
  properties: Record<string, PropertyValue> = {},
  // The destination's template for this database, and the names a template
  // can refer to that the mapper alone knows.
  formats?: TitleFormats,
  named?: { account?: string; category?: string },
) {
  const fallback = transactionTitle(txn, rename);
  return {
    // A rule's rename is the specific case and beats the format; without one,
    // the template decides.
    Name: P.title(
      rename
        ? fallback
        : renderTitle(
            formats?.transactions,
            {
              merchant: txn.merchant_name ?? txn.name,
              description: txn.original_description ?? txn.name,
              amount: -txn.amount,
              date: txn.date,
              account: named?.account,
              category: named?.category,
            },
            fallback,
            txn.iso_currency_code ?? txn.unofficial_currency_code ?? undefined,
          ),
    ),
    ID: P.text(txn.transaction_id),
    "Original Description": P.text(txn.original_description ?? txn.name),
    Account: P.relation(accountPageId),
    Category: P.relation(categoryPageId),
    Amount: P.number(-txn.amount),
    Date: P.date(txn.datetime ?? txn.authorized_datetime ?? txn.date),
    Pending: P.checkbox(txn.pending),
    ...Object.fromEntries(
      Object.entries(properties).map(([name, value]) => [
        name,
        propertyValue(value),
      ]),
    ),
  };
}

// Credit-card balances arrive positive from Plaid (amount owed) and stay
// positive in Notion, so no sign flip here.
export function balanceForNotion(account: AccountBase): number | null {
  return account.balances.current ?? account.balances.available ?? null;
}

export function accountProperties(
  institutionName: string,
  account: AccountBase,
  credit: CreditCardLiability | undefined,
  connectionPageId: string,
  customName?: string,
) {
  const apr = credit?.aprs?.find(
    (entry) => entry.apr_type === "purchase_apr",
  )?.apr_percentage;
  return {
    "Account Name": P.title(accountTitle(institutionName, account, customName)),
    ID: P.text(account.account_id),
    "Account Type": P.select(account.type),
    "Account Subtype": P.select(
      account.subtype ? account.subtype.replaceAll("_", " ") : null,
    ),
    "Current Balance": P.number(account.balances.current),
    "Available Balance": P.number(account.balances.available),
    "Account Limit": P.number(account.balances.limit),
    // Which dollar. Plaid Link is configured for the US and Canada and every
    // money column is dollar-formatted, so an account in CAD is otherwise
    // indistinguishable from one in USD. unofficial_currency_code is what
    // Plaid falls back to for currencies it has no ISO code for.
    Currency: P.select(
      account.balances.iso_currency_code ??
        account.balances.unofficial_currency_code ??
        null,
    ),
    "Next Payment Due": P.date(credit?.next_payment_due_date ?? null),
    "Minimum Payment": P.number(credit?.minimum_payment_amount),
    "Last Statement Balance": P.number(credit?.last_statement_balance),
    // Notion percent format renders 0.2499 as 24.99%.
    APR: P.number(typeof apr === "number" ? apr / 100 : null),
    "Bank Connection": P.relation(connectionPageId),
  };
}

// Plaid cash flows: positive = out of the account. For cash-type rows we
// flip so deposits/contributions read positive in Notion; trade rows
// (buy/sell) keep Plaid's sign.
export function investmentTransactionProperties(
  txn: InvestmentTransaction,
  accountPageId: string,
  securityPageId: string | null | undefined,
  formats?: TitleFormats,
  named?: { account?: string; security?: string },
) {
  const amount = txn.type === "cash" ? -txn.amount : txn.amount;
  const fallback = txn.name || titleCase(txn.subtype ?? txn.type);
  return {
    "Transaction Summary": P.title(
      renderTitle(
        formats?.investmentTransactions,
        {
          name: txn.name,
          type: txn.type,
          subtype: txn.subtype ? titleCase(txn.subtype) : null,
          security: named?.security,
          amount,
          quantity: txn.quantity,
          date: txn.date,
          account: named?.account,
        },
        fallback,
        txn.iso_currency_code ?? txn.unofficial_currency_code ?? undefined,
      ),
    ),
    "Transaction ID": P.text(txn.investment_transaction_id),
    "Transaction Type": P.select(txn.type),
    "Transaction Subtype": P.select(
      txn.subtype ? txn.subtype.replaceAll("_", " ") : null,
    ),
    Amount: P.number(amount),
    Price: P.number(txn.price),
    Quantity: P.number(txn.quantity),
    Fees: P.number(txn.fees ?? 0),
    Date: P.date(txn.date),
    "Related Account": P.relation(accountPageId),
    "Related Security": P.relation(securityPageId),
  };
}

// One position in one account. Market Value is Plaid's `institution_value`,
// not a quantity × price we compute — the institution has already done that
// sum, including cash and fractional shares, and it is the number a formula
// in Notion would have been trying to reconstruct.
export function holdingProperties(
  holding: Holding,
  accountPageId: string,
  securityPageId: string | undefined,
  symbol: string,
  formats?: TitleFormats,
  named?: { account?: string },
  lastUpdate: string = new Date().toISOString(),
) {
  return {
    Summary: P.title(
      renderTitle(
        formats?.holdings,
        {
          security: symbol,
          quantity: holding.quantity,
          value: holding.institution_value,
          price: holding.institution_price,
          account: named?.account,
        },
        `${symbol} Holding`,
        holding.iso_currency_code ?? undefined,
      ),
    ),
    Account: P.relation(accountPageId),
    Security: P.relation(securityPageId),
    Quantity: P.number(holding.quantity),
    "Cost Basis": P.number(holding.cost_basis),
    "Market Value": P.number(holding.institution_value),
    "Institution Price": P.number(holding.institution_price),
    "Institution Price As Of": P.date(holding.institution_price_as_of),
    "Last Update": P.date(lastUpdate),
  };
}

// A recurring stream — one subscription, salary, or standing order, which
// Plaid works out for itself from the transactions it has already sent.
//
// Amounts keep the same convention as everything else here: Plaid's positive
// is money out, and Notion's column is flipped, so both amounts are negated.
// Direction then carries what the sign used to have to imply.
export function recurringStreamProperties(
  stream: TransactionStream,
  direction: "Inflow" | "Outflow",
  accountPageId: string,
  categoryPageId: string | null,
  hasCategoryRelation: boolean,
  formats?: TitleFormats,
  named?: { account?: string },
) {
  const fallback = stream.merchant_name || stream.description;
  return {
    Stream: P.title(
      renderTitle(
        formats?.recurring,
        {
          merchant: fallback,
          frequency: titleCase(String(stream.frequency)),
          direction,
          amount: negated(stream.average_amount?.amount),
          account: named?.account,
        },
        fallback,
        stream.average_amount?.iso_currency_code ?? undefined,
      ),
    ),
    ID: P.text(stream.stream_id),
    Account: P.relation(accountPageId),
    Direction: P.select(direction),
    Frequency: P.select(titleCase(String(stream.frequency))),
    "Average Amount": P.number(negated(stream.average_amount?.amount)),
    "Last Amount": P.number(negated(stream.last_amount?.amount)),
    "First Date": P.date(stream.first_date),
    "Last Date": P.date(stream.last_date),
    "Predicted Next Date": P.date(stream.predicted_next_date ?? null),
    Active: P.checkbox(stream.is_active),
    Status: P.select(titleCase(String(stream.status))),
    // The relation only exists when Spending built the Categories database;
    // writing a property the database does not have is a 400 for the row.
    ...(hasCategoryRelation ? { Category: P.relation(categoryPageId) } : {}),
  };
}

function negated(amount: number | null | undefined): number | null {
  return typeof amount === "number" && Number.isFinite(amount) ? -amount : null;
}

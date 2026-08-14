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
  InvestmentTransaction,
  Transaction,
} from "plaid";
import type { RuleTransaction } from "./rulesEngine";

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
  checkbox: (b: boolean) => ({ checkbox: b }),
};

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
// what a rule's account condition stores.
export function ruleTransaction(
  txn: Transaction,
  accountRowId?: string,
): RuleTransaction {
  return {
    merchant: txn.merchant_name ?? txn.name,
    description: txn.original_description ?? txn.name,
    amount: txn.amount,
    accountId: accountRowId,
  };
}

export function transactionProperties(
  txn: Transaction,
  accountPageId: string,
  categoryPageId: string | null,
  rename?: string,
) {
  return {
    Name: P.title(transactionTitle(txn, rename)),
    ID: P.text(txn.transaction_id),
    "Original Description": P.text(txn.original_description ?? txn.name),
    Account: P.relation(accountPageId),
    Category: P.relation(categoryPageId),
    Amount: P.number(-txn.amount),
    Date: P.date(txn.datetime ?? txn.authorized_datetime ?? txn.date),
    Pending: P.checkbox(txn.pending),
  };
}

// Credit-card balances arrive positive from Plaid (amount owed), matching
// the [redacted] convention, so no sign flip here.
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
    "Next Payment Due": P.date(credit?.next_payment_due_date ?? null),
    "Minimum Payment": P.number(credit?.minimum_payment_amount),
    "Last Statement Balance": P.number(credit?.last_statement_balance),
    // Notion percent format renders 0.2499 as 24.99%.
    APR: P.number(typeof apr === "number" ? apr / 100 : null),
    "Bank Connection": P.relation(connectionPageId),
  };
}

// Plaid cash flows: positive = out of the account. For cash-type rows we
// flip so deposits/contributions read positive in Notion ([redacted] convention);
// trade rows (buy/sell) keep Plaid's sign.
export function investmentTransactionProperties(
  txn: InvestmentTransaction,
  accountPageId: string,
  securityPageId: string | null | undefined,
) {
  const amount = txn.type === "cash" ? -txn.amount : txn.amount;
  return {
    "Transaction Summary": P.title(txn.name || titleCase(txn.subtype ?? txn.type)),
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

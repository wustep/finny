// The money conventions are the part of the sync nobody notices until the
// numbers are wrong, so they are pinned here. Plain vitest — syncMappers.ts
// is pure, so no Convex or Notion runtime is involved.

import type {
  AccountBase,
  CreditCardLiability,
  InvestmentTransaction,
  Transaction,
} from "plaid";
import { describe, expect, it } from "vitest";
import {
  accountProperties,
  balanceForNotion,
  investmentTransactionProperties,
  transactionProperties,
} from "./syncMappers";

// Plaid's generated types spell type/subtype as string enums, so the
// fixtures take loose overrides and cast once at the boundary.
type Overrides = Record<string, unknown>;

function transaction(overrides: Overrides = {}): Transaction {
  return {
    account_id: "acc_1",
    amount: 12.34,
    iso_currency_code: "USD",
    unofficial_currency_code: null,
    date: "2026-08-01",
    name: "BLUE BOTTLE COFFEE #23",
    pending: false,
    transaction_id: "txn_1",
    ...overrides,
  } as Transaction;
}

function investmentTransaction(overrides: Overrides = {}): InvestmentTransaction {
  return {
    investment_transaction_id: "inv_1",
    account_id: "acc_1",
    security_id: "sec_1",
    date: "2026-08-01",
    name: "Contribution",
    quantity: 1,
    amount: 500,
    price: 0,
    fees: null,
    type: "cash",
    subtype: "contribution",
    iso_currency_code: "USD",
    unofficial_currency_code: null,
    ...overrides,
  } as InvestmentTransaction;
}

function account(overrides: Overrides = {}): AccountBase {
  return {
    account_id: "acc_1",
    name: "Freedom Unlimited",
    mask: "7449",
    type: "credit",
    subtype: "credit card",
    balances: {
      current: 842.11,
      available: 4157.89,
      limit: 5000,
      iso_currency_code: "USD",
      unofficial_currency_code: null,
    },
    ...overrides,
  } as AccountBase;
}

describe("transactionProperties", () => {
  it("writes a Plaid outflow as negative dollars", () => {
    const properties = transactionProperties(
      transaction({ amount: 12.34 }),
      "page_account",
      null,
    );
    expect(properties.Amount).toEqual({ number: -12.34 });
  });

  it("writes a Plaid inflow (refund, deposit) as positive dollars", () => {
    const properties = transactionProperties(
      transaction({ amount: -12.34 }),
      "page_account",
      null,
    );
    expect(properties.Amount).toEqual({ number: 12.34 });
  });

  it("carries the pending flag through as a checkbox", () => {
    expect(
      transactionProperties(transaction({ pending: true }), "page_account", null)
        .Pending,
    ).toEqual({ checkbox: true });
    expect(
      transactionProperties(transaction({ pending: false }), "page_account", null)
        .Pending,
    ).toEqual({ checkbox: false });
  });

  it("leaves the Category relation empty when there is no category page", () => {
    const properties = transactionProperties(transaction(), "page_account", null);
    expect(properties.Category).toEqual({ relation: [] });
    expect(properties.Account).toEqual({ relation: [{ id: "page_account" }] });
  });
});

describe("investmentTransactionProperties", () => {
  it("flips the sign on cash rows so a contribution reads positive", () => {
    const properties = investmentTransactionProperties(
      investmentTransaction({ type: "cash", subtype: "contribution", amount: 500 }),
      "page_account",
      "page_security",
    );
    expect(properties.Amount).toEqual({ number: -500 });
  });

  it("flips the sign on cash rows so a withdrawal reads negative", () => {
    const properties = investmentTransactionProperties(
      investmentTransaction({ type: "cash", subtype: "withdrawal", amount: -250 }),
      "page_account",
      "page_security",
    );
    expect(properties.Amount).toEqual({ number: 250 });
  });

  it("keeps Plaid's sign on buy rows", () => {
    const properties = investmentTransactionProperties(
      investmentTransaction({ type: "buy", subtype: "buy", amount: 1000 }),
      "page_account",
      "page_security",
    );
    expect(properties.Amount).toEqual({ number: 1000 });
  });

  it("defaults missing fees to zero and allows a null security relation", () => {
    const properties = investmentTransactionProperties(
      investmentTransaction({ fees: null }),
      "page_account",
      null,
    );
    expect(properties.Fees).toEqual({ number: 0 });
    expect(properties["Related Security"]).toEqual({ relation: [] });
  });
});

describe("accountProperties", () => {
  const credit = (aprs: Array<Overrides> | undefined) =>
    ({ aprs }) as unknown as CreditCardLiability;

  it("keeps a credit card's current balance positive (amount owed)", () => {
    const properties = accountProperties(
      "Chase",
      account(),
      undefined,
      "page_connection",
    );
    expect(properties["Current Balance"]).toEqual({ number: 842.11 });
    expect(properties["Available Balance"]).toEqual({ number: 4157.89 });
  });

  it("scales the purchase APR into Notion's percent format", () => {
    const properties = accountProperties(
      "Chase",
      account(),
      credit([{ apr_type: "purchase_apr", apr_percentage: 24.99 }]),
      "page_connection",
    );
    expect(properties.APR.number).toBeCloseTo(0.2499, 10);
  });

  it("writes a null APR when the liability has none", () => {
    expect(
      accountProperties("Chase", account(), undefined, "page_connection").APR,
    ).toEqual({ number: null });
    expect(
      accountProperties("Chase", account(), credit(undefined), "page_connection")
        .APR,
    ).toEqual({ number: null });
    expect(
      accountProperties(
        "Chase",
        account(),
        credit([{ apr_type: "balance_transfer_apr", apr_percentage: 20 }]),
        "page_connection",
      ).APR,
    ).toEqual({ number: null });
  });

  it("titles the account from the institution, product, and mask", () => {
    const properties = accountProperties(
      "Chase",
      account(),
      undefined,
      "page_connection",
    );
    expect(properties["Account Name"]).toEqual({
      title: [
        { type: "text", text: { content: "Chase Freedom Unlimited *7449" } },
      ],
    });
  });
});

describe("balanceForNotion", () => {
  it("prefers the current balance", () => {
    expect(balanceForNotion(account())).toBe(842.11);
  });

  it("falls back to available, then to null", () => {
    expect(
      balanceForNotion(account({ balances: { current: null, available: 20 } })),
    ).toBe(20);
    expect(
      balanceForNotion(account({ balances: { current: null, available: null } })),
    ).toBeNull();
  });
});

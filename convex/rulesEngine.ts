// The transaction rules engine — pure, and deliberately free of Convex and
// network access so it can be unit tested on its own (see rulesEngine.test.ts).
//
// A rule lets the user override what a sync writes to Notion for the
// transactions it matches: a different category, a different title, or no
// Notion row at all. Evaluation happens in the sync pass-through
// (convex/sync.ts), not on stored data: Finny keeps no amounts, merchants, or
// dates, so there is nothing to re-run a rule against afterwards — only the
// next sync event for that transaction.
//
// Semantics: rules are ordered by priority ascending and the
// FIRST enabled rule whose conditions all match wins outright. Its outcomes
// are applied together and no later rule is consulted, so one rule can
// recategorise and rename at once, and a rule cannot be half-overridden by
// the one below it.
//
// Money sign: `amount` is Plaid's, where positive means money left the
// account and negative means money came in (a refund, a deposit). Notion
// shows the same transaction with the sign flipped (see syncMappers.ts), so
// an amount condition reads the opposite way round from the Notion column —
// the Rules page says as much next to the field.

import { titleCase } from "./syncMappers";

export type TextOp = "contains" | "equals" | "regex";
export type AmountOp = "lt" | "lte" | "gt" | "gte" | "eq";

export interface TextCondition {
  op: TextOp;
  value: string;
}

export interface AmountCondition {
  op: AmountOp;
  value: number;
}

// Conditions AND together: every one present has to hold. A rule with no
// conditions at all matches nothing — see `matches`.
export interface RuleConditions {
  merchant?: TextCondition;
  description?: TextCondition;
  amount?: AmountCondition;
  // Convex `Id<"accounts">` at the call site; a plain string here to keep
  // this module independent of the data model.
  accountId?: string;
}

export interface RuleOutcomes {
  // A Plaid personal finance category, e.g. GENERAL_MERCHANDISE_ELECTRONICS.
  categoryId?: string;
  // Replaces the Notion title. Original Description keeps the bank's string.
  rename?: string;
  hide?: boolean;
}

export interface Rule {
  id: string;
  priority: number;
  enabled: boolean;
  conditions: RuleConditions;
  outcomes: RuleOutcomes;
}

// What the engine needs to know about a transaction. Built from a Plaid
// transaction by `ruleTransaction` in syncMappers.ts.
export interface RuleTransaction {
  merchant?: string | null;
  description?: string | null;
  amount: number;
  accountId?: string;
}

export interface RuleMatch extends RuleOutcomes {
  ruleId: string;
}

// Longest pattern a rule may carry. The regex runs inside a sync action
// against strings from the user's own bank, so a pathological pattern can
// only slow that user's own sync down — but a bound is still cheaper than
// finding out.
export const MAX_PATTERN_LENGTH = 200;

// Dollar amounts carry cents, so exact equality on a float would depend on
// how the bank rounded.
const AMOUNT_EPSILON = 0.005;

export function evaluate(
  rules: Rule[],
  txn: RuleTransaction,
): RuleMatch | null {
  for (const rule of orderRules(rules)) {
    if (!rule.enabled) {
      continue;
    }
    if (matches(rule.conditions, txn)) {
      return { ruleId: rule.id, ...rule.outcomes };
    }
  }
  return null;
}

// Priority ascending. Callers read rules through the by_user_priority index
// and so already hand them over in order; sorting here means a caller that
// does not cannot silently change which rule wins. Equal priorities — only
// reachable if two writes raced — fall back to the id so the outcome is at
// least stable.
export function orderRules(rules: Rule[]): Rule[] {
  return [...rules].sort(
    (a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

function matches(conditions: RuleConditions, txn: RuleTransaction): boolean {
  let asked = 0;
  if (conditions.merchant) {
    asked++;
    if (!matchesText(conditions.merchant, txn.merchant)) {
      return false;
    }
  }
  if (conditions.description) {
    asked++;
    if (!matchesText(conditions.description, txn.description)) {
      return false;
    }
  }
  if (conditions.amount) {
    asked++;
    if (!matchesAmount(conditions.amount, txn.amount)) {
      return false;
    }
  }
  if (conditions.accountId) {
    asked++;
    if (conditions.accountId !== txn.accountId) {
      return false;
    }
  }
  // A rule that asks nothing would otherwise match every transaction, which
  // with a hide outcome empties the Transactions database. Writes reject an
  // empty condition set (convex/rules.ts); this is the second lock on it.
  return asked > 0;
}

function matchesText(
  condition: TextCondition,
  value: string | null | undefined,
): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const subject = value.trim();
  const needle = condition.value.trim();
  if (subject === "" || needle === "") {
    return false;
  }
  switch (condition.op) {
    case "contains":
      return subject.toLowerCase().includes(needle.toLowerCase());
    case "equals":
      return subject.toLowerCase() === needle.toLowerCase();
    case "regex": {
      const pattern = compilePattern(needle);
      return pattern ? pattern.test(subject) : false;
    }
  }
}

function matchesAmount(condition: AmountCondition, amount: number): boolean {
  if (!Number.isFinite(condition.value) || !Number.isFinite(amount)) {
    return false;
  }
  switch (condition.op) {
    case "lt":
      return amount < condition.value;
    case "lte":
      return amount <= condition.value;
    case "gt":
      return amount > condition.value;
    case "gte":
      return amount >= condition.value;
    case "eq":
      return Math.abs(amount - condition.value) < AMOUNT_EPSILON;
  }
}

// Compiled patterns, so a batch of a hundred transactions compiles each rule's
// regex once. Bounded because the keys are user input.
const patternCache = new Map<string, RegExp | null>();
const PATTERN_CACHE_LIMIT = 200;

// A pattern the user typed is not a pattern that compiles. An invalid one
// makes its rule match nothing — never an exception, which inside the sync
// would count the transaction as a failed row and hold up the Plaid cursor.
export function compilePattern(pattern: string): RegExp | null {
  const cached = patternCache.get(pattern);
  if (cached !== undefined) {
    return cached;
  }
  let compiled: RegExp | null = null;
  if (pattern.length <= MAX_PATTERN_LENGTH) {
    try {
      // Case-insensitive: bank descriptors shout, and nobody writing a rule
      // wants to think about that.
      compiled = new RegExp(pattern, "i");
    } catch {
      compiled = null;
    }
  }
  if (patternCache.size >= PATTERN_CACHE_LIMIT) {
    patternCache.clear();
  }
  patternCache.set(pattern, compiled);
  return compiled;
}

// ---------- Plaid personal finance categories ----------
//
// The taxonomy a category outcome picks from. Plaid's node package types
// `personal_finance_category` as bare strings, and there is no endpoint for
// the list, so this is a transcription of Plaid's published taxonomy
// (plaid.com/documents/pfc-taxonomy-all.csv, PFCv2 — a superset of PFCv1).
// It is used for the Rules page's category picker and, when a rule overrides
// a category, to find the primary group its Notion Categories row needs.
export const PFC_TAXONOMY: Record<string, readonly string[]> = {
  INCOME: [
    "INCOME_CHILD_SUPPORT",
    "INCOME_CONTRACTOR",
    "INCOME_DIVIDENDS",
    "INCOME_GIG_ECONOMY",
    "INCOME_INTEREST_EARNED",
    "INCOME_LONG_TERM_DISABILITY",
    "INCOME_MILITARY",
    "INCOME_RENTAL",
    "INCOME_RETIREMENT_PENSION",
    "INCOME_SALARY",
    "INCOME_TAX_REFUND",
    "INCOME_UNEMPLOYMENT",
    "INCOME_OTHER",
  ],
  LOAN_DISBURSEMENTS: [
    "LOAN_DISBURSEMENTS_AUTO",
    "LOAN_DISBURSEMENTS_CASH_ADVANCES",
    "LOAN_DISBURSEMENTS_EWA",
    "LOAN_DISBURSEMENTS_MORTGAGE",
    "LOAN_DISBURSEMENTS_PERSONAL",
    "LOAN_DISBURSEMENTS_STUDENT",
    "LOAN_DISBURSEMENTS_OTHER_DISBURSEMENT",
  ],
  LOAN_PAYMENTS: [
    "LOAN_PAYMENTS_BNPL",
    "LOAN_PAYMENTS_CAR_PAYMENT",
    "LOAN_PAYMENTS_CASH_ADVANCES",
    "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
    "LOAN_PAYMENTS_EWA",
    "LOAN_PAYMENTS_MORTGAGE_PAYMENT",
    "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT",
    "LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT",
    "LOAN_PAYMENTS_OTHER_PAYMENT",
  ],
  TRANSFER_IN: [
    "TRANSFER_IN_ACCOUNT_TRANSFER",
    "TRANSFER_IN_DEPOSIT",
    "TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS",
    "TRANSFER_IN_SAVINGS",
    "TRANSFER_IN_TRANSFER_IN_FROM_APPS",
    "TRANSFER_IN_WIRE",
    "TRANSFER_IN_OTHER_TRANSFER_IN",
  ],
  TRANSFER_OUT: [
    "TRANSFER_OUT_ACCOUNT_TRANSFER",
    "TRANSFER_OUT_CRYPTO",
    "TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS",
    "TRANSFER_OUT_SAVINGS",
    "TRANSFER_OUT_TRANSFER_OUT_FROM_APPS",
    "TRANSFER_OUT_WIRE",
    "TRANSFER_OUT_WITHDRAWAL",
    "TRANSFER_OUT_OTHER_TRANSFER_OUT",
  ],
  BANK_FEES: [
    "BANK_FEES_ATM_FEES",
    "BANK_FEES_INSUFFICIENT_FUNDS",
    "BANK_FEES_INTEREST_CHARGE",
    "BANK_FEES_FOREIGN_TRANSACTION_FEES",
    "BANK_FEES_OVERDRAFT_FEES",
    "BANK_FEES_LATE_FEES",
    "BANK_FEES_CASH_ADVANCE",
    "BANK_FEES_OTHER_BANK_FEES",
  ],
  ENTERTAINMENT: [
    "ENTERTAINMENT_CASINOS_AND_GAMBLING",
    "ENTERTAINMENT_MUSIC_AND_AUDIO",
    "ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS",
    "ENTERTAINMENT_TV_AND_MOVIES",
    "ENTERTAINMENT_VIDEO_GAMES",
    "ENTERTAINMENT_OTHER_ENTERTAINMENT",
  ],
  FOOD_AND_DRINK: [
    "FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR",
    "FOOD_AND_DRINK_COFFEE",
    "FOOD_AND_DRINK_FAST_FOOD",
    "FOOD_AND_DRINK_GROCERIES",
    "FOOD_AND_DRINK_RESTAURANT",
    "FOOD_AND_DRINK_VENDING_MACHINES",
    "FOOD_AND_DRINK_OTHER_FOOD_AND_DRINK",
  ],
  GENERAL_MERCHANDISE: [
    "GENERAL_MERCHANDISE_BOOKSTORES_AND_NEWSSTANDS",
    "GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES",
    "GENERAL_MERCHANDISE_CONVENIENCE_STORES",
    "GENERAL_MERCHANDISE_DEPARTMENT_STORES",
    "GENERAL_MERCHANDISE_DISCOUNT_STORES",
    "GENERAL_MERCHANDISE_ELECTRONICS",
    "GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES",
    "GENERAL_MERCHANDISE_OFFICE_SUPPLIES",
    "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES",
    "GENERAL_MERCHANDISE_PET_SUPPLIES",
    "GENERAL_MERCHANDISE_SPORTING_GOODS",
    "GENERAL_MERCHANDISE_SUPERSTORES",
    "GENERAL_MERCHANDISE_TOBACCO_AND_VAPE",
    "GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE",
  ],
  HOME_IMPROVEMENT: [
    "HOME_IMPROVEMENT_FURNITURE",
    "HOME_IMPROVEMENT_HARDWARE",
    "HOME_IMPROVEMENT_REPAIR_AND_MAINTENANCE",
    "HOME_IMPROVEMENT_SECURITY",
    "HOME_IMPROVEMENT_OTHER_HOME_IMPROVEMENT",
  ],
  MEDICAL: [
    "MEDICAL_DENTAL_CARE",
    "MEDICAL_EYE_CARE",
    "MEDICAL_NURSING_CARE",
    "MEDICAL_PHARMACIES_AND_SUPPLEMENTS",
    "MEDICAL_PRIMARY_CARE",
    "MEDICAL_VETERINARY_SERVICES",
    "MEDICAL_OTHER_MEDICAL",
  ],
  PERSONAL_CARE: [
    "PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS",
    "PERSONAL_CARE_HAIR_AND_BEAUTY",
    "PERSONAL_CARE_LAUNDRY_AND_DRY_CLEANING",
    "PERSONAL_CARE_OTHER_PERSONAL_CARE",
  ],
  GENERAL_SERVICES: [
    "GENERAL_SERVICES_ACCOUNTING_AND_FINANCIAL_PLANNING",
    "GENERAL_SERVICES_AUTOMOTIVE",
    "GENERAL_SERVICES_CHILDCARE",
    "GENERAL_SERVICES_CONSULTING_AND_LEGAL",
    "GENERAL_SERVICES_EDUCATION",
    "GENERAL_SERVICES_INSURANCE",
    "GENERAL_SERVICES_POSTAGE_AND_SHIPPING",
    "GENERAL_SERVICES_STORAGE",
    "GENERAL_SERVICES_OTHER_GENERAL_SERVICES",
  ],
  GOVERNMENT_AND_NON_PROFIT: [
    "GOVERNMENT_AND_NON_PROFIT_DONATIONS",
    "GOVERNMENT_AND_NON_PROFIT_GOVERNMENT_DEPARTMENTS_AND_AGENCIES",
    "GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT",
    "GOVERNMENT_AND_NON_PROFIT_OTHER_GOVERNMENT_AND_NON_PROFIT",
  ],
  TRANSPORTATION: [
    "TRANSPORTATION_BIKES_AND_SCOOTERS",
    "TRANSPORTATION_GAS",
    "TRANSPORTATION_PARKING",
    "TRANSPORTATION_PUBLIC_TRANSIT",
    "TRANSPORTATION_TAXIS_AND_RIDE_SHARES",
    "TRANSPORTATION_TOLLS",
    "TRANSPORTATION_OTHER_TRANSPORTATION",
  ],
  TRAVEL: [
    "TRAVEL_FLIGHTS",
    "TRAVEL_LODGING",
    "TRAVEL_RENTAL_CARS",
    "TRAVEL_OTHER_TRAVEL",
  ],
  RENT_AND_UTILITIES: [
    "RENT_AND_UTILITIES_GAS_AND_ELECTRICITY",
    "RENT_AND_UTILITIES_INTERNET_AND_CABLE",
    "RENT_AND_UTILITIES_RENT",
    "RENT_AND_UTILITIES_SEWAGE_AND_WASTE_MANAGEMENT",
    "RENT_AND_UTILITIES_TELEPHONE",
    "RENT_AND_UTILITIES_WATER",
    "RENT_AND_UTILITIES_OTHER_UTILITIES",
  ],
  OTHER: ["OTHER_OTHER"],
};

const PFC_PRIMARY_BY_DETAILED = new Map<string, string>(
  Object.entries(PFC_TAXONOMY).flatMap(([primary, detailed]) =>
    detailed.map((id) => [id, primary] as [string, string]),
  ),
);

// The primary group a detailed category belongs to. The Notion Categories row
// needs it for its Category Group column, and a category set by a rule never
// went through Plaid, so it has to be looked up rather than read off the
// transaction.
export function pfcPrimary(detailed: string): string | undefined {
  return PFC_PRIMARY_BY_DETAILED.get(detailed);
}

export function isPfcCategory(detailed: string): boolean {
  return PFC_PRIMARY_BY_DETAILED.has(detailed);
}

// "FOOD_AND_DRINK_COFFEE" -> "Coffee", the same name the Notion Categories
// row gets (see categoryName in notionApi.ts).
export function pfcLabel(detailed: string): string {
  const primary = pfcPrimary(detailed);
  const rest =
    primary && detailed.startsWith(`${primary}_`)
      ? detailed.slice(primary.length + 1)
      : detailed;
  return titleCase(rest);
}

// The category picker's options, grouped the way Notion groups them.
export const PFC_GROUPS: Array<{
  primary: string;
  label: string;
  categories: Array<{ id: string; label: string }>;
}> = Object.entries(PFC_TAXONOMY).map(([primary, detailed]) => ({
  primary,
  label: titleCase(primary),
  categories: detailed.map((id) => ({ id, label: pfcLabel(id) })),
}));

import { describe, expect, test } from "vitest";
import {
  evaluate,
  isPfcCategory,
  pfcLabel,
  pfcPrimary,
  type Rule,
  type RuleConditions,
  type RuleOutcomes,
  type RuleTransaction,
} from "./rulesEngine";

let nextId = 0;

function rule(
  conditions: RuleConditions,
  outcomes: RuleOutcomes = { hide: true },
  overrides: Partial<Rule> = {},
): Rule {
  nextId++;
  return {
    id: `rule_${nextId}`,
    priority: nextId,
    enabled: true,
    conditions,
    outcomes,
    ...overrides,
  };
}

// Plaid's sign: positive is money out of the account.
function txn(overrides: Partial<RuleTransaction> = {}): RuleTransaction {
  return {
    merchant: "Blue Bottle Coffee",
    description: "SQ *BLUE BOTTLE COFFEE 123",
    amount: 6.25,
    accountId: "account_1",
    ...overrides,
  };
}

describe("text conditions", () => {
  test("contains is case-insensitive and matches anywhere", () => {
    expect(
      evaluate([rule({ merchant: { op: "contains", value: "blue bottle" } })], txn()),
    ).toMatchObject({ hide: true });
    expect(
      evaluate([rule({ merchant: { op: "contains", value: "COFFEE" } })], txn()),
    ).not.toBeNull();
    expect(
      evaluate([rule({ merchant: { op: "contains", value: "starbucks" } })], txn()),
    ).toBeNull();
  });

  test("equals compares the whole value, ignoring case and outer spaces", () => {
    expect(
      evaluate(
        [rule({ merchant: { op: "equals", value: "  blue bottle coffee " } })],
        txn(),
      ),
    ).not.toBeNull();
    expect(
      evaluate([rule({ merchant: { op: "equals", value: "Blue Bottle" } })], txn()),
    ).toBeNull();
  });

  test("regex matches case-insensitively", () => {
    expect(
      evaluate([rule({ description: { op: "regex", value: "^SQ \\*" } })], txn()),
    ).not.toBeNull();
    expect(
      evaluate([rule({ description: { op: "regex", value: "^sq \\*blue" } })], txn()),
    ).not.toBeNull();
    expect(
      evaluate([rule({ description: { op: "regex", value: "^AMZN" } })], txn()),
    ).toBeNull();
  });

  test("an invalid regex makes its rule match nothing instead of throwing", () => {
    const broken = rule({ merchant: { op: "regex", value: "coffee(" } });
    const fallback = rule(
      { merchant: { op: "contains", value: "coffee" } },
      { categoryId: "FOOD_AND_DRINK_COFFEE" },
    );
    expect(() => evaluate([broken], txn())).not.toThrow();
    expect(evaluate([broken], txn())).toBeNull();
    // The broken rule is first by priority, but a rule that cannot match
    // cannot win: the next one still gets its turn.
    expect(evaluate([broken, fallback], txn())).toMatchObject({
      categoryId: "FOOD_AND_DRINK_COFFEE",
    });
  });

  test("a missing or empty field does not match", () => {
    const contains = rule({ merchant: { op: "contains", value: "coffee" } });
    expect(evaluate([contains], txn({ merchant: null }))).toBeNull();
    expect(evaluate([contains], txn({ merchant: undefined }))).toBeNull();
    expect(evaluate([contains], txn({ merchant: "   " }))).toBeNull();
  });

  test("an empty pattern does not match everything", () => {
    expect(
      evaluate([rule({ merchant: { op: "contains", value: "  " } })], txn()),
    ).toBeNull();
  });
});

describe("amount conditions", () => {
  test("each comparison uses Plaid's sign, where money out is positive", () => {
    const spent = txn({ amount: 120 });
    const refund = txn({ amount: -40 });
    const check = (
      op: "lt" | "lte" | "gt" | "gte" | "eq",
      value: number,
      transaction = spent,
    ) => evaluate([rule({ amount: { op, value } })], transaction) !== null;

    expect(check("gt", 100)).toBe(true);
    expect(check("gt", 120)).toBe(false);
    expect(check("gte", 120)).toBe(true);
    expect(check("lt", 121)).toBe(true);
    expect(check("lt", 120)).toBe(false);
    expect(check("lte", 120)).toBe(true);
    expect(check("eq", 120)).toBe(true);
    expect(check("eq", 120.001)).toBe(true);
    expect(check("eq", 120.02)).toBe(false);
    // Money in is negative, so "less than zero" is how you catch refunds.
    expect(check("lt", 0, refund)).toBe(true);
    expect(check("gt", 0, refund)).toBe(false);
  });

  test("a non-finite amount matches nothing", () => {
    expect(
      evaluate([rule({ amount: { op: "gt", value: 10 } })], txn({ amount: NaN })),
    ).toBeNull();
    expect(
      evaluate([rule({ amount: { op: "gt", value: NaN } })], txn()),
    ).toBeNull();
  });
});

describe("condition combination", () => {
  test("every condition in a rule has to hold", () => {
    const conditions: RuleConditions = {
      merchant: { op: "contains", value: "coffee" },
      amount: { op: "gt", value: 5 },
      accountId: "account_1",
    };
    expect(evaluate([rule(conditions)], txn())).not.toBeNull();
    expect(evaluate([rule(conditions)], txn({ amount: 3 }))).toBeNull();
    expect(evaluate([rule(conditions)], txn({ accountId: "account_2" }))).toBeNull();
    expect(evaluate([rule(conditions)], txn({ merchant: "Peet's" }))).toBeNull();
  });

  test("an account condition needs the transaction's account", () => {
    const onAccount = rule({ accountId: "account_1" });
    expect(evaluate([onAccount], txn())).not.toBeNull();
    expect(evaluate([onAccount], txn({ accountId: undefined }))).toBeNull();
  });

  test("a rule with no conditions matches nothing", () => {
    // Otherwise a rule saved empty would hide every transaction the user has.
    expect(evaluate([rule({}, { hide: true })], txn())).toBeNull();
  });
});

describe("rule ordering", () => {
  test("the first matching rule wins outright and applies all its outcomes", () => {
    const first = rule(
      { merchant: { op: "contains", value: "coffee" } },
      { categoryId: "FOOD_AND_DRINK_COFFEE", rename: "Coffee" },
      { priority: 1 },
    );
    const second = rule(
      { merchant: { op: "contains", value: "blue bottle" } },
      { categoryId: "FOOD_AND_DRINK_RESTAURANT", hide: true },
      { priority: 2 },
    );

    const match = evaluate([second, first], txn());
    expect(match).toEqual({
      ruleId: first.id,
      categoryId: "FOOD_AND_DRINK_COFFEE",
      rename: "Coffee",
    });
    // No outcome leaks in from the rule below it.
    expect(match?.hide).toBeUndefined();
  });

  test("priority order decides, not the order rules arrive in", () => {
    const low = rule({ merchant: { op: "contains", value: "coffee" } }, { rename: "Low" }, { priority: 10 });
    const high = rule({ merchant: { op: "contains", value: "coffee" } }, { rename: "High" }, { priority: 2 });
    expect(evaluate([low, high], txn())).toMatchObject({ rename: "High" });
  });

  test("disabled rules are skipped", () => {
    const off = rule(
      { merchant: { op: "contains", value: "coffee" } },
      { hide: true },
      { priority: 1, enabled: false },
    );
    const on = rule(
      { merchant: { op: "contains", value: "coffee" } },
      { rename: "Coffee" },
      { priority: 2 },
    );
    expect(evaluate([off], txn())).toBeNull();
    expect(evaluate([off, on], txn())).toMatchObject({ rename: "Coffee" });
  });

  test("no rules at all is not a match", () => {
    expect(evaluate([], txn())).toBeNull();
  });
});

describe("Plaid category taxonomy", () => {
  test("a detailed category maps back to its primary group", () => {
    expect(pfcPrimary("GENERAL_MERCHANDISE_ELECTRONICS")).toBe(
      "GENERAL_MERCHANDISE",
    );
    expect(pfcPrimary("FOOD_AND_DRINK_COFFEE")).toBe("FOOD_AND_DRINK");
    expect(pfcPrimary("NOT_A_CATEGORY")).toBeUndefined();
  });

  test("labels read like the Notion Categories rows", () => {
    expect(pfcLabel("FOOD_AND_DRINK_COFFEE")).toBe("Coffee");
    expect(pfcLabel("FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR")).toBe(
      "Beer Wine and Liquor",
    );
    expect(pfcLabel("INCOME_OTHER")).toBe("Other");
  });

  test("only real categories are accepted", () => {
    expect(isPfcCategory("RENT_AND_UTILITIES_RENT")).toBe(true);
    expect(isPfcCategory("rent_and_utilities_rent")).toBe(false);
    expect(isPfcCategory("")).toBe(false);
  });
});

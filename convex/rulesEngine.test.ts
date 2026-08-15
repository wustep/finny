import { describe, expect, test } from "vitest";
import {
  evaluate,
  isPfcPrimary,
  normalizeActions,
  normalizeConditions,
  isPfcCategory,
  pfcLabel,
  pfcPrimary,
  type Action,
  type Condition,
  type Rule,
  type RuleTransaction,
} from "./rulesEngine";

let nextId = 0;

function rule(
  conditions: Condition[],
  actions: Action[] = [{ kind: "hide" }],
  overrides: Partial<Rule> = {},
): Rule {
  nextId++;
  return {
    id: `rule_${nextId}`,
    priority: nextId,
    enabled: true,
    conditions,
    actions,
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
    category: "FOOD_AND_DRINK_COFFEE",
    pending: false,
    ...overrides,
  };
}

// Shorthands, so the tests below read as what they are testing rather than as
// object literals.
const merchant = (
  op: "contains" | "equals" | "regex",
  ...values: string[]
): Condition => ({ kind: "text", field: "merchant", op, values });

const description = (
  op: "contains" | "equals" | "regex",
  ...values: string[]
): Condition => ({ kind: "text", field: "description", op, values });

const amount = (
  op: "lt" | "lte" | "gt" | "gte" | "eq",
  value: number,
): Condition => ({ kind: "amount", op, value });

describe("text conditions", () => {
  test("contains is case-insensitive and matches anywhere", () => {
    expect(
      evaluate([rule([merchant("contains", "blue bottle")])], txn()),
    ).toMatchObject({ hide: true });
    expect(
      evaluate([rule([merchant("contains", "COFFEE")])], txn()),
    ).not.toBeNull();
    expect(
      evaluate([rule([merchant("contains", "starbucks")])], txn()),
    ).toBeNull();
  });

  test("equals compares the whole value, ignoring case and outer spaces", () => {
    expect(
      evaluate(
        [rule([merchant("equals", "  blue bottle coffee ")])],
        txn(),
      ),
    ).not.toBeNull();
    expect(
      evaluate([rule([merchant("equals", "Blue Bottle")])], txn()),
    ).toBeNull();
  });

  test("regex matches case-insensitively", () => {
    expect(
      evaluate([rule([description("regex", "^SQ \\*")])], txn()),
    ).not.toBeNull();
    expect(
      evaluate([rule([description("regex", "^sq \\*blue")])], txn()),
    ).not.toBeNull();
    expect(
      evaluate([rule([description("regex", "^AMZN")])], txn()),
    ).toBeNull();
  });

  test("an invalid regex makes its rule match nothing instead of throwing", () => {
    const broken = rule([merchant("regex", "coffee(")]);
    const fallback = rule([merchant("contains", "coffee")], [
      { kind: "setCategory", categoryId: "FOOD_AND_DRINK_COFFEE" },
    ]);
    expect(() => evaluate([broken], txn())).not.toThrow();
    expect(evaluate([broken], txn())).toBeNull();
    // The broken rule is first by priority, but a rule that cannot match
    // cannot win: the next one still gets its turn.
    expect(evaluate([broken, fallback], txn())).toMatchObject({
      categoryId: "FOOD_AND_DRINK_COFFEE",
    });
  });

  test("a missing or empty field does not match", () => {
    const contains = rule([merchant("contains", "coffee")]);
    expect(evaluate([contains], txn({ merchant: null }))).toBeNull();
    expect(evaluate([contains], txn({ merchant: undefined }))).toBeNull();
    expect(evaluate([contains], txn({ merchant: "   " }))).toBeNull();
  });

  test("an empty pattern does not match everything", () => {
    expect(
      evaluate([rule([merchant("contains", "  ")])], txn()),
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
    ) => evaluate([rule([amount(op, value)])], transaction) !== null;

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
      evaluate([rule([amount("gt", 10)])], txn({ amount: NaN })),
    ).toBeNull();
    expect(
      evaluate([rule([amount("gt", NaN)])], txn()),
    ).toBeNull();
  });
});

describe("condition combination", () => {
  test("every condition in a rule has to hold", () => {
    const conditions: Condition[] = [
      merchant("contains", "coffee"),
      amount("gt", 5),
      { kind: "account", accountIds: ["account_1"] },
    ];
    expect(evaluate([rule(conditions)], txn())).not.toBeNull();
    expect(evaluate([rule(conditions)], txn({ amount: 3 }))).toBeNull();
    expect(evaluate([rule(conditions)], txn({ accountId: "account_2" }))).toBeNull();
    expect(evaluate([rule(conditions)], txn({ merchant: "Peet's" }))).toBeNull();
  });

  test("an account condition needs the transaction's account", () => {
    const onAccount = rule([{ kind: "account", accountIds: ["account_1"] }]);
    expect(evaluate([onAccount], txn())).not.toBeNull();
    expect(evaluate([onAccount], txn({ accountId: undefined }))).toBeNull();
  });

  test("a rule with no conditions matches nothing", () => {
    // Otherwise a rule saved empty would hide every transaction the user has.
    expect(evaluate([rule([], [{ kind: "hide" }])], txn())).toBeNull();
  });
});

describe("rule ordering", () => {
  test("the first matching rule wins outright and applies all its actions", () => {
    const first = rule(
      [merchant("contains", "coffee")],
      [
        { kind: "setCategory", categoryId: "FOOD_AND_DRINK_COFFEE" },
        { kind: "rename", value: "Coffee" },
      ],
      { priority: 1 },
    );
    const second = rule(
      [merchant("contains", "blue bottle")],
      [
        { kind: "setCategory", categoryId: "FOOD_AND_DRINK_RESTAURANT" },
        { kind: "hide" },
      ],
      { priority: 2 },
    );

    const match = evaluate([second, first], txn());
    expect(match).toEqual({
      ruleId: first.id,
      categoryId: "FOOD_AND_DRINK_COFFEE",
      rename: "Coffee",
      tags: [],
      hide: false,
    });
    // Nothing leaks in from the rule below it.
    expect(match?.hide).toBe(false);
  });

  test("priority order decides, not the order rules arrive in", () => {
    const low = rule([merchant("contains", "coffee")], [{ kind: "rename", value: "Low" }], { priority: 10 });
    const high = rule([merchant("contains", "coffee")], [{ kind: "rename", value: "High" }], { priority: 2 });
    expect(evaluate([low, high], txn())).toMatchObject({ rename: "High" });
  });

  test("disabled rules are skipped", () => {
    const off = rule(
      [merchant("contains", "coffee")],
      [{ kind: "hide" }],
      { priority: 1, enabled: false },
    );
    const on = rule(
      [merchant("contains", "coffee")],
      [{ kind: "rename", value: "Coffee" }],
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

describe("several values in one condition", () => {
  test("any one of them satisfies it", () => {
    const anyOf = rule([merchant("contains", "amzn", "amazon", "whole foods")]);
    expect(evaluate([anyOf], txn({ merchant: "AMZN Mktp US" }))).not.toBeNull();
    expect(evaluate([anyOf], txn({ merchant: "Amazon.com" }))).not.toBeNull();
    expect(evaluate([anyOf], txn({ merchant: "Whole Foods" }))).not.toBeNull();
    expect(evaluate([anyOf], txn({ merchant: "Target" }))).toBeNull();
  });

  test("negation is none of them, not each of them", () => {
    const noneOf: Condition = {
      kind: "text",
      field: "merchant",
      op: "contains",
      values: ["amzn", "amazon"],
      negate: true,
    };
    expect(evaluate([rule([noneOf])], txn({ merchant: "Target" }))).not.toBeNull();
    expect(evaluate([rule([noneOf])], txn({ merchant: "AMZN Mktp" }))).toBeNull();
    expect(evaluate([rule([noneOf])], txn({ merchant: "Amazon.com" }))).toBeNull();
  });

  test("an empty value list matches nothing, negated or not", () => {
    // Writes reject this (convex/rules.ts drops emptied conditions); the
    // engine must not turn it into "matches everything" regardless.
    const empty: Condition = {
      kind: "text",
      field: "merchant",
      op: "contains",
      values: [],
    };
    expect(evaluate([rule([empty])], txn())).toBeNull();
  });
});

describe("a range is two conditions", () => {
  test("both bounds have to hold", () => {
    const between = rule([amount("gte", 10), amount("lte", 50)]);
    expect(evaluate([between], txn({ amount: 25 }))).not.toBeNull();
    expect(evaluate([between], txn({ amount: 10 }))).not.toBeNull();
    expect(evaluate([between], txn({ amount: 50 }))).not.toBeNull();
    expect(evaluate([between], txn({ amount: 9.99 }))).toBeNull();
    expect(evaluate([between], txn({ amount: 50.01 }))).toBeNull();
  });
});

describe("category conditions", () => {
  const inCoffee: Condition = {
    kind: "category",
    categoryIds: ["FOOD_AND_DRINK_COFFEE"],
  };
  const inAnyFood: Condition = {
    kind: "category",
    categoryIds: ["FOOD_AND_DRINK"],
  };

  test("a detailed category matches only itself", () => {
    expect(evaluate([rule([inCoffee])], txn())).not.toBeNull();
    expect(
      evaluate([rule([inCoffee])], txn({ category: "FOOD_AND_DRINK_GROCERIES" })),
    ).toBeNull();
  });

  test("a primary group matches everything under it", () => {
    expect(evaluate([rule([inAnyFood])], txn())).not.toBeNull();
    expect(
      evaluate([rule([inAnyFood])], txn({ category: "FOOD_AND_DRINK_GROCERIES" })),
    ).not.toBeNull();
    expect(
      evaluate([rule([inAnyFood])], txn({ category: "TRAVEL_FLIGHTS" })),
    ).toBeNull();
  });

  test("a transaction Plaid did not categorise matches nothing", () => {
    expect(evaluate([rule([inCoffee])], txn({ category: null }))).toBeNull();
    expect(evaluate([rule([inCoffee])], txn({ category: undefined }))).toBeNull();
    // And negation does not turn "no category" into a match either way round
    // by accident — it simply did not match, so "is not" holds.
    expect(
      evaluate([rule([{ ...inCoffee, negate: true }])], txn({ category: null })),
    ).not.toBeNull();
  });

  test("primary ids are recognisable as groups", () => {
    expect(isPfcPrimary("FOOD_AND_DRINK")).toBe(true);
    expect(isPfcPrimary("FOOD_AND_DRINK_COFFEE")).toBe(false);
    expect(isPfcPrimary("NOT_A_GROUP")).toBe(false);
  });
});

describe("pending conditions", () => {
  test("they compare against the transaction's pending flag", () => {
    const whilePending: Condition = { kind: "pending", value: true };
    const oncePosted: Condition = { kind: "pending", value: false };
    expect(evaluate([rule([whilePending])], txn({ pending: true }))).not.toBeNull();
    expect(evaluate([rule([whilePending])], txn({ pending: false }))).toBeNull();
    expect(evaluate([rule([oncePosted])], txn({ pending: false }))).not.toBeNull();
    // Absent is treated as posted, which is what a transaction with no flag is.
    expect(evaluate([rule([oncePosted])], txn({ pending: undefined }))).not.toBeNull();
  });
});

describe("reading rules stored in the old shape", () => {
  test("every slot becomes one condition", () => {
    expect(
      normalizeConditions({
        merchant: { op: "contains", value: "blue bottle" },
        description: { op: "regex", value: "^SQ" },
        amount: { op: "gt", value: 5 },
        accountId: "account_1",
      }),
    ).toEqual([
      { kind: "text", field: "merchant", op: "contains", values: ["blue bottle"] },
      { kind: "text", field: "description", op: "regex", values: ["^SQ"] },
      { kind: "amount", op: "gt", value: 5 },
      { kind: "account", accountIds: ["account_1"] },
    ]);
  });

  test("a rule already in the new shape is left alone", () => {
    const conditions: Condition[] = [merchant("contains", "coffee")];
    expect(normalizeConditions(conditions)).toBe(conditions);
  });

  test("an old rule keeps matching exactly what it did", () => {
    const legacy = normalizeConditions({
      merchant: { op: "contains", value: "blue bottle" },
      amount: { op: "gt", value: 5 },
    });
    expect(evaluate([rule(legacy)], txn())).not.toBeNull();
    expect(evaluate([rule(legacy)], txn({ amount: 3 }))).toBeNull();
    expect(evaluate([rule(legacy)], txn({ merchant: "Peet's" }))).toBeNull();
  });

  test("an empty old record still matches nothing", () => {
    expect(normalizeConditions({})).toEqual([]);
    expect(evaluate([rule(normalizeConditions({}))], txn())).toBeNull();
  });
});

describe("actions", () => {
  const coffee = txn();

  test("every action of the winning rule applies", () => {
    const match = evaluate(
      [
        rule(
          [merchant("contains", "blue bottle")],
          [
            { kind: "setCategory", categoryId: "FOOD_AND_DRINK_COFFEE" },
            { kind: "rename", value: "Coffee" },
            { kind: "addTags", tags: ["Treat"] },
          ],
        ),
      ],
      coffee,
    );
    expect(match).toMatchObject({
      categoryId: "FOOD_AND_DRINK_COFFEE",
      rename: "Coffee",
      tags: ["Treat"],
      hide: false,
    });
  });

  test("tags accumulate across actions and never repeat", () => {
    const match = evaluate(
      [
        rule(
          [merchant("contains", "blue bottle")],
          [
            { kind: "addTags", tags: ["Treat", "Coffee"] },
            { kind: "addTags", tags: ["Coffee", "Weekly"] },
          ],
        ),
      ],
      coffee,
    );
    expect(match?.tags).toEqual(["Treat", "Coffee", "Weekly"]);
  });

  test("the last of a colliding pair wins, so a rule reads top to bottom", () => {
    const match = evaluate(
      [
        rule(
          [merchant("contains", "blue bottle")],
          [
            { kind: "rename", value: "First" },
            { kind: "rename", value: "Second" },
          ],
        ),
      ],
      coffee,
    );
    expect(match?.rename).toBe("Second");
  });

  test("hide is a latch, wherever it sits in the list", () => {
    const match = evaluate(
      [
        rule(
          [merchant("contains", "blue bottle")],
          [
            { kind: "hide" },
            { kind: "rename", value: "Never seen" },
          ],
        ),
      ],
      coffee,
    );
    expect(match?.hide).toBe(true);
    // Still resolved, because the caller decides what hiding means — the
    // engine's job is to say what the rule asked for.
    expect(match?.rename).toBe("Never seen");
  });

  test("a rule with no actions resolves to doing nothing", () => {
    // Writes refuse this; the engine must not invent an effect for it.
    const match = evaluate([rule([merchant("contains", "blue bottle")], [])], coffee);
    expect(match).toEqual({ ruleId: expect.any(String), tags: [], hide: false });
  });
});

describe("reading rules whose effects predate the action list", () => {
  test("every old field becomes one action, in a fixed order", () => {
    expect(
      normalizeActions({
        categoryId: "FOOD_AND_DRINK_COFFEE",
        rename: "Coffee",
        hide: true,
      }),
    ).toEqual([
      { kind: "setCategory", categoryId: "FOOD_AND_DRINK_COFFEE" },
      { kind: "rename", value: "Coffee" },
      { kind: "hide" },
    ]);
  });

  test("a rule already in the new shape is left alone", () => {
    const actions: Action[] = [{ kind: "hide" }];
    expect(normalizeActions(actions)).toBe(actions);
  });

  test("an absent or empty record is no actions", () => {
    expect(normalizeActions(undefined)).toEqual([]);
    expect(normalizeActions({})).toEqual([]);
    // hide: false is not an action, which is what made the old shape
    // ambiguous in the first place.
    expect(normalizeActions({ hide: false })).toEqual([]);
  });

  test("an old rule still does exactly what it did", () => {
    const legacy = normalizeActions({ categoryId: "FOOD_AND_DRINK_COFFEE" });
    expect(
      evaluate([rule([merchant("contains", "blue bottle")], legacy)], txn()),
    ).toMatchObject({ categoryId: "FOOD_AND_DRINK_COFFEE", hide: false });
  });
});

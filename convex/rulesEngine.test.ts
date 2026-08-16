import { describe, expect, test } from "vitest";
import {
  evaluate,
  isPfcPrimary,
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
  test("a higher rule decides a field, and a lower one cannot take it back", () => {
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
    expect(match).toMatchObject({
      categoryId: "FOOD_AND_DRINK_COFFEE",
      rename: "Coffee",
    });
    // The higher rule decided both, so the lower one changed neither.
    expect(match?.ruleIds[0]).toBe(first.id);
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
            {
              kind: "setProperty",
              property: "Review",
              value: { type: "select", option: "Treat" },
            },
          ],
        ),
      ],
      coffee,
    );
    expect(match).toMatchObject({
      categoryId: "FOOD_AND_DRINK_COFFEE",
      rename: "Coffee",
      properties: { Review: { type: "select", option: "Treat" } },
      hide: false,
    });
  });

  test("multi-select values accumulate across actions and never repeat", () => {
    const match = evaluate(
      [
        rule(
          [merchant("contains", "blue bottle")],
          [
            {
              kind: "setProperty",
              property: "Labels",
              value: { type: "multiSelect", options: ["Treat", "Coffee"] },
            },
            {
              kind: "setProperty",
              property: "Labels",
              value: { type: "multiSelect", options: ["Coffee", "Weekly"] },
            },
          ],
        ),
      ],
      coffee,
    );
    expect(match?.properties.Labels).toEqual({
      type: "multiSelect",
      options: ["Treat", "Coffee", "Weekly"],
    });
  });

  test("every other property shape is last-wins", () => {
    const match = evaluate(
      [
        rule(
          [merchant("contains", "blue bottle")],
          [
            {
              kind: "setProperty",
              property: "Review",
              value: { type: "select", option: "First" },
            },
            {
              kind: "setProperty",
              property: "Review",
              value: { type: "select", option: "Second" },
            },
          ],
        ),
      ],
      coffee,
    );
    expect(match?.properties.Review).toEqual({
      type: "select",
      option: "Second",
    });
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
    expect(match).toMatchObject({ properties: {}, hide: false });
  });
});

describe("layering", () => {
  const coffee = txn();
  const matchesCoffee = [merchant("contains", "blue bottle")];
  const matchesAll = [amount("gt", 0)];

  test("every matching rule contributes what nobody above it set", () => {
    const specific = rule(
      matchesCoffee,
      [{ kind: "setCategory", categoryId: "FOOD_AND_DRINK_COFFEE" }],
      { priority: 1 },
    );
    const general = rule(matchesAll, [{ kind: "rename", value: "Spending" }], {
      priority: 2,
    });

    const match = evaluate([general, specific], coffee);
    expect(match).toMatchObject({
      categoryId: "FOOD_AND_DRINK_COFFEE",
      rename: "Spending",
    });
    expect(match?.ruleIds).toEqual([specific.id, general.id]);
  });

  test("the higher rule wins a field both set", () => {
    const high = rule(matchesCoffee, [{ kind: "rename", value: "Coffee" }], {
      priority: 1,
    });
    const low = rule(matchesAll, [{ kind: "rename", value: "Spending" }], {
      priority: 2,
    });
    expect(evaluate([low, high], coffee)?.rename).toBe("Coffee");
  });

  test("multi-select values add up across rules, in priority order", () => {
    // The point of layering: a label is not a claim about anyone else's
    // labels, so there is nothing for a higher rule to have decided.
    const high = rule(
      matchesCoffee,
      [
        {
          kind: "setProperty",
          property: "Labels",
          value: { type: "multiSelect", options: ["Treat"] },
        },
      ],
      { priority: 1 },
    );
    const low = rule(
      matchesAll,
      [
        {
          kind: "setProperty",
          property: "Labels",
          value: { type: "multiSelect", options: ["Treat", "Spending"] },
        },
      ],
      { priority: 2 },
    );

    expect(evaluate([low, high], coffee)?.properties.Labels).toEqual({
      type: "multiSelect",
      options: ["Treat", "Spending"],
    });
  });

  test("a single-value property is not added to, it is decided", () => {
    const high = rule(
      matchesCoffee,
      [
        {
          kind: "setProperty",
          property: "Review",
          value: { type: "select", option: "Done" },
        },
      ],
      { priority: 1 },
    );
    const low = rule(
      matchesAll,
      [
        {
          kind: "setProperty",
          property: "Review",
          value: { type: "select", option: "Todo" },
        },
      ],
      { priority: 2 },
    );
    expect(evaluate([low, high], coffee)?.properties.Review).toEqual({
      type: "select",
      option: "Done",
    });
  });

  test("hide is a latch, whichever rule asks for it", () => {
    const renamer = rule(matchesCoffee, [{ kind: "rename", value: "Coffee" }], {
      priority: 1,
    });
    const hider = rule(matchesAll, [{ kind: "hide" }], { priority: 2 });

    // A rule below cannot be overruled by one above, because there is no
    // action that says "keep it".
    expect(evaluate([renamer, hider], coffee)?.hide).toBe(true);
    expect(evaluate([hider, renamer], coffee)?.hide).toBe(true);
  });

  test("a rule that does not match contributes nothing", () => {
    const other = rule([merchant("contains", "amazon")], [
      { kind: "rename", value: "Amazon" },
    ]);
    const mine = rule(matchesCoffee, [{ kind: "rename", value: "Coffee" }]);
    expect(evaluate([other, mine], coffee)?.rename).toBe("Coffee");
  });

  test("a disabled rule contributes nothing either", () => {
    const off = rule(matchesAll, [{ kind: "rename", value: "Spending" }], {
      priority: 1,
      enabled: false,
    });
    const on = rule(matchesCoffee, [{ kind: "setCategory", categoryId: "FOOD_AND_DRINK_COFFEE" }], {
      priority: 2,
    });
    const match = evaluate([off, on], coffee);
    expect(match?.rename).toBeUndefined();
    expect(match?.ruleIds).toEqual([on.id]);
  });
});

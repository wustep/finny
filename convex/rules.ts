// Transaction rules: the config behind the Rules page.
//
// The matching itself lives in rulesEngine.ts (pure, unit tested) and runs
// inside the sync pass-through in sync.ts. This module only stores rules,
// keeps their priorities in order, and refuses ones that cannot mean anything.

import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import {
  MAX_PATTERN_LENGTH,
  compilePattern,
  isPfcCategory,
  type Rule,
} from "./rulesEngine";
import { ruleConditionsValidator, ruleOutcomesValidator } from "./schema";

// The engine's condition/outcome types keep ids as plain strings so it stays
// independent of the data model; stored rules use the real `Id<"accounts">`.
type StoredConditions = Doc<"rules">["conditions"];
type StoredOutcomes = Doc<"rules">["outcomes"];

// Every enabled rule is loaded once per batch of transactions and evaluated
// against each of them, so the set has to stay small enough to read in one
// query and cheap enough to run a hundred times over.
const MAX_RULES = 100;

const MAX_NAME_LENGTH = 100;
const MAX_VALUE_LENGTH = 200;

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return [];
    }
    const rules = await ctx.db
      .query("rules")
      .withIndex("by_user_priority", (q) => q.eq("userId", userId))
      .take(MAX_RULES);
    return rules.map(toClientRule);
  },
});

// The rules a sync applies, in the order it applies them. Read once per batch
// of transactions — never per transaction.
export const listEnabledInternal = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args): Promise<Rule[]> => {
    const rules = await ctx.db
      .query("rules")
      .withIndex("by_user_priority", (q) => q.eq("userId", args.userId))
      .take(MAX_RULES);
    return rules
      .filter((rule) => rule.enabled)
      .map((rule) => ({
        id: rule._id,
        priority: rule.priority,
        enabled: rule.enabled,
        conditions: rule.conditions,
        outcomes: rule.outcomes,
      }));
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    conditions: ruleConditionsValidator,
    outcomes: ruleOutcomesValidator,
  },
  handler: async (ctx, args): Promise<Id<"rules">> => {
    const userId = await requireUser(ctx);
    const { name, conditions, outcomes } = await validateRule(ctx, userId, args);

    const rules = await ctx.db
      .query("rules")
      .withIndex("by_user_priority", (q) => q.eq("userId", userId))
      .take(MAX_RULES);
    if (rules.length >= MAX_RULES) {
      throw new Error(
        `A rule set is limited to ${MAX_RULES} rules; delete one first.`,
      );
    }
    // Last in line: a new rule never quietly outranks the ones already there.
    const priority = rules.reduce(
      (highest, rule) => Math.max(highest, rule.priority),
      0,
    );

    return await ctx.db.insert("rules", {
      userId,
      name,
      priority: priority + 1,
      enabled: true,
      conditions,
      outcomes,
    });
  },
});

export const update = mutation({
  args: {
    ruleId: v.id("rules"),
    name: v.optional(v.string()),
    enabled: v.optional(v.boolean()),
    conditions: v.optional(ruleConditionsValidator),
    outcomes: v.optional(ruleOutcomesValidator),
  },
  handler: async (ctx, args) => {
    const { userId, rule } = await requireRule(ctx, args.ruleId);
    // Conditions and outcomes are replaced wholesale, not merged: a patch
    // could not express "drop the amount condition".
    const validated = await validateRule(ctx, userId, {
      name: args.name ?? rule.name,
      conditions: args.conditions ?? rule.conditions,
      outcomes: args.outcomes ?? rule.outcomes,
    });
    await ctx.db.patch(rule._id, {
      name: validated.name,
      conditions: validated.conditions,
      outcomes: validated.outcomes,
      enabled: args.enabled ?? rule.enabled,
    });
  },
});

export const remove = mutation({
  args: { ruleId: v.id("rules") },
  handler: async (ctx, args) => {
    const { rule } = await requireRule(ctx, args.ruleId);
    // Priorities are left with a gap. Order is all they mean, and closing the
    // gap would rewrite every row below for nothing.
    await ctx.db.delete(rule._id);
  },
});

// Move a rule one place up or down the priority order by swapping with its
// neighbour, which is the only reordering the UI offers and the only one that
// cannot renumber a rule the user was not looking at.
export const move = mutation({
  args: {
    ruleId: v.id("rules"),
    direction: v.union(v.literal("up"), v.literal("down")),
  },
  handler: async (ctx, args) => {
    const { userId, rule } = await requireRule(ctx, args.ruleId);
    const rules = await ctx.db
      .query("rules")
      .withIndex("by_user_priority", (q) => q.eq("userId", userId))
      .take(MAX_RULES);
    const index = rules.findIndex((row) => row._id === rule._id);
    const neighbour = rules[index + (args.direction === "up" ? -1 : 1)];
    if (!neighbour) {
      // Already at the end it was asked to move towards.
      return;
    }
    await ctx.db.patch(rule._id, { priority: neighbour.priority });
    await ctx.db.patch(neighbour._id, { priority: rule.priority });
  },
});

// ---------- helpers ----------

function toClientRule(rule: Doc<"rules">) {
  return {
    id: rule._id,
    name: rule.name,
    priority: rule.priority,
    enabled: rule.enabled,
    conditions: rule.conditions,
    outcomes: rule.outcomes,
  };
}

async function requireUser(ctx: MutationCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new Error("Not signed in");
  }
  return userId;
}

async function requireRule(
  ctx: MutationCtx,
  ruleId: Id<"rules">,
): Promise<{ userId: Id<"users">; rule: Doc<"rules"> }> {
  const userId = await requireUser(ctx);
  const rule = await ctx.db.get(ruleId);
  // Same wording whether it is missing or someone else's: a rule id is not
  // something another user should be able to probe for.
  if (!rule || rule.userId !== userId) {
    throw new Error("Rule not found");
  }
  return { userId, rule };
}

// Reject a rule that cannot do what it says before it reaches the sync, where
// the only symptom would be transactions quietly not matching it.
async function validateRule(
  ctx: MutationCtx,
  userId: Id<"users">,
  input: {
    name: string;
    conditions: StoredConditions;
    outcomes: StoredOutcomes;
  },
): Promise<{
  name: string;
  conditions: StoredConditions;
  outcomes: StoredOutcomes;
}> {
  const name = input.name.trim().slice(0, MAX_NAME_LENGTH);
  if (!name) {
    throw new Error("Give the rule a name");
  }

  const conditions: StoredConditions = {};
  const merchant = textCondition(input.conditions.merchant);
  if (merchant) {
    conditions.merchant = merchant;
  }
  const description = textCondition(input.conditions.description);
  if (description) {
    conditions.description = description;
  }
  if (input.conditions.amount) {
    if (!Number.isFinite(input.conditions.amount.value)) {
      throw new Error("The amount to compare against has to be a number");
    }
    conditions.amount = input.conditions.amount;
  }
  if (input.conditions.accountId) {
    const account = await ctx.db.get(input.conditions.accountId);
    if (!account || account.userId !== userId) {
      throw new Error("Account not found");
    }
    conditions.accountId = account._id;
  }
  if (Object.keys(conditions).length === 0) {
    // A rule with nothing to match on would apply to every transaction.
    throw new Error("A rule needs at least one condition");
  }

  const outcomes: StoredOutcomes = {};
  if (input.outcomes.categoryId) {
    if (!isPfcCategory(input.outcomes.categoryId)) {
      throw new Error(`Unknown category ${input.outcomes.categoryId}`);
    }
    outcomes.categoryId = input.outcomes.categoryId;
  }
  const rename = input.outcomes.rename?.trim().slice(0, MAX_VALUE_LENGTH);
  if (rename) {
    outcomes.rename = rename;
  }
  if (input.outcomes.hide) {
    outcomes.hide = true;
  }
  if (Object.keys(outcomes).length === 0) {
    throw new Error("A rule needs at least one outcome");
  }

  return { name, conditions, outcomes };
}

function textCondition(
  condition: { op: "contains" | "equals" | "regex"; value: string } | undefined,
) {
  if (!condition) {
    return undefined;
  }
  const value = condition.value.trim();
  if (!value) {
    // An empty value is how the UI says "no condition here".
    return undefined;
  }
  if (value.length > MAX_VALUE_LENGTH) {
    throw new Error(
      `Keep the text to match under ${MAX_VALUE_LENGTH} characters`,
    );
  }
  if (condition.op === "regex" && !compilePattern(value)) {
    // The engine treats an uncompilable pattern as never matching, which as a
    // saved rule is indistinguishable from a rule that is simply wrong.
    throw new Error(
      value.length > MAX_PATTERN_LENGTH
        ? "That regular expression is too long"
        : "That is not a valid regular expression",
    );
  }
  return { op: condition.op, value };
}

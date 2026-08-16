// Transaction rules: the config behind the Rules page.
//
// The matching itself lives in rulesEngine.ts (pure, unit tested) and runs
// inside the sync pass-through in sync.ts. This module only stores rules,
// keeps their priorities in order, and refuses ones that cannot mean anything.

import { getAuthUserId } from "@convex-dev/auth/server";
import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
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
  isPfcPrimary,
  type Action,
  type Condition,
  type Rule,
} from "./rulesEngine";
import { ruleActionValidator, ruleConditionValidator } from "./schema";

// The engine's condition types keep ids as plain strings so it stays
// independent of the data model; stored rules use the real `Id<"accounts">`.
type StoredCondition = Infer<typeof ruleConditionValidator>;
type StoredAction = Infer<typeof ruleActionValidator>;

// The engine keeps account ids as plain strings, on purpose — it is pure and
// knows nothing about the data model. The table stores branded ids, and every
// account id that reaches here has been through ctx.db.get, so it is one.
// One named cast at that seam beats one at every write.
function asStored(conditions: Condition[]): StoredCondition[] {
  return conditions as StoredCondition[];
}

// Same seam for the other list: the engine's Action has no Convex types in it.
function asStoredActions(actions: Action[]): StoredAction[] {
  return actions as StoredAction[];
}

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
        actions: rule.actions,
      }));
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    conditions: v.array(ruleConditionValidator),
    actions: v.array(ruleActionValidator),
  },
  handler: async (ctx, args): Promise<Id<"rules">> => {
    const userId = await requireUser(ctx);
    const { name, conditions, actions } = await validateRule(ctx, userId, args);

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

    await refreshUserColumns(ctx, userId, actions);
    return await ctx.db.insert("rules", {
      userId,
      name,
      priority: priority + 1,
      enabled: true,
      conditions: asStored(conditions),
      actions: asStoredActions(actions),
    });
  },
});

export const update = mutation({
  args: {
    ruleId: v.id("rules"),
    name: v.optional(v.string()),
    enabled: v.optional(v.boolean()),
    conditions: v.optional(v.array(ruleConditionValidator)),
    actions: v.optional(v.array(ruleActionValidator)),
  },
  handler: async (ctx, args) => {
    const { userId, rule } = await requireRule(ctx, args.ruleId);
    // Conditions and outcomes are replaced wholesale, not merged: a patch
    // could not express "drop the amount condition".
    const validated = await validateRule(ctx, userId, {
      name: args.name ?? rule.name,
      conditions: args.conditions ?? rule.conditions,
      actions: args.actions ?? rule.actions,
    });
    await refreshUserColumns(ctx, userId, validated.actions);
    await ctx.db.patch(rule._id, {
      name: validated.name,
      conditions: asStored(validated.conditions),
      actions: asStoredActions(validated.actions),
      enabled: args.enabled ?? rule.enabled,
    });
  },
});

// Re-run the rules over everything already in Notion.
//
// There is nothing stored to re-run them against — that is the whole premise —
// so this does the only thing that can work: rewinds the Plaid cursors and
// replays the history through the sync, where the rules live. The page map
// makes the replay update rows in place rather than duplicating them, which is
// the same machinery the destination page's re-backfill uses.
//
// Slow, and honestly slow: a couple of years of transactions against Notion's
// three writes a second is hours. The dialog says so.
export const applyToHistory = mutation({
  args: {},
  handler: async (ctx): Promise<{ connections: number }> => {
    const userId = await requireUser(ctx);
    const user = await ctx.db.get(userId);
    if (user?.accessGrantedAt === undefined) {
      throw new Error("Access password required");
    }
    const connectionIds = await ctx.runMutation(
      internal.syncData.clearCursors,
      { userId },
    );
    let delay = 0;
    for (const connectionId of connectionIds) {
      await ctx.scheduler.runAfter(delay, internal.sync.runForConnection, {
        connectionId,
        trigger: "manual",
      });
      delay += 10 * 1000;
    }
    return { connections: connectionIds.length };
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

// Rules leave this module in one shape whatever they are on disk, so neither
// the UI nor the engine has to know the old one existed.
function toClientRule(rule: Doc<"rules">) {
  return {
    id: rule._id,
    name: rule.name,
    priority: rule.priority,
    enabled: rule.enabled,
    conditions: rule.conditions,
    actions: rule.actions,
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

// Conditions one rule may carry. Enough for anything anyone writes by hand,
// low enough that evaluating every rule against every transaction of a batch
// stays trivial.
const MAX_CONDITIONS = 10;

// Values one text or category condition may OR together.
const MAX_CONDITION_VALUES = 20;

// Actions one rule may carry, and tags one addTags action may add. Both are
// generous for anything written by hand and small enough that a rule stays
// something a person can read.
const MAX_ACTIONS = 10;
const MAX_TAGS = 20;

// Reject a rule that cannot do what it says before it reaches the sync, where
// the only symptom would be transactions quietly not matching it.
async function validateRule(
  ctx: MutationCtx,
  userId: Id<"users">,
  input: {
    name: string;
    conditions: Condition[];
    actions: Action[];
  },
): Promise<{
  name: string;
  conditions: Condition[];
  actions: Action[];
}> {
  const name = input.name.trim().slice(0, MAX_NAME_LENGTH);
  if (!name) {
    throw new Error("Give the rule a name");
  }
  if (input.conditions.length > MAX_CONDITIONS) {
    throw new Error(`A rule is limited to ${MAX_CONDITIONS} conditions`);
  }
  if (input.actions.length > MAX_ACTIONS) {
    throw new Error(`A rule is limited to ${MAX_ACTIONS} actions`);
  }

  const conditions: Condition[] = [];
  for (const condition of input.conditions) {
    const checked = await validateCondition(ctx, userId, condition);
    // An emptied-out condition is how the UI says "I removed this one".
    if (checked) {
      conditions.push(checked);
    }
  }
  if (conditions.length === 0) {
    // A rule with nothing to match on would apply to every transaction.
    throw new Error("A rule needs at least one condition");
  }

  // The user's own columns on the Transactions database, which are the only
  // properties a rule may write. Read once: a rule is capped at ten actions
  // and this is one query for all of them.
  const notion = await ctx.db
    .query("notionConnections")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  const manual = notion?.manualProperties?.transactions ?? [];

  const actions: Action[] = [];
  for (const action of input.actions) {
    const checked = validateAction(action, manual);
    if (checked) {
      actions.push(checked);
    }
  }
  if (actions.length === 0) {
    throw new Error("A rule needs at least one thing to do");
  }

  return { name, conditions, actions };
}

// Notion's name for each value shape a rule can write, so a property that has
// since been retyped is caught here rather than 400-ing every row.
const PROPERTY_TYPE_FOR: Record<string, string> = {
  select: "select",
  status: "status",
  multiSelect: "multi_select",
  checkbox: "checkbox",
};

function validateAction(
  action: Action,
  manual: Array<{ name: string; type: string; options?: string[] }>,
): Action | null {
  switch (action.kind) {
    case "setCategory":
      if (!isPfcCategory(action.categoryId)) {
        // A group is a fine thing to match on and a meaningless thing to set:
        // a Notion row lands in one category, not in a group of them.
        throw new Error(`Unknown category ${action.categoryId}`);
      }
      return action;
    case "rename": {
      const value = action.value.trim().slice(0, MAX_VALUE_LENGTH);
      return value ? { kind: "rename", value } : null;
    }
    case "setProperty": {
      const property = manual.find((entry) => entry.name === action.property);
      if (!property) {
        throw new Error(
          `Your Transactions database has no "${action.property}" column`,
        );
      }
      const wanted = PROPERTY_TYPE_FOR[action.value.type];
      if (property.type !== wanted) {
        // The column was retyped in Notion after the rule was written.
        throw new Error(
          `"${action.property}" is a ${property.type} now, not a ${wanted}`,
        );
      }
      // An option the property does not define would either be refused by
      // Notion or quietly added to their database. Neither is what someone
      // meant by picking from a list.
      const allowed = new Set(property.options ?? []);
      const check = (option: string) => {
        if (!allowed.has(option)) {
          throw new Error(`"${action.property}" has no option "${option}"`);
        }
      };
      if (action.value.type === "select" || action.value.type === "status") {
        if (!action.value.option) {
          return null;
        }
        check(action.value.option);
        return action;
      }
      if (action.value.type === "multiSelect") {
        const options = [
          ...new Set(action.value.options.slice(0, MAX_TAGS).filter(Boolean)),
        ];
        for (const option of options) {
          check(option);
        }
        return options.length
          ? { ...action, value: { type: "multiSelect", options } }
          : null;
      }
      return action;
    }
    case "hide":
      return action;
  }
}

async function validateCondition(
  ctx: MutationCtx,
  userId: Id<"users">,
  condition: Condition,
): Promise<Condition | null> {
  switch (condition.kind) {
    case "text": {
      const values = textValues(condition.op, condition.values);
      return values.length === 0
        ? null
        : { ...condition, values: values.slice(0, MAX_CONDITION_VALUES) };
    }
    case "amount":
      if (!Number.isFinite(condition.value)) {
        throw new Error("The amount to compare against has to be a number");
      }
      return condition;
    case "account": {
      const accountIds: Id<"accounts">[] = [];
      for (const accountId of condition.accountIds.slice(
        0,
        MAX_CONDITION_VALUES,
      )) {
        // A plain string off the wire until this lookup says otherwise — the
        // get is what makes it an id, and an account of this user's.
        const account = await ctx.db.get(accountId as Id<"accounts">);
        if (!account || account.userId !== userId) {
          throw new Error("Account not found");
        }
        accountIds.push(account._id);
      }
      return accountIds.length === 0 ? null : { ...condition, accountIds };
    }
    case "category": {
      const categoryIds = condition.categoryIds
        .slice(0, MAX_CONDITION_VALUES)
        .filter((id) => id !== "");
      for (const categoryId of categoryIds) {
        // Either a whole primary group or one detailed category; both are
        // things the engine knows how to match.
        if (!isPfcCategory(categoryId) && !isPfcPrimary(categoryId)) {
          throw new Error(`Unknown category ${categoryId}`);
        }
      }
      return categoryIds.length === 0 ? null : { ...condition, categoryIds };
    }
    case "pending":
      return condition;
  }
}

// The values of one text condition, cleaned. An empty list is how the UI says
// the condition was removed.
function textValues(op: "contains" | "equals" | "regex", values: string[]) {
  const cleaned: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value) {
      continue;
    }
    if (value.length > MAX_VALUE_LENGTH) {
      throw new Error(
        `Keep the text to match under ${MAX_VALUE_LENGTH} characters`,
      );
    }
    if (op === "regex" && !compilePattern(value)) {
      // The engine treats an uncompilable pattern as never matching, which as
      // a saved rule is indistinguishable from a rule that is simply wrong.
      throw new Error(
        value.length > MAX_PATTERN_LENGTH
          ? "That regular expression is too long"
          : `"${value}" is not a valid regular expression`,
      );
    }
    if (!cleaned.includes(value)) {
      cleaned.push(value);
    }
  }
  return cleaned;
}

// A rule that writes one of the user's own columns is a good moment to re-read
// which columns those are: they may have added one in Notion a minute ago, and
// this list is what the next save is validated against.
async function refreshUserColumns(
  ctx: MutationCtx,
  userId: Id<"users">,
  actions: Action[],
): Promise<void> {
  if (!actions.some((action) => action.kind === "setProperty")) {
    return;
  }
  await ctx.scheduler.runAfter(0, internal.notion.refreshManualProperties, {
    userId,
    keys: ["transactions"],
  });
}

// Writing one Plaid transaction to Notion, rules and all.
//
// The pending -> posted rekey, the claim-then-create rule and the user's
// rules have one implementation between them here, shared by the
// transactions/sync stream and the per-account catch-up. Lifted out of
// sync.ts so that file reads as the chain of stages; exports no Convex
// functions, so no api path moves (see syncPages.ts).

import type { Transaction } from "plaid";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { P, archivePage, categoryName, externalIcon, titleCase, updatePage } from "./notionApi";
import {
  evaluate,
  pfcDetailedCategories,
  pfcIconUrl,
  pfcPrimary,
  type Rule,
} from "./rulesEngine";
import { claimAndCreatePage } from "./syncPages";
import { ruleTransaction, transactionIcon, transactionProperties } from "./syncMappers";

// What one transaction did to Notion. "hidden" is a rule keeping a row out
// and is deliberately not counted in a run's stats: nothing was written.
export type TransactionResult = "added" | "modified" | "removed" | "hidden";

// Create or update the Notion row for one Plaid transaction and keep the
// caller's providerId -> page map in step. Shared by the transactions/sync
// stream and the per-account catch-up so the pending -> posted rule, the
// claim-then-create rule, and the user's rules have one implementation
// between them.
//
// Callers decide whether a create is allowed: pass a txn with no mapping
// only when it should be created.
export async function upsertTransaction(
  ctx: ActionCtx,
  input: {
    userId: Id<"users">;
    token: string;
    databaseId: string;
    txn: Transaction;
    accountPage: string;
    // The Convex accounts row this transaction belongs to, which is what a
    // rule's account condition is written against.
    accountRowId?: string;
    // Loaded once per batch, never per transaction.
    rules: Rule[];
    // The destination's title templates, and the names a template may refer
    // to that only the caller knows — the account's Notion title, and the
    // category the row ends up in.
    titleFormats?: Record<string, string>;
    accountName?: string;
    // Resolves (and creates on first sight) the category page, taking a rule's
    // category override into account. Called after the rules run, so a hidden
    // transaction never creates a category row for a category it never gets.
    ensureCategory: (
      txn: Transaction,
      categoryOverride?: string,
    ) => Promise<string | null>;
    txnPages: Record<string, string>;
  },
): Promise<TransactionResult> {
  const { txn, txnPages } = input;

  const decision = evaluate(
    input.rules,
    ruleTransaction(txn, input.accountRowId),
  );
  if (decision?.hide) {
    return await hideTransaction(ctx, {
      userId: input.userId,
      token: input.token,
      txn,
      txnPages,
    });
  }

  const properties = transactionProperties(
    txn,
    input.accountPage,
    await input.ensureCategory(txn, decision?.categoryId),
    decision?.rename,
    decision?.properties,
    input.titleFormats,
    {
      account: input.accountName,
      // The category the row actually ends up in, which is the rule's when it
      // set one — not the one Plaid picked and the rule overrode.
      category: categoryLabel(decision?.categoryId, txn),
    },
  );
  // Merchant logos ride along in the request we are already making, so
  // keeping them current costs no extra calls.
  const icon = transactionIcon(txn);

  const existing = txnPages[txn.transaction_id];
  if (existing) {
    await updatePage(input.token, existing, properties, icon);
    return "modified";
  }

  const pendingPage = txn.pending_transaction_id
    ? txnPages[txn.pending_transaction_id]
    : undefined;
  if (pendingPage) {
    // Pending -> posted: update the page made for the pending transaction
    // and re-key its mapping to the posted id.
    await updatePage(input.token, pendingPage, properties, icon);
    await ctx.runMutation(internal.syncData.rekeyMapEntry, {
      userId: input.userId,
      kind: "transaction",
      fromProviderId: txn.pending_transaction_id!,
      toProviderId: txn.transaction_id,
    });
    txnPages[txn.transaction_id] = pendingPage;
    delete txnPages[txn.pending_transaction_id!];
    return "modified";
  }

  const claimed = await claimAndCreatePage(ctx, {
    userId: input.userId,
    kind: "transaction",
    providerId: txn.transaction_id,
    token: input.token,
    databaseId: input.databaseId,
    properties,
    accountId: txn.account_id,
    icon,
  });
  if (!claimed) {
    throw new Error(
      `another sync holds the transaction claim for ${txn.transaction_id}`,
    );
  }
  if (!claimed.created) {
    // Adopted a page a previous attempt left behind; make sure it carries
    // this transaction's values.
    await updatePage(input.token, claimed.pageId, properties, icon);
  }
  txnPages[txn.transaction_id] = claimed.pageId;
  return "added";
}

// What a {category} token in a transaction's title renders as.
function categoryLabel(
  override: string | undefined,
  txn: Transaction,
): string | undefined {
  const detailed = override ?? txn.personal_finance_category?.detailed;
  if (!detailed) {
    return undefined;
  }
  const primary = override
    ? (pfcPrimary(override) ?? override)
    : (txn.personal_finance_category?.primary ?? detailed);
  return categoryName(detailed, primary);
}

// A rule says this transaction does not belong in Notion.
//
// Usually there is nothing to do — the row was never created. But a rule can
// be written after the transaction already synced, or start applying when a
// pending row posts and its amount changes, so a page that exists has to be
// archived and its mapping dropped. Without dropping it, the next sync event
// for the transaction would update a page the user asked to be gone.
//
// Throwing here is the caller's signal that this row failed, which leaves the
// Plaid cursor where it is so the archive is retried — the same treatment any
// other failed Notion write gets.
async function hideTransaction(
  ctx: ActionCtx,
  input: {
    userId: Id<"users">;
    token: string;
    txn: Transaction;
    txnPages: Record<string, string>;
  },
): Promise<TransactionResult> {
  const { txn, txnPages } = input;
  const pendingId = txn.pending_transaction_id ?? undefined;
  const mappedId = txnPages[txn.transaction_id]
    ? txn.transaction_id
    : pendingId && txnPages[pendingId]
      ? pendingId
      : undefined;
  if (!mappedId) {
    return "hidden";
  }
  await archivePage(input.token, txnPages[mappedId]);
  await ctx.runMutation(internal.syncData.deleteMapEntries, {
    userId: input.userId,
    kind: "transaction",
    providerIds: [mappedId],
  });
  delete txnPages[mappedId];
  // A Notion row went away, which is what "removed" counts.
  return "removed";
}

// Resolve a transaction's category page, creating it the first time it is
// seen. The cache is the caller's, so one pass never asks twice.
//
// `categoryOverride` is a rule's category outcome: a Plaid category enum that
// this transaction never came with, so its primary group has to be looked up
// rather than read off the transaction.
export function categoryResolver(
  ctx: ActionCtx,
  input: {
    userId: Id<"users">;
    token: string;
    databaseId: string | undefined;
    cache: Record<string, string>;
  },
): (txn: Transaction, categoryOverride?: string) => Promise<string | null> {
  return async (txn, categoryOverride) => {
    const pfc = txn.personal_finance_category;
    const detailed = categoryOverride ?? pfc?.detailed;
    const databaseId = input.databaseId;
    if (!detailed || !databaseId) {
      return null;
    }
    if (input.cache[detailed]) {
      return input.cache[detailed];
    }
    const pageId = await ensureCategoryPage(ctx, {
      userId: input.userId,
      token: input.token,
      databaseId,
      detailed,
      // An override that is not in the taxonomy can only be a rule written
      // against a category Plaid has since renamed; group it under itself
      // rather than dropping the outcome the user asked for.
      primary: categoryOverride
        ? (pfcPrimary(categoryOverride) ?? categoryOverride)
        : (pfc?.primary ?? detailed),
      // Plaid's icon belongs to the category it chose. A rule moving the
      // transaction somewhere else says nothing about that category's icon,
      // so the row is created without one.
      iconUrl: categoryOverride
        ? undefined
        : (txn.personal_finance_category_icon_url ?? undefined),
    });
    if (pageId) {
      input.cache[detailed] = pageId;
    }
    return pageId;
  };
}

// Create every PFC category row up front, so the Categories database is the
// taxonomy rather than a log of what has been spent so far. Recurring streams
// and rules that point at a category nobody has transacted in yet then have
// something to relate to. Later syncs see the map full and do nothing.
export async function seedCategories(
  ctx: ActionCtx,
  input: {
    userId: Id<"users">;
    token: string;
    databaseId: string;
  },
): Promise<number> {
  const existing = await ctx.runQuery(internal.syncData.getAllMapEntries, {
    userId: input.userId,
    kind: "category",
  });
  let created = 0;
  for (const { detailed, primary } of pfcDetailedCategories()) {
    if (existing[detailed]) {
      continue;
    }
    const pageId = await ensureCategoryPage(ctx, {
      userId: input.userId,
      token: input.token,
      databaseId: input.databaseId,
      detailed,
      primary,
      iconUrl: pfcIconUrl(primary),
    });
    if (pageId) {
      existing[detailed] = pageId;
      created++;
    }
  }
  if (created > 0) {
    console.log(`seeded ${created} category page(s)`);
  }
  return created;
}

// Categories belong to the user, not to one connection, so two connections
// syncing at once can reach the same one.
export async function ensureCategoryPage(
  ctx: ActionCtx,
  input: {
    userId: Id<"users">;
    token: string;
    databaseId: string;
    detailed: string;
    primary: string;
    // Plaid's icon for the category. Keyed on the primary category, so every
    // detailed category under one primary shares an icon.
    iconUrl?: string;
  },
): Promise<string | null> {
  const claimed = await claimAndCreatePage(ctx, {
    userId: input.userId,
    kind: "category",
    providerId: input.detailed,
    token: input.token,
    databaseId: input.databaseId,
    properties: {
      Name: P.title(categoryName(input.detailed, input.primary)),
      ID: P.text(input.detailed),
      "Category Group": P.select(titleCase(input.primary)),
    },
    icon: input.iconUrl ? externalIcon(input.iconUrl) : undefined,
    // The map and Notion drift apart whenever category pages are restored
    // from trash or a past duplicate left a row nothing points at, and there
    // are only ever a hundred or so of them.
    alwaysAdopt: true,
  });
  // No page means someone else is mid-create. Leave the transaction
  // uncategorised; the next sync picks it up.
  return claimed?.pageId ?? null;
}

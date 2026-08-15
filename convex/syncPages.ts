// The Notion page layer of the sync: one place that turns "this provider id
// should have a row" into a Notion page id, and keeps notionPageMap honest
// while doing it.
//
// Extracted from sync.ts so that file is the shape of a sync run — the chain
// of stages — rather than the chain plus everything it leans on. Deliberately
// exports no Convex functions: moving one of those between modules changes
// its api path, and a backfill scheduled before the deploy would land on a
// function that no longer exists there.

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import {
  createPage,
  findPageByText,
  setPageIcon,
  updatePage,
} from "./notionApi";

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type NotionIcon = Record<string, unknown>;

export type MapKind =
  | "bankConnection"
  | "account"
  | "transaction"
  | "security"
  | "holding"
  | "investmentTransaction"
  | "category"
  | "balanceSnapshot"
  | "recurringStream";

// The Notion property each database keeps the provider id in. Used to adopt
// a row a previous attempt already created rather than making a second one.
// Holdings and Balance History have none — they are keyed on account +
// security and account + date in their titles — so those rely on the claim
// alone (see notionSchemas.ts).
const ID_PROPERTY: Partial<Record<MapKind, string>> = {
  bankConnection: "ID",
  account: "ID",
  transaction: "ID",
  security: "ID",
  investmentTransaction: "Transaction ID",
  category: "ID",
  recurringStream: "ID",
};

// Reserve the map entry for a key, then create its Notion page, then write
// the real page id — in that order, and never batched with other rows.
//
// Creating first and mapping later leaves a window where a crash, a replayed
// Plaid page, or a second run produces a duplicate Notion row that nothing
// points at. Claiming first turns that window into a stale claim, which the
// next attempt recognises and resolves by adopting the page instead.
//
// Returns null when another caller holds the claim and never resolves it;
// the caller should treat that as a failure for this row and move on.
export async function claimAndCreatePage(
  ctx: ActionCtx,
  input: {
    userId: Id<"users">;
    kind: MapKind;
    providerId: string;
    token: string;
    databaseId: string;
    properties: Record<string, unknown>;
    icon?: NotionIcon;
    // The Plaid account this row belongs to, where there is one. Recorded on
    // the map row so reconciliation can find it without reading the user's
    // whole history; rows created before this was passed are scoped by
    // syncData.backfillMapScopes instead.
    accountId?: string;
    // Query Notion before every create, not just after a reclaimed claim.
    // Only worth the extra request where rows routinely outlive the map —
    // categories survive resetAndResync, transactions do not.
    alwaysAdopt?: boolean;
  },
): Promise<{ pageId: string; created: boolean } | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const claim = await ctx.runMutation(internal.syncData.claimMapEntry, {
      userId: input.userId,
      kind: input.kind,
      providerId: input.providerId,
      accountId: input.accountId,
    });
    if (claim.status === "ready") {
      return { pageId: claim.notionPageId, created: false };
    }
    if (claim.status === "pending") {
      await sleep(250 * (attempt + 1));
      continue;
    }
    const idProperty = ID_PROPERTY[input.kind];
    try {
      // Notion's rate limit is the binding constraint on a backfill, so this
      // extra query only happens where a duplicate is actually plausible.
      const adopted =
        idProperty && (input.alwaysAdopt || claim.reclaimed)
          ? await findPageByText(
              input.token,
              input.databaseId,
              idProperty,
              input.providerId,
            )
          : undefined;
      const pageId =
        adopted ??
        ((
          await createPage(
            input.token,
            input.databaseId,
            input.properties,
            input.icon,
          )
        ).id as string);
      await ctx.runMutation(internal.syncData.putMapEntries, {
        userId: input.userId,
        kind: input.kind,
        entries: [
          {
            providerId: input.providerId,
            notionPageId: pageId,
            accountId: input.accountId,
          },
        ],
      });
      return { pageId, created: !adopted };
    } catch (error) {
      // Drop the claim so the next sync retries instead of waiting it out.
      await ctx.runMutation(internal.syncData.deleteMapEntries, {
        userId: input.userId,
        kind: input.kind,
        providerIds: [input.providerId],
      });
      throw error;
    }
  }
  console.error("claim never resolved", input.kind, input.providerId);
  return null;
}

// Create or update the Notion page for a mapped entity; returns the page id.
export async function upsertMapped(
  ctx: ActionCtx,
  userId: Id<"users">,
  input: {
    kind: MapKind;
    providerId: string;
    token: string;
    databaseId: string;
    properties: Record<string, unknown>;
    runId: Id<"syncRuns">;
    // Scopes the map row to a Plaid account where the entity has one.
    accountId?: string;
    // Applied on creation only, so a later sync never overwrites an icon
    // the user has since chosen themselves.
    icon?: () => Promise<NotionIcon | undefined>;
  },
): Promise<string> {
  const claimed = await claimAndCreatePage(ctx, {
    userId,
    kind: input.kind,
    providerId: input.providerId,
    token: input.token,
    databaseId: input.databaseId,
    properties: input.properties,
    accountId: input.accountId,
  });
  if (!claimed) {
    throw new Error(
      `another sync holds the ${input.kind} claim for ${input.providerId}`,
    );
  }
  if (!claimed.created) {
    await updatePage(input.token, claimed.pageId, input.properties);
    await ctx.runMutation(internal.syncData.addRunStats, {
      runId: input.runId,
      added: 0,
      modified: 1,
      removed: 0,
    });
    return claimed.pageId;
  }
  if (input.icon) {
    try {
      const icon = await input.icon();
      if (icon) {
        await setPageIcon(input.token, claimed.pageId, icon);
      }
    } catch (error) {
      console.error("failed to set page icon", input.providerId, error);
    }
  }
  await ctx.runMutation(internal.syncData.addRunStats, {
    runId: input.runId,
    added: 1,
    modified: 0,
    removed: 0,
  });
  return claimed.pageId;
}

// The investments side of a sync: securities, holdings, recurring streams,
// and the reconciliation that notices an investment transaction has vanished
// from Plaid's window.
//
// Lifted out of sync.ts so that file is the chain of stages rather than the
// chain plus every pass it calls. Exports no Convex functions, so no api path
// moves (see syncPages.ts).

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import type { Security } from "plaid";
import { P, archivePage, isNotionUnauthorized, updatePage } from "./notionApi";
import { plaidClient, plaidErrorInfo } from "./plaidClient";
import { pfcIconUrl, pfcPrimary } from "./rulesEngine";
import { claimAndCreatePage } from "./syncPages";
import { holdingProperties, recurringStreamProperties } from "./syncMappers";
import { itemIsBroken, type SyncContext } from "./syncRun";
import { ensureCategoryPage } from "./syncTransactionWriter";

// A run archives at most this many vanished rows; the next one picks up the
// rest. Keeps a first reconciliation over a long history from trying to make
// hundreds of Notion calls in a single action.
const RECONCILE_ARCHIVE_LIMIT = 500;

// Rows one unmap mutation deletes. Each is a point lookup plus a delete, so
// this only has to stay inside one transaction's write budget.
const ARCHIVE_UNMAP_BATCH = 200;

// Archive the Notion rows for investment transactions this Item's accounts no
// longer have at Plaid. Cash transactions arrive with a `removed` list and
// holdings are a full snapshot, but investment transactions are create-and-
// update only, so a canceled trade sits in Notion forever without this.
//
// Walked one account at a time, a bounded page per query, resuming from the
// providerId each page ended on: the map holds every investment transaction
// the user has ever synced, so there is no version of this that reads them
// all. Rows with no accountId are outside every page this reads and are
// therefore never archived — see getVanishedInvestmentTransactions.
//
// Only ever called after a complete window walk with no failed writes. Note
// that "the window" is notion.startDate onwards, so moving that date forward
// would read as history vanishing — rewind cursors rather than narrow the
// window if that ever becomes editable.
export async function reconcileInvestmentTransactions(
  ctx: ActionCtx,
  input: {
    userId: Id<"users">;
    runId: Id<"syncRuns">;
    token: string;
    accountIds: string[];
  },
): Promise<number> {
  const archived: string[] = [];
  for (const accountId of input.accountIds) {
    let after: string | undefined = undefined;
    do {
      // Annotated because the inferred type flows back into `after`, which
      // this call's own arguments read.
      const page: {
        vanished: Array<{ providerId: string; notionPageId: string }>;
        nextProviderId: string | null;
      } = await ctx.runQuery(
        internal.syncData.getVanishedInvestmentTransactions,
        {
          userId: input.userId,
          runId: input.runId,
          accountId,
          afterProviderId: after,
        },
      );
      for (const entry of page.vanished) {
        if (archived.length >= RECONCILE_ARCHIVE_LIMIT) {
          break;
        }
        try {
          await archivePage(input.token, entry.notionPageId);
          archived.push(entry.providerId);
        } catch (error) {
          if (isNotionUnauthorized(error)) {
            throw error;
          }
          console.error(
            "failed to archive investment transaction",
            entry.providerId,
            error,
          );
        }
      }
      after = page.nextProviderId ?? undefined;
    } while (after !== undefined && archived.length < RECONCILE_ARCHIVE_LIMIT);
    if (archived.length >= RECONCILE_ARCHIVE_LIMIT) {
      break;
    }
  }
  if (archived.length > 0) {
    // One mutation per batch, not per row: the map keys are short and the
    // delete is a point lookup each.
    for (let index = 0; index < archived.length; index += ARCHIVE_UNMAP_BATCH) {
      await ctx.runMutation(internal.syncData.deleteMapEntries, {
        userId: input.userId,
        kind: "investmentTransaction",
        providerIds: archived.slice(index, index + ARCHIVE_UNMAP_BATCH),
      });
    }
  }
  const unscoped = await ctx.runQuery(
    internal.syncData.countUnscopedInvestmentTransactions,
    { userId: input.userId },
  );
  if (unscoped.count > 0) {
    console.log(
      `skipped ${unscoped.count}${unscoped.more ? "+" : ""} mapped ` +
        `investment transaction(s) with no account scope; run ` +
        `syncData.backfillMapScopes to make them reconcilable`,
    );
  }
  return archived.length;
}

export async function syncSecurities(
  ctx: ActionCtx,
  input: {
    userId: Id<"users">;
    token: string;
    databaseId: string | undefined;
    securities: Security[];
    runId: Id<"syncRuns">;
  },
): Promise<Record<string, string>> {
  const pages = await ctx.runQuery(internal.syncData.getAllMapEntries, {
    userId: input.userId,
    kind: "security",
  });
  if (!input.databaseId) {
    return pages;
  }
  const databaseId = input.databaseId;
  for (const security of input.securities) {
    const properties = {
      Symbol: P.title(
        security.ticker_symbol ?? security.name ?? security.security_id,
      ),
      "Security Name": P.text(security.name),
      ID: P.text(security.security_id),
      Type: P.select(security.type),
      "Close Price": P.number(security.close_price),
      "Close Price As Of": P.date(security.close_price_as_of),
    };
    try {
      const existing = pages[security.security_id];
      if (existing) {
        await updatePage(input.token, existing, properties);
        continue;
      }
      // Securities are keyed on the user, not the connection, so two
      // connections holding the same ETF can reach this at the same moment.
      const claimed = await claimAndCreatePage(ctx, {
        userId: input.userId,
        kind: "security",
        providerId: security.security_id,
        token: input.token,
        databaseId,
        properties,
      });
      if (!claimed) {
        console.error("security claim never resolved", security.security_id);
        continue;
      }
      if (!claimed.created) {
        await updatePage(input.token, claimed.pageId, properties);
      }
      pages[security.security_id] = claimed.pageId;
    } catch (error) {
      if (isNotionUnauthorized(error)) {
        throw error;
      }
      console.error("failed to sync security", security.security_id, error);
    }
  }
  return pages;
}

// Plaid works out which transactions form a recurring stream and hands back
// one row per subscription, salary, or standing order — so this is a database
// Finny can offer without computing anything, and without keeping anything: a
// stream's amounts go straight to Notion like every other figure here.
//
// Streams are few (tens, not thousands) and Plaid returns them all at once, so
// this is one pass in stage 1 rather than a self-rescheduling chain. Nothing
// is ever archived: a cancelled subscription becomes `is_active: false` and
// stays, which is more useful than deleting it.
export async function syncRecurring(
  ctx: ActionCtx,
  input: {
    context: SyncContext;
    runId: Id<"syncRuns">;
    accountPages: Record<string, string>;
    accountNames: Record<string, string>;
  },
): Promise<void> {
  const { connection, notion, accounts } = input.context;
  const databases = notion.databases!;
  const databaseId = databases.recurring;
  if (!databaseId) {
    return;
  }
  const token = notion.accessToken;
  const userId = connection.userId;
  const enabled = accounts.filter((account) => account.syncEnabled);
  if (enabled.length === 0) {
    return;
  }

  let response;
  try {
    response = await plaidClient(
      connection.plaidEnv ?? "production",
    ).transactionsRecurringGet({
      access_token: connection.accessToken,
      account_ids: enabled.map((account) => account.plaidAccountId),
    });
  } catch (error: any) {
    // Recurring needs enough transaction history to find a pattern, so a
    // freshly linked Item legitimately has none of this yet. Optional, like
    // holdings — but a broken Item is still the caller's problem.
    console.log("recurring streams unavailable", plaidErrorInfo(error).message);
    if (itemIsBroken(error)) {
      throw error;
    }
    return;
  }

  const hasCategoryRelation = Boolean(databases.categories);
  const categoryCache: Record<string, string> = {};
  const streams = [
    ...response.data.inflow_streams.map(
      (stream) => ({ stream, direction: "Inflow" as const }),
    ),
    ...response.data.outflow_streams.map(
      (stream) => ({ stream, direction: "Outflow" as const }),
    ),
  ];

  const mapped = await ctx.runQuery(internal.syncData.getMapEntries, {
    userId,
    kind: "recurringStream",
    providerIds: streams.map((entry) => entry.stream.stream_id),
  });

  const stats = { added: 0, modified: 0, removed: 0 };
  for (const { stream, direction } of streams) {
    const accountPage = input.accountPages[stream.account_id];
    if (!accountPage) {
      continue;
    }
    const detailed = stream.personal_finance_category?.detailed;
    const primary =
      stream.personal_finance_category?.primary ??
      (detailed ? pfcPrimary(detailed) : undefined);
    let categoryPageId: string | null = null;
    if (hasCategoryRelation && detailed && databases.categories) {
      // Seed usually created this already. Still go through ensure so a
      // category Plaid added after our taxonomy copy is not left blank.
      if (categoryCache[detailed]) {
        categoryPageId = categoryCache[detailed];
      } else {
        categoryPageId = await ensureCategoryPage(ctx, {
          userId,
          token,
          databaseId: databases.categories,
          detailed,
          primary: primary ?? detailed,
          iconUrl: primary ? pfcIconUrl(primary) : undefined,
        });
        if (categoryPageId) {
          categoryCache[detailed] = categoryPageId;
        }
      }
    }
    const properties = recurringStreamProperties(
      stream,
      direction,
      accountPage,
      // The stream's own category, not one a rule chose: rules run per
      // transaction, and a stream is not one.
      categoryPageId,
      hasCategoryRelation,
      notion.titleFormats,
      { account: input.accountNames[stream.account_id] },
    );
    try {
      const existing = mapped[stream.stream_id];
      if (existing) {
        await updatePage(token, existing, properties);
        stats.modified++;
        continue;
      }
      const claimed = await claimAndCreatePage(ctx, {
        userId,
        kind: "recurringStream",
        providerId: stream.stream_id,
        token,
        databaseId,
        properties,
        accountId: stream.account_id,
      });
      if (!claimed) {
        console.error("recurring claim never resolved", stream.stream_id);
        continue;
      }
      if (!claimed.created) {
        await updatePage(token, claimed.pageId, properties);
      }
      stats.added++;
    } catch (error) {
      if (isNotionUnauthorized(error)) {
        throw error;
      }
      console.error("failed to sync recurring stream", stream.stream_id, error);
    }
  }

  await ctx.runMutation(internal.syncData.addRunStats, {
    runId: input.runId,
    ...stats,
  });
}

export async function syncHoldings(
  ctx: ActionCtx,
  input: {
    context: SyncContext;
    runId: Id<"syncRuns">;
    accountPages: Record<string, string>;
    accountNames: Record<string, string>;
  },
): Promise<void> {
  const { connection, notion, accounts } = input.context;
  const databases = notion.databases!;
  const token = notion.accessToken;
  const userId = connection.userId;
  const client = plaidClient(connection.plaidEnv ?? "production");

  let holdingsData;
  try {
    holdingsData = await client.investmentsHoldingsGet({
      access_token: connection.accessToken,
    });
  } catch (error: any) {
    // Holdings are optional — a cash-only Item simply has none — so an Item
    // that merely does not offer them is not a failure. One that is broken is
    // the caller's problem: rethrowing puts it through failRun, which is what
    // marks the connection and stops the chain.
    console.log("holdings unavailable", plaidErrorInfo(error).message);
    if (itemIsBroken(error)) {
      throw error;
    }
    return;
  }

  const securityPages = await syncSecurities(ctx, {
    userId,
    token,
    databaseId: databases.securities,
    securities: holdingsData.data.securities,
    runId: input.runId,
  });
  const securityById = Object.fromEntries(
    holdingsData.data.securities.map((s) => [s.security_id, s]),
  );
  const enabledIds = new Set(
    accounts.filter((a) => a.syncEnabled).map((a) => a.plaidAccountId),
  );

  // One bounded read per account of this Item, rather than every holding row
  // the user has across every connection. A holding's providerId is
  // `${plaidAccountId}|${securityId}`, so account scoping covers them exactly.
  // Legacy rows with no accountId are invisible here: a create still finds
  // them through claimMapEntry (so no duplicate page), they just are not
  // archived until syncData.backfillMapScopes derives their account.
  const holdingPages: Record<string, string> = {};
  for (const account of accounts) {
    Object.assign(
      holdingPages,
      await ctx.runQuery(internal.syncData.getAccountMapEntries, {
        userId,
        kind: "holding",
        accountId: account.plaidAccountId,
      }),
    );
  }
  const seen = new Set<string>();
  let stats = { added: 0, modified: 0, removed: 0 };

  for (const holding of holdingsData.data.holdings) {
    if (!enabledIds.has(holding.account_id)) {
      continue;
    }
    const accountPage = input.accountPages[holding.account_id];
    if (!accountPage || !databases.holdings) {
      continue;
    }
    const providerId = `${holding.account_id}|${holding.security_id}`;
    seen.add(providerId);
    const security = securityById[holding.security_id];
    const symbol =
      security?.ticker_symbol ?? security?.name ?? holding.security_id;
    const properties = holdingProperties(
      holding,
      accountPage,
      securityPages[holding.security_id],
      symbol,
      notion.titleFormats,
      { account: input.accountNames[holding.account_id] },
    );
    try {
      const existing = holdingPages[providerId];
      if (existing) {
        await updatePage(token, existing, properties);
        stats.modified++;
      } else {
        // Holdings have no ID property to adopt by, so the claim is the only
        // thing standing between a retry and a duplicate row.
        const claimed = await claimAndCreatePage(ctx, {
          userId,
          kind: "holding",
          providerId,
          token,
          databaseId: databases.holdings,
          properties,
          accountId: holding.account_id,
        });
        if (!claimed) {
          console.error("holding claim never resolved", providerId);
          continue;
        }
        if (!claimed.created) {
          await updatePage(token, claimed.pageId, properties);
        }
        stats.added++;
      }
    } catch (error) {
      if (isNotionUnauthorized(error)) {
        throw error;
      }
      console.error("failed to sync holding", providerId, error);
    }
  }

  // Archive holdings that disappeared (sold positions). Everything read above
  // already belongs to one of this Item's accounts, so there is nothing left
  // to filter by connection.
  const removedIds: string[] = [];
  for (const [providerId, pageId] of Object.entries(holdingPages)) {
    if (seen.has(providerId)) {
      continue;
    }
    try {
      await archivePage(token, pageId);
      removedIds.push(providerId);
      stats.removed++;
    } catch (error) {
      if (isNotionUnauthorized(error)) {
        throw error;
      }
      console.error("failed to archive holding", providerId, error);
    }
  }

  if (removedIds.length > 0) {
    await ctx.runMutation(internal.syncData.deleteMapEntries, {
      userId,
      kind: "holding",
      providerIds: removedIds,
    });
  }
  await ctx.runMutation(internal.syncData.addRunStats, {
    runId: input.runId,
    ...stats,
  });
}

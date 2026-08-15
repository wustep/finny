// What every stage of a sync needs before it can do anything: the connection
// and its destination, how a run ends, and the lease that says this run is
// still the one in charge.
//
// Lifted out of sync.ts so that file is the chain of stages. Exports no
// Convex functions, so no api path moves (see syncPages.ts).

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { env, type ActionCtx } from "./_generated/server";
import {
  accountTitle,
  createComment,
  fileUploadIcon,
  uploadDataUri,
} from "./notionApi";
import { plaidErrorInfo } from "./plaidClient";
import type { NotionIcon } from "./syncPages";

export interface SyncContext {
  connection: Doc<"bankConnections">;
  notion: Doc<"notionConnections">;
  accounts: Doc<"accounts">[];
}

export async function loadContext(
  ctx: ActionCtx,
  connectionId: Id<"bankConnections">,
): Promise<SyncContext | null> {
  const context = await ctx.runQuery(internal.syncData.getContext, {
    connectionId,
  });
  if (!context || !context.notion?.databases) {
    return null;
  }
  return context as SyncContext;
}

// ---------- failure handling ----------

// Does this failure mean the Item needs its owner, rather than another try?
//
// A sync is where most broken Items are actually discovered: Plaid's ITEM
// ERROR webhook covers some cases, arrives late for others, and never arrives
// for an Item whose access was revoked outside the bank's own flow. Until the
// connection is marked, the Accounts page shows it as Active with no reconnect
// button and the daily cron keeps producing the same error.
//
// Transient codes — rate limits, institution outages, 5xx — are deliberately
// not marked: a reconnect fixes none of them, and the next run will work.
// The Notion title each of this connection's accounts has, keyed by Plaid
// account id. What a {account} token in any other database's format refers
// to, and derived rather than read back so a stage that never touched the
// Accounts database still knows it.
export function accountTitles(context: SyncContext): Record<string, string> {
  return Object.fromEntries(
    context.accounts.map((account) => [
      account.plaidAccountId,
      accountTitle(
        context.connection.institutionName,
        {
          name: account.name,
          official_name: account.officialName,
          mask: account.mask,
        },
        account.customName,
      ),
    ]),
  );
}

export function itemIsBroken(error: unknown): boolean {
  return plaidErrorInfo(error).itemBroken;
}

// End a run in error, saying what actually went wrong.
//
// `String(error)` on a failed Plaid call reads "Error: Request failed with
// status code 400", which is the one thing about it that does not matter.
// Plaid's error_code and error_message are on the response body, so a Plaid
// failure is unwrapped; anything else (a Notion write, a bug here) keeps its
// own message behind a note of which stage it came from.
//
// This is the only place a connection is marked broken, and it always fails
// the run at the same time. Marking without failing would be undone within the
// same run: finishRun's success path forces the connection back to active, so
// a stage that marked the Item and let the chain carry on would leave the card
// flipping between "needs attention" and "active" once a day.
export async function failRun(
  ctx: ActionCtx,
  input: {
    runId: Id<"syncRuns">;
    connectionId: Id<"bankConnections">;
    stage: string;
    error: unknown;
  },
): Promise<void> {
  const info = plaidErrorInfo(input.error);
  if (info.itemBroken) {
    await ctx.runMutation(internal.connections.markItemBroken, {
      connectionId: input.connectionId,
      errorCode: info.code,
    });
    // The Notion Bank Connections row says Active until something tells it
    // otherwise, and no sync will run to correct it while the Item is broken.
    await ctx.scheduler.runAfter(
      0,
      internal.sync.pushConnectionStatusToNotion,
      { connectionId: input.connectionId },
    );
  }
  await ctx.runMutation(internal.syncData.finishRun, {
    runId: input.runId,
    status: "error",
    error: info.code
      ? `${input.stage}: ${info.message}`
      : `${input.stage}: ${String(input.error)}`,
    // A broken Item is precisely the failure another attempt cannot get past.
    // Everything else here — a Notion 5xx, a rate limit, a page that would not
    // write — is worth trying again before tomorrow's sweep.
    retryable: !info.itemBroken,
  });
}

// The Status select option in the Notion Bank Connections database. Live
// contract with notionSchemas.ts, which creates those three options.
export function notionStatus(status: Doc<"bankConnections">["status"]): string {
  return status === "active"
    ? "Active"
    : status === "error"
      ? "Error"
      : "Pending expiration";
}

// What to say about a connection that has just changed state, or null when
// its state is not worth a comment.
export function statusComment(input: {
  status: Doc<"bankConnections">["status"];
  errorCode?: string;
  institutionName: string;
}): string | null {
  const app = env.SITE_URL ? ` Reconnect it at ${env.SITE_URL}` : "";
  switch (input.status) {
    case "error":
      return (
        `⚠️ Finny can't reach ${input.institutionName} any more, so nothing ` +
        `from it is reaching this page.${app}` +
        (input.errorCode ? ` (${input.errorCode})` : "")
      );
    case "pending_expiration":
      return (
        `⏳ ${input.institutionName} is about to stop sharing data with ` +
        `Finny — banks that sign you in through their own site expire every ` +
        `few months.${app}`
      );
    case "active":
      return `✅ ${input.institutionName} is working again.`;
  }
}

// Tell the user, in the one place they already look at this data.
//
// A comment on the Bank Connections row lands in their Notion inbox, which
// needs no email provider, no address on file, and carries nothing Finny is
// not allowed to keep — an institution name and a Plaid error code.
//
// Claimed through a mutation so the daily sweep, the webhook, and the run the
// webhook schedules cannot each say the same thing; and never throws, because
// a bank being broken is already the bad news.
export async function commentOnStatusChange(
  ctx: ActionCtx,
  connectionId: Id<"bankConnections">,
  token: string,
  pageId: string,
): Promise<void> {
  const claim = await ctx.runMutation(
    internal.syncData.claimStatusNotification,
    { connectionId },
  );
  if (!claim) {
    return;
  }
  const text = statusComment(claim);
  if (!text) {
    return;
  }
  try {
    await createComment(token, pageId, text);
  } catch (error) {
    // The integration may not have been granted the insert-comments
    // capability, which is a 403 every time and not worth a failed sync.
    console.error("failed to comment on connection status", error);
  }
}

// Push the sync lease out by another window at the top of each batch hop, so
// a long backfill keeps the connection to itself. A lost lease means this run
// was superseded — stop writing rather than race the run that took over.
export async function heartbeat(
  ctx: ActionCtx,
  connectionId: Id<"bankConnections">,
  runId: Id<"syncRuns">,
): Promise<boolean> {
  const held = await ctx.runMutation(internal.syncData.renewSyncLease, {
    connectionId,
    runId,
  });
  if (!held) {
    console.error("sync lease lost, abandoning run", runId);
    await ctx.runMutation(internal.syncData.finishRun, {
      runId,
      status: "error",
      // Someone else has the connection; a retry would only lose the race
      // again.
      retryable: false,
      error: "Sync lease lost: another run took over this connection.",
    });
  }
  return held;
}

// Plaid hands us the institution logo as base64, which Notion can only use
// as a page icon once it has been uploaded. Upload it once per connection
// and reuse the id for the connection page and every account under it.
//
// Returns a thunk rather than the icon itself so nothing is uploaded unless
// a page is actually created — an upload that never gets attached expires
// after an hour and would leave a dead id behind.
export function institutionIcon(
  ctx: ActionCtx,
  connection: Doc<"bankConnections">,
  token: string,
): () => Promise<NotionIcon | undefined> {
  let pending: Promise<NotionIcon | undefined> | undefined;
  const resolve = async () => {
    if (connection.notionIconFileUploadId) {
      return fileUploadIcon(connection.notionIconFileUploadId);
    }
    if (!connection.institutionLogo) {
      return undefined;
    }
    try {
      const fileUploadId = await uploadDataUri(
        token,
        `${connection.institutionName.replace(/[^\w -]/g, "")}.png`,
        connection.institutionLogo,
      );
      await ctx.runMutation(internal.connections.setNotionIconFileUpload, {
        connectionId: connection._id,
        fileUploadId,
      });
      return fileUploadIcon(fileUploadId);
    } catch (error) {
      // An icon is cosmetic; never fail a sync over one.
      console.error("institution icon upload failed", error);
      return undefined;
    }
  };
  return () => (pending ??= resolve());
}

// Shared Notion API helpers — used by both the V8 setup actions (notion.ts)
// and the node sync engine (sync.ts).
//
// The pure value/naming helpers live in syncMappers.ts so they can be unit
// tested without this module's fetch calls; they are re-exported here
// because callers think of them as part of the Notion surface.

import { titleCase } from "./syncMappers";

export {
  P,
  accountTitle,
  externalIcon,
  titleCase,
} from "./syncMappers";

export const NOTION_VERSION = "2022-06-28";
// File uploads, and file-backed page icons, postdate 2022-06-28. Only those
// calls opt into the newer version; everything else stays on the version
// whose database semantics the rest of this integration is written against.
const NOTION_FILES_VERSION = "2025-09-03";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Notion allows roughly three requests a second per integration token, and
// answers a burst with 429s. Firing as fast as the loop can go and retrying
// the rejections is strictly slower than not being rejected: every 429 costs
// a round trip plus at least a second of backoff, and the retry budget is
// then gone if a real conflict follows.
//
// So requests queue behind one another at a fixed spacing. The queue is a
// promise chain rather than a timer, which keeps the ordering the caller
// wrote and needs no cleanup — an action that ends mid-chain simply stops.
const MIN_REQUEST_INTERVAL_MS = 340;

// One queue per token, because that is what Notion's limit is per. Sharing a
// single queue across tokens would make two users' setup flows wait on each
// other for no reason — module state is not guaranteed to be per-invocation in
// the V8 runtime that notion.ts runs in, only in "use node".
//
// The queues live as long as the module instance does, which is the point:
// the bursts that matter are inside a single batch (a hundred transactions
// written by one transactionsBatch). Two instances syncing different
// connections of the same workspace at once is the case this cannot see, and
// the 429 retry below is what covers it.
const queues = new Map<string, { chain: Promise<void>; lastStartedAt: number }>();

function takeSlot(token: string): Promise<void> {
  const queue = queues.get(token) ?? { chain: Promise.resolve(), lastStartedAt: 0 };
  queues.set(token, queue);
  const slot = queue.chain.then(async () => {
    const wait = queue.lastStartedAt + MIN_REQUEST_INTERVAL_MS - Date.now();
    if (wait > 0) {
      await sleep(wait);
    }
    queue.lastStartedAt = Date.now();
  });
  // The chain must survive a rejection, or one failed slot poisons every
  // request that queues behind it.
  queue.chain = slot.catch(() => {});
  return slot;
}

// How many times a retryable response is retried before the error is thrown.
const MAX_ATTEMPTS = 5;

// Exponential with full jitter. Two syncs that hit the same limit at the same
// moment otherwise back off in lockstep and collide again on every retry.
function backoffMs(attempt: number): number {
  const ceiling = Math.min(500 * 2 ** attempt, 8_000);
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

// Thrown for any non-retryable Notion response. Callers that need to tell
// "the token is dead" from "this one row failed" should use
// `isNotionUnauthorized` rather than matching on the message string.
export class NotionApiError extends Error {
  readonly status: number;
  constructor(path: string, status: number, detail: string) {
    super(`Notion API ${path} failed (${status}): ${detail}`);
    this.name = "NotionApiError";
    this.status = status;
  }
}

// 401 is a revoked or expired integration token. 403 is often one page or
// capability (comments, a locked row) and must not be treated as the same
// thing — that would stop a whole Item over one restricted page.
export function isNotionUnauthorized(error: unknown): boolean {
  if (error instanceof NotionApiError) {
    return error.status === 401;
  }
  const text = String(error);
  return text.includes("Notion API") && text.includes("(401)");
}

export async function notionFetch(
  token: string,
  path: string,
  init?: { method?: string; body?: unknown; version?: string },
): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    await takeSlot(token);
    const response = await fetch(`https://api.notion.com/v1${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": init?.version ?? NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
    // Retry rate limits, write conflicts, and transient server errors.
    if (
      (response.status === 429 ||
        response.status === 409 ||
        response.status >= 500) &&
      attempt < MAX_ATTEMPTS - 1
    ) {
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : backoffMs(attempt),
      );
      continue;
    }
    const data: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new NotionApiError(
        path,
        response.status,
        data?.message ?? "unknown",
      );
    }
    return data;
  }
}

export function createPage(
  token: string,
  databaseId: string,
  properties: Record<string, unknown>,
  icon?: Record<string, unknown>,
): Promise<any> {
  return notionFetch(token, "/pages", {
    method: "POST",
    body: {
      parent: { database_id: databaseId },
      properties,
      ...(icon ? { icon } : {}),
    },
  });
}

export function updatePage(
  token: string,
  pageId: string,
  properties: Record<string, unknown>,
  icon?: Record<string, unknown>,
): Promise<any> {
  return notionFetch(token, `/pages/${pageId}`, {
    method: "PATCH",
    body: { properties, ...(icon ? { icon } : {}) },
  });
}

// Find a row by the value of one of its rich text properties. Used to adopt a
// page that already carries a provider id when the local map has lost track
// of it, rather than creating a second copy.
export async function findPageByText(
  token: string,
  databaseId: string,
  property: string,
  value: string,
): Promise<string | undefined> {
  const result = await notionFetch(token, `/databases/${databaseId}/query`, {
    method: "POST",
    body: {
      filter: { property, rich_text: { equals: value } },
      page_size: 1,
    },
  });
  return result?.results?.[0]?.id as string | undefined;
}

export function setPageIcon(
  token: string,
  pageId: string,
  icon: Record<string, unknown>,
): Promise<any> {
  return notionFetch(token, `/pages/${pageId}`, {
    method: "PATCH",
    body: { icon },
    version: NOTION_FILES_VERSION,
  });
}

export function fileUploadIcon(fileUploadId: string): Record<string, unknown> {
  return { type: "file_upload", file_upload: { id: fileUploadId } };
}

// Upload a base64 data URI to Notion and return the file upload id. Notion
// keeps the bytes, so an icon set from one survives this app going away.
// The id must be attached to something within an hour; after the first
// attachment it stops expiring and can be reused for any number of pages.
export async function uploadDataUri(
  token: string,
  filename: string,
  dataUri: string,
): Promise<string> {
  const match = /^data:([^;,]+);base64,(.+)$/.exec(dataUri);
  if (!match) {
    throw new Error("expected a base64 data URI");
  }
  const [, contentType, base64] = match;

  const upload = await notionFetch(token, "/file_uploads", {
    method: "POST",
    body: { mode: "single_part", filename, content_type: contentType },
    version: NOTION_FILES_VERSION,
  });

  // atob rather than Buffer: this module is also bundled into the V8
  // runtime actions in notion.ts.
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  const form = new FormData();
  form.append("file", new Blob([bytes], { type: contentType }), filename);
  // Multipart, so no Content-Type header — fetch sets it with the boundary.
  const response = await fetch(upload.upload_url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_FILES_VERSION,
    },
    body: form,
  });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `Notion file upload failed (${response.status}): ${data?.message ?? "unknown"}`,
    );
  }
  return data.id as string;
}

// Leave a comment on a page.
//
// This is how Finny tells someone a bank stopped working. It lands in their
// Notion inbox, which is where they already are, and it needs no email
// provider, no address on file, and no delivery of anything Finny is not
// allowed to store — the text names an institution and a Plaid error code and
// nothing else.
//
// Requires the "insert comments" capability on the integration; without it
// Notion answers 403 and the caller is expected to shrug.
export function createComment(
  token: string,
  pageId: string,
  text: string,
): Promise<any> {
  return notionFetch(token, "/comments", {
    method: "POST",
    body: {
      parent: { page_id: pageId },
      rich_text: [{ type: "text", text: { content: text.slice(0, 2000) } }],
    },
  });
}

export function archivePage(token: string, pageId: string): Promise<any> {
  return notionFetch(token, `/pages/${pageId}`, {
    method: "PATCH",
    body: { archived: true },
  });
}

// ---------- naming helpers ----------

// "FOOD_AND_DRINK_COFFEE" with primary "FOOD_AND_DRINK" -> "Coffee"
export function categoryName(detailed: string, primary: string): string {
  const rest = detailed.startsWith(`${primary}_`)
    ? detailed.slice(primary.length + 1)
    : detailed;
  return titleCase(rest);
}

export function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

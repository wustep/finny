// Shared Notion API helpers — used by both the V8 setup actions (notion.ts)
// and the node sync engine (sync.ts).

const NOTION_VERSION = "2022-06-28";
// File uploads, and file-backed page icons, postdate 2022-06-28. Only those
// calls opt into the newer version; everything else stays on the version
// whose database semantics the rest of this integration is written against.
const NOTION_FILES_VERSION = "2025-09-03";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function notionFetch(
  token: string,
  path: string,
  init?: { method?: string; body?: unknown; version?: string },
): Promise<any> {
  for (let attempt = 0; ; attempt++) {
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
      attempt < 4
    ) {
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 1000 * (attempt + 1),
      );
      continue;
    }
    const data: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        `Notion API ${path} failed (${response.status}): ${data?.message ?? "unknown"}`,
      );
    }
    return data;
  }
}

// An icon hosted elsewhere. Notion stores the URL and renders it directly,
// so unlike an uploaded file this costs nothing and needs no bookkeeping —
// but it breaks if whoever hosts it stops serving that URL.
export function externalIcon(url: string): Record<string, unknown> {
  return { type: "external", external: { url } };
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

export function archivePage(token: string, pageId: string): Promise<any> {
  return notionFetch(token, `/pages/${pageId}`, {
    method: "PATCH",
    body: { archived: true },
  });
}

// ---------- property value builders ----------

const clip = (s: string) => s.slice(0, 2000);

export const P = {
  title: (s: string) => ({
    title: [{ type: "text", text: { content: clip(s || "Untitled") } }],
  }),
  text: (s: string | null | undefined) => ({
    rich_text: s ? [{ type: "text", text: { content: clip(s) } }] : [],
  }),
  number: (n: number | null | undefined) => ({
    number: typeof n === "number" && Number.isFinite(n) ? n : null,
  }),
  date: (s: string | null | undefined) => ({
    date: s ? { start: s } : null,
  }),
  // Select option names cannot contain commas.
  select: (name: string | null | undefined) =>
    name ? { select: { name: clip(name).replaceAll(",", " ") } } : { select: null },
  relation: (pageId: string | null | undefined) => ({
    relation: pageId ? [{ id: pageId }] : [],
  }),
  checkbox: (b: boolean) => ({ checkbox: b }),
};

// ---------- naming helpers ----------

// "FOOD_AND_DRINK" -> "Food and Drink"
export function titleCase(enumValue: string): string {
  return enumValue
    .toLowerCase()
    .split("_")
    .map((word) =>
      word === "and" || word === "of" ? word : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
}

// "FOOD_AND_DRINK_COFFEE" with primary "FOOD_AND_DRINK" -> "Coffee"
export function categoryName(detailed: string, primary: string): string {
  const rest = detailed.startsWith(`${primary}_`)
    ? detailed.slice(primary.length + 1)
    : detailed;
  return titleCase(rest);
}

// "Chase" + "Freedom Unlimited" + "7449" -> "Chase Freedom Unlimited *7449",
// unless the user renamed the account, in which case their name wins.
export function accountTitle(
  institutionName: string,
  account: {
    name: string;
    official_name?: string | null;
    mask?: string | null;
  },
  customName?: string,
): string {
  if (customName) {
    return customName;
  }
  const base =
    account.official_name && account.official_name.length >= account.name.length
      ? account.official_name
      : account.name;
  const institutionWord = institutionName.split(" ")[0]?.toLowerCase() ?? "";
  const withInstitution =
    institutionWord && base.toLowerCase().startsWith(institutionWord)
      ? base
      : `${institutionName} ${base}`;
  return account.mask ? `${withInstitution} *${account.mask}` : withInstitution;
}

export function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

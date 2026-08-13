// Shared Notion API helpers — used by both the V8 setup actions (notion.ts)
// and the node sync engine (sync.ts).

const NOTION_VERSION = "2022-06-28";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function notionFetch(
  token: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`https://api.notion.com/v1${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
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

export function createPage(
  token: string,
  databaseId: string,
  properties: Record<string, unknown>,
): Promise<any> {
  return notionFetch(token, "/pages", {
    method: "POST",
    body: { parent: { database_id: databaseId }, properties },
  });
}

export function updatePage(
  token: string,
  pageId: string,
  properties: Record<string, unknown>,
): Promise<any> {
  return notionFetch(token, `/pages/${pageId}`, {
    method: "PATCH",
    body: { properties },
  });
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

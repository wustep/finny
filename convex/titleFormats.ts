// What a synced row is called in Notion.
//
// Every database Finny writes has a title, and until now each one was named
// by a line of code: a transaction by its merchant, an investment transaction
// by whatever Plaid put in `name`. That is a fine default and a poor rule —
// "[2026-08-14] Buy CSBS" is a perfectly reasonable thing to want, and there
// was no way to ask for it.
//
// This is deliberately not part of the rules engine. A rule is conditional and
// per transaction — which of these rows is special — and only ever applies to
// transactions. A title format is unconditional and per database: what all of
// these are called. The two meet in exactly one place, and the specific wins:
// a rule's rename overrides the format for the row it matched.
//
// Pure, and free of Convex and Plaid imports, so it can be unit tested and
// imported by the browser (see titleFormats.test.ts and the Rules page).
//
// On the invariant: a template says how to lay a row out, never what was
// found in one. Same side of the line as a rule's conditions.

export interface TitleToken {
  name: string;
  // Read on its own in a tooltip, so it is a sentence rather than a fragment
  // waiting for a label to complete it.
  describes: string;
}

export interface TitleFormatSpec {
  // Notion database key, as in notionConnections.databases.
  key: string;
  label: string;
  tokens: TitleToken[];
  // The built-in title, written as a template. Every default happens to be
  // expressible in the same syntax people type, which makes it the honest
  // placeholder: it says what the title is made of and teaches the syntax at
  // the same time. Rendering still falls back to the code path rather than
  // running this, so the two can never drift into disagreeing.
  defaultTemplate: string;
  example: Record<string, string>;
}

// Only the databases where a different title is actually useful.
//
// Left out on purpose: Accounts already has a per-account custom name, which
// beats a format for the one thing anyone wants to change there; Bank
// Connections is the institution's name; Securities is the ticker. A format
// for any of those would be a control that only ever restates its own value.
export const TITLE_FORMATS: TitleFormatSpec[] = [
  {
    key: "transactions",
    label: "Transactions",
    tokens: [
      { name: "merchant", describes: "Plaid's cleaned-up merchant name." },
      { name: "description", describes: "The raw description your bank sent." },
      { name: "amount", describes: "The amount, signed as Notion shows it: money out is negative." },
      { name: "date", describes: "The date, as 2026-08-14." },
      { name: "account", describes: "The account's name, as it appears in Notion." },
      { name: "category", describes: "The category, such as Coffee." },
    ],
    defaultTemplate: "{merchant}",
    example: {
      merchant: "Blue Bottle Coffee",
      description: "SQ *BLUE BOTTLE COFFEE 123",
      amount: "-6.25",
      date: "2026-08-14",
      account: "Chase Checking *7449",
      category: "Coffee",
    },
  },
  {
    key: "investmentTransactions",
    label: "Investment Transactions",
    tokens: [
      { name: "name", describes: "Whatever Plaid called this transaction." },
      { name: "type", describes: "One of buy, sell, cash, fee or transfer." },
      { name: "subtype", describes: "The subtype, such as Dividend or Contribution." },
      { name: "security", describes: "The ticker, falling back to the security's name." },
      { name: "amount", describes: "The amount, signed as Notion shows it." },
      { name: "quantity", describes: "How many units were traded." },
      { name: "date", describes: "The date, as 2026-08-14." },
      { name: "account", describes: "The account's name, as it appears in Notion." },
    ],
    defaultTemplate: "{name}",
    example: {
      name: "BUY CSBS",
      type: "buy",
      subtype: "buy",
      security: "CSBS",
      amount: "-1200",
      quantity: "12",
      date: "2026-08-14",
      account: "Fidelity Brokerage *5555",
    },
  },
  {
    key: "holdings",
    label: "Holdings",
    tokens: [
      { name: "security", describes: "The ticker, falling back to the security's name." },
      { name: "quantity", describes: "How many units you hold." },
      { name: "value", describes: "The market value, as the institution reports it." },
      { name: "price", describes: "The institution's price per unit." },
      { name: "account", describes: "The account's name, as it appears in Notion." },
    ],
    defaultTemplate: "{security} Holding",
    example: {
      security: "VTI",
      quantity: "31.4",
      value: "7842.16",
      price: "249.75",
      account: "Fidelity Brokerage *5555",
    },
  },
  {
    key: "balanceHistory",
    label: "Balance History",
    tokens: [
      { name: "date", describes: "The date, as 2026-08-14." },
      { name: "account", describes: "The account's name, as it appears in Notion." },
      { name: "balance", describes: "The balance recorded that day." },
    ],
    defaultTemplate: "{date} · {account}",
    example: {
      date: "2026-08-14",
      account: "Chase Checking *7449",
      balance: "1204.55",
    },
  },
  {
    key: "recurring",
    label: "Recurring",
    tokens: [
      { name: "merchant", describes: "The merchant, falling back to the bank's description." },
      { name: "frequency", describes: "How often it recurs, such as Monthly." },
      { name: "direction", describes: "Whether money comes in or goes out." },
      { name: "amount", describes: "The average amount, signed as Notion shows it." },
      { name: "account", describes: "The account's name, as it appears in Notion." },
    ],
    defaultTemplate: "{merchant}",
    example: {
      merchant: "Netflix",
      frequency: "Monthly",
      direction: "Outflow",
      amount: "-15.49",
      account: "Chase Checking *7449",
    },
  },
];

export const TITLE_FORMAT_BY_KEY: Record<string, TitleFormatSpec> =
  Object.fromEntries(TITLE_FORMATS.map((spec) => [spec.key, spec]));

// A template is short by nature; the cap is here so a stored one cannot be
// used to smuggle a novel into every row.
export const MAX_TEMPLATE_LENGTH = 200;

// What a token can be put through on the way out: {amount.money},
// {merchant.upper}, {amount.abs.money}.
//
// A dot rather than a pipe, and rather than a sigil like {$amount}, because
// it reads as what it is — the lowercase version of merchant — instead of as
// plumbing. It composes for free: "absolute value, then as money" is two in
// the order you read them, and a third later needs no new punctuation, which
// is the thing a sigil per operation cannot do.
export const FILTERS: TitleToken[] = [
  {
    name: "money",
    describes:
      "Formats a number as money, in the row's own currency: {amount.money} gives $1,200.00.",
  },
  {
    name: "abs",
    describes: "Drops the minus sign, so {amount.abs} turns −40 into 40.",
  },
  { name: "upper", describes: "Uppercases the text: {merchant.upper}." },
  { name: "lower", describes: "Lowercases the text: {merchant.lower}." },
];

const FILTER_NAMES = new Set(FILTERS.map((filter) => filter.name));

const TOKEN = /\{([a-zA-Z]+)((?:\.[a-zA-Z]+)*)\}/g;

// The token names a template uses, in the order they appear.
export function tokensIn(template: string): string[] {
  return [...template.matchAll(TOKEN)].map((match) => match[1]);
}

// The filter names a template uses, whether or not they exist.
export function filtersIn(template: string): string[] {
  return [...template.matchAll(TOKEN)].flatMap((match) =>
    match[2] ? match[2].split(".").filter(Boolean) : [],
  );
}

export function unknownFilters(template: string): string[] {
  return [...new Set(filtersIn(template))].filter(
    (name) => !FILTER_NAMES.has(name),
  );
}

// Put one value through one filter. A filter that cannot apply to what it was
// given passes it through rather than throwing: a title is not worth failing a
// row over, and `{merchant.money}` is a mistake the write-time check catches
// anyway.
function applyFilter(
  value: string | number,
  filter: string,
  currency: string,
): string | number {
  switch (filter) {
    case "abs":
      return typeof value === "number" ? Math.abs(value) : value;
    case "money": {
      const amount = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(amount)) {
        return value;
      }
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
      }).format(amount);
    }
    case "upper":
      return String(value).toUpperCase();
    case "lower":
      return String(value).toLowerCase();
    default:
      return value;
  }
}

// Any token the given database does not offer. A template that names one is
// refused on write rather than rendering a blank for ever after.
export function unknownTokens(key: string, template: string): string[] {
  const spec = TITLE_FORMAT_BY_KEY[key];
  if (!spec) {
    return tokensIn(template);
  }
  const known = new Set(spec.tokens.map((token) => token.name));
  return [...new Set(tokensIn(template))].filter((name) => !known.has(name));
}

// Render a template against the values a sync has in hand.
//
// A token with no value renders as nothing, and the gap it leaves is closed
// up — which is what makes "{merchant} {date}" behave sensibly for a
// transaction with no merchant, without the template needing a syntax for
// alternatives. A template that renders to nothing at all falls back to the
// title the code would have produced anyway, so a row is never called
// "Untitled" because a format was too ambitious.
export function renderTitle(
  template: string | undefined,
  values: Record<string, string | number | null | undefined>,
  fallback: string,
  // The row's own currency, so {amount|money} on a Canadian account says
  // CA$ rather than assuming everyone banks in dollars.
  currency = "USD",
): string {
  if (!template?.trim()) {
    return fallback;
  }
  const rendered = template
    .replace(TOKEN, (_match, name: string, suffix: string) => {
      const value = values[name];
      if (value === null || value === undefined) {
        return "";
      }
      const filters = suffix ? suffix.split(".").filter(Boolean) : [];
      return String(
        filters.reduce<string | number>(
          (carried, filter) => applyFilter(carried, filter, currency),
          value,
        ),
      );
    })
    // Tokens that rendered empty leave gaps, and a gap between two spaces is
    // not something anyone asked for.
    .replace(/\s+/g, " ")
    // Same for the punctuation people bracket tokens with: "[]" and "()" left
    // behind by an empty token read as a mistake rather than as a style.
    .replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return rendered || fallback;
}

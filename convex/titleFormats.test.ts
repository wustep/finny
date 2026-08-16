import { describe, expect, test } from "vitest";
import {
  TITLE_FORMATS,
  filtersIn,
  unknownFilters,
  renderTitle,
  tokensIn,
  unknownTokens,
} from "./titleFormats";

describe("renderTitle", () => {
  const values = {
    date: "2026-08-14",
    subtype: "Buy",
    security: "CSBS",
    amount: -1200,
    quantity: 12,
    merchant: null,
  };

  test("fills the tokens it knows", () => {
    expect(renderTitle("[{date}] {subtype} {security}", values, "fallback")).toBe(
      "[2026-08-14] Buy CSBS",
    );
  });

  test("renders numbers, including negative ones, as themselves", () => {
    expect(renderTitle("{security} {amount}", values, "fallback")).toBe(
      "CSBS -1200",
    );
    // Zero is a value, not an absence.
    expect(renderTitle("{quantity}", { quantity: 0 }, "fallback")).toBe("0");
  });

  test("an empty token closes the gap it leaves", () => {
    // Which is what makes one template work for transactions that have a
    // merchant and ones that do not, with no syntax for alternatives.
    expect(renderTitle("{merchant} {security}", values, "fallback")).toBe("CSBS");
    expect(renderTitle("{security} — {merchant}", values, "fallback")).toBe(
      "CSBS —",
    );
  });

  test("brackets left empty by a missing token are dropped", () => {
    expect(renderTitle("[{merchant}] {security}", values, "fallback")).toBe(
      "CSBS",
    );
    expect(renderTitle("{security} ({merchant})", values, "fallback")).toBe(
      "CSBS",
    );
  });

  test("a template that renders to nothing falls back", () => {
    // A row is never called "Untitled" because a format was too ambitious.
    expect(renderTitle("{merchant}", values, "Buy CSBS")).toBe("Buy CSBS");
    expect(renderTitle("[{merchant}]", values, "Buy CSBS")).toBe("Buy CSBS");
  });

  test("no template at all is the built-in title", () => {
    expect(renderTitle(undefined, values, "Buy CSBS")).toBe("Buy CSBS");
    expect(renderTitle("   ", values, "Buy CSBS")).toBe("Buy CSBS");
  });

  test("an unknown token renders as nothing rather than as itself", () => {
    // Writes refuse these, so this only covers a template stored before a
    // token was renamed.
    expect(renderTitle("{security} {nope}", values, "fallback")).toBe("CSBS");
  });

  test("text around the tokens is kept exactly", () => {
    expect(renderTitle("Buy: {security}!", values, "fallback")).toBe(
      "Buy: CSBS!",
    );
  });
});

describe("token validation", () => {
  test("tokens are read in the order they appear", () => {
    expect(tokensIn("[{date}] {subtype} {security}")).toEqual([
      "date",
      "subtype",
      "security",
    ]);
  });

  test("a token the database does not offer is named", () => {
    expect(unknownTokens("transactions", "{merchant} {ticker}")).toEqual([
      "ticker",
    ]);
    expect(unknownTokens("transactions", "{merchant} {amount}")).toEqual([]);
  });

  test("every default template is itself valid", () => {
    // It is shown as the placeholder, so a default naming a token the
    // database does not offer would be teaching the wrong syntax.
    for (const spec of TITLE_FORMATS) {
      expect(unknownTokens(spec.key, spec.defaultTemplate)).toEqual([]);
    }
  });

  test("every default renders to something against its own example", () => {
    for (const spec of TITLE_FORMATS) {
      expect(
        renderTitle(spec.defaultTemplate, spec.example, "FELL BACK"),
        spec.key,
      ).not.toBe("FELL BACK");
    }
  });

  test("every spec's example covers every token it offers", () => {
    // The example is what the Rules page previews against, so a token with no
    // example would preview as a gap and look broken.
    for (const spec of TITLE_FORMATS) {
      for (const token of spec.tokens) {
        expect(spec.example[token.name], `${spec.key}.${token.name}`).toBeTruthy();
      }
    }
  });
});

describe("filters", () => {
  const values = { amount: -1200.5, merchant: "Blue Bottle Coffee", quantity: 12 };

  test("money puts the symbol in the right place", () => {
    expect(renderTitle("{amount.money}", values, "x")).toBe("-$1,200.50");
    expect(renderTitle("{quantity.money}", values, "x")).toBe("$12.00");
  });

  test("money uses the row's own currency", () => {
    // The same mistake as a dollar-formatted column: a Canadian account's
    // numbers are not US dollars.
    expect(renderTitle("{amount.money}", values, "x", "CAD")).toBe("-CA$1,200.50");
  });

  test("filters compose left to right", () => {
    expect(renderTitle("{amount.abs.money}", values, "x")).toBe("$1,200.50");
  });

  test("case filters do what they say", () => {
    expect(renderTitle("{merchant.upper}", values, "x")).toBe(
      "BLUE BOTTLE COFFEE",
    );
    expect(renderTitle("{merchant.lower}", values, "x")).toBe(
      "blue bottle coffee",
    );
  });

  test("a filter that cannot apply passes the value through", () => {
    // Writes catch this; at render time a title is not worth failing a row
    // over.
    expect(renderTitle("{merchant.money}", values, "x")).toBe(
      "Blue Bottle Coffee",
    );
    expect(renderTitle("{merchant.nope}", values, "x")).toBe(
      "Blue Bottle Coffee",
    );
  });

  test("a filtered token that has no value still collapses", () => {
    expect(renderTitle("[{missing.money}] {merchant}", values, "x")).toBe(
      "Blue Bottle Coffee",
    );
  });

  test("filters are read out of a template, known or not", () => {
    expect(filtersIn("{amount.abs.money} {merchant.upper}")).toEqual([
      "abs",
      "money",
      "upper",
    ]);
    expect(unknownFilters("{amount.abs.nope}")).toEqual(["nope"]);
    expect(unknownFilters("{amount.abs.money}")).toEqual([]);
  });

  test("a token with filters is still the same token", () => {
    expect(tokensIn("{amount.money}")).toEqual(["amount"]);
    expect(unknownTokens("transactions", "{amount.money}")).toEqual([]);
    expect(unknownTokens("transactions", "{ticker.money}")).toEqual(["ticker"]);
  });
});

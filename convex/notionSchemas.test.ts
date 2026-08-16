import { expect, test } from "vitest";
import { PFC_TAXONOMY } from "./rulesEngine";
import { titleCase } from "./syncMappers";
import {
  CATEGORY_GROUP_OPTIONS,
  DATABASE_SPECS,
  NOTION_SCHEMA_VERSION,
  MAP_KINDS_BY_DATABASE,
  SPEC_BY_KEY,
  propertyTypes,
  relationDependencies,
} from "./notionSchemas";

test("every relation between Finny's databases is discovered", () => {
  const found = relationDependencies().map(
    (dependency) => `${dependency.from}.${dependency.property} -> ${dependency.to}`,
  );
  // Read off the specs. A relation added or removed there should fail this
  // and be added or removed here deliberately — the rebuild path repoints
  // exactly this list, so a missed one is a dead column in Notion.
  expect(found.sort()).toEqual(
    [
      "accounts.Bank Connection -> bankConnections",
      "balanceHistory.Account -> accounts",
      "holdings.Account -> accounts",
      "holdings.Security -> securities",
      "investmentTransactions.Related Account -> accounts",
      "investmentTransactions.Related Security -> securities",
      "recurring.Account -> accounts",
      "recurring.Category -> categories",
      "transactions.Account -> accounts",
      "transactions.Category -> categories",
    ].sort(),
  );
});

test("a database is always created after everything it points at", () => {
  // ensureDatabases walks DATABASE_SPECS in order and hands each spec the ids
  // built so far, so a relation to a database further down the list would be
  // built against undefined.
  const position = new Map(
    DATABASE_SPECS.map((spec, index) => [spec.key, index]),
  );
  for (const dependency of relationDependencies()) {
    expect(position.get(dependency.to)!).toBeLessThan(
      position.get(dependency.from)!,
    );
  }
});

test("property types are read off the specs", () => {
  const transactions = propertyTypes(SPEC_BY_KEY.transactions);
  expect(transactions).toMatchObject({
    Name: "title",
    ID: "rich_text",
    Amount: "number",
    Date: "date",
    Pending: "checkbox",
    Account: "relation",
    Category: "relation",
  });
});

test("every database says which page ids live in it", () => {
  // A rebuild drops the map entries pointing into the database it replaced.
  // A spec with no entry here would leave them behind, and every later sync
  // would patch pages that no longer exist.
  for (const spec of DATABASE_SPECS) {
    expect(MAP_KINDS_BY_DATABASE[spec.key]).toBeDefined();
  }
});

test("every category group the taxonomy produces has a declared option", () => {
  // The names have to be exactly what categoryName writes into the row, or
  // Notion invents the option — with a random colour — the first time a
  // category lands in it.
  const declared = new Set(CATEGORY_GROUP_OPTIONS.map(([name]) => name));
  for (const primary of Object.keys(PFC_TAXONOMY)) {
    expect(declared.has(titleCase(primary))).toBe(true);
  }
  expect(declared.size).toBe(Object.keys(PFC_TAXONOMY).length);
});

test("category group options carry no commas", () => {
  // P.select strips them, so an option name with one would never match the
  // option the database was built with.
  for (const [name] of CATEGORY_GROUP_OPTIONS) {
    expect(name).not.toContain(",");
  }
});

test("accounts carry a currency", () => {
  expect(propertyTypes(SPEC_BY_KEY.accounts).Currency).toBe("select");
});

test("the schema version is bumped when a property is added", () => {
  // Not a real invariant so much as a tripwire: this count changes whenever a
  // spec gains or loses a property. A property *added* has to move the
  // version with it, or destinations already built never get the column and
  // every sync 400s on the row that writes it. A property removed does not:
  // nothing needs adding, and the column stays in databases that have it —
  // where it becomes one of the user's own, which is where Tags went.
  const properties = DATABASE_SPECS.reduce(
    (total, spec) => total + Object.keys(propertyTypes(spec)).length,
    0,
  );
  expect({ properties, version: NOTION_SCHEMA_VERSION }).toEqual({
    properties: 68,
    version: 2,
  });
});

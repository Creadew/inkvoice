import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createT } from "@/i18n";
import { getNavItems } from "@/nav-registry";
import "@/plugins";
import { CATEGORIES, type CatalogItem } from "@/plugins/agency-services/api";
import {
  addMonthsIso,
  billsNow,
  customLine,
  firstRenewalDate,
  itemLineText,
  lineFromItem,
  orderTotals,
  packageBlock,
  removeLine,
  toPayload,
} from "@/plugins/agency-services/lines";
import { getPlugins } from "@/plugins/registry";
import { getRoutes } from "@/route-registry";

function item(overrides: Partial<CatalogItem>): CatalogItem {
  return {
    id: "id",
    kind: "addon",
    name: "Item",
    category: "other",
    description: null,
    features: [],
    billing: "one_time",
    price: 0,
    setup_fee: 0,
    interval_unit: null,
    interval_count: 1,
    unit: "piece",
    tax_id: null,
    product_id: null,
    is_active: 1,
    addons: [],
    packages: [],
    ...overrides,
  };
}

const hosting = item({
  id: "hosting",
  name: "Web hosting",
  billing: "recurring",
  interval_unit: "year",
  price: 24000,
  unit: "year",
});
const logo = item({ id: "logo", name: "Logo design", price: 15000 });
const page = item({ id: "page", name: "Extra page", price: 5000, unit: "page" });
const pkg = item({
  id: "pkg",
  kind: "package",
  name: "Business Website",
  features: ["12 pages", "Blog"],
  price: 95000,
  addons: [
    { addon_id: "hosting", mode: "included", free_months: 12 },
    { addon_id: "logo", mode: "included", free_months: 0 },
    { addon_id: "page", mode: "optional", free_months: 0 },
  ],
});
const catalog = [pkg, hosting, logo, page];

describe("order builder lines", () => {
  test("a package brings its included add-ons, not its optional ones", () => {
    const block = packageBlock(pkg, catalog);
    expect(block.map((l) => [l.name, l.included, l.free_months])).toEqual([
      ["Business Website", false, 0],
      ["Web hosting", true, 12],
      ["Logo design", true, 0],
    ]);
    expect(block[0].description).toBe("Business Website — 12 pages · Blog");
    expect(block.slice(1).every((l) => l.parentKey === block[0].key)).toBe(true);
  });

  test("an archived included add-on is left out", () => {
    const block = packageBlock(pkg, [pkg, { ...hosting, is_active: 0 }, logo]);
    expect(block.map((l) => l.name)).toEqual(["Business Website", "Logo design"]);
  });

  test("removing a package removes the add-ons it included", () => {
    const block = packageBlock(pkg, catalog);
    const lines = [...block, lineFromItem(page)];
    expect(removeLine(lines, block[0].key).map((l) => l.name)).toEqual(["Extra page"]);
  });

  test("totals bill one-time lines, setup fees and first periods, not free or included ones", () => {
    const smm = lineFromItem(
      item({
        name: "Social media",
        billing: "recurring",
        interval_unit: "month",
        price: 35000,
        setup_fee: 10000,
      }),
    );
    const lines = [...packageBlock(pkg, catalog), { ...lineFromItem(page), quantity: 3 }, smm];
    expect(lines.filter(billsNow).map((l) => l.name)).toEqual([
      "Business Website",
      "Extra page",
      "Social media",
    ]);
    expect(orderTotals(lines)).toEqual({ dueNow: 155000, monthly: 37000, recurringCount: 2 });
  });

  test("the payload drops the editor's keys", () => {
    const payload = toPayload(customLine());
    expect("key" in payload).toBe(false);
    expect("parentKey" in payload).toBe(false);
    expect(payload).toMatchObject({ kind: "custom", billing: "one_time", quantity: 1 });
  });

  test("an item without features reads as its description", () => {
    expect(itemLineText({ name: "SEO audit", features: [], description: "Full site review" })).toBe(
      "SEO audit — Full site review",
    );
  });
});

describe("renewal dates", () => {
  test("months clamp to short months and keep the anchor day", () => {
    expect(addMonthsIso("2027-01-31", 1)).toBe("2027-02-28");
    expect(addMonthsIso("2027-02-28", 1, 31)).toBe("2027-03-31");
    expect(addMonthsIso("2026-12-15", 12)).toBe("2027-12-15");
  });

  test("the first renewal follows the server's activation rule", () => {
    const [, hostingLine] = packageBlock(pkg, catalog);
    const monthly = lineFromItem(
      item({ billing: "recurring", interval_unit: "month", price: 1000 }),
    );
    // Free months push the first renewal out, invoiced or not.
    expect(firstRenewalDate(hostingLine, "2026-12-10", true)).toBe("2027-12-10");
    // The first month is on the invoice, so it renews a month on...
    expect(firstRenewalDate(monthly, "2026-12-10", true)).toBe("2027-01-10");
    // ...and with no invoice it bills from the start.
    expect(firstRenewalDate(monthly, "2026-12-10", false)).toBe("2026-12-10");
  });
});

describe("agency services bootstrap", () => {
  test("registers its pages, sidebar entries and settings panel", () => {
    const paths = getRoutes("protected").map((r) => r.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "/agency/catalog/:tab?",
        "/agency/orders/new",
        "/agency/orders/:tab?",
        "/agency/subscriptions",
      ]),
    );
    const nav = getNavItems().filter((n) => n.pluginId === "agency-services");
    expect(nav.map((n) => n.to)).toEqual([
      "/agency/catalog",
      "/agency/orders",
      "/agency/subscriptions",
    ]);
    expect(nav.every((n) => n.section === "agency_services.section")).toBe(true);
    expect(getPlugins().find((p) => p.id === "agency-services")?.settings).toBeDefined();
  });
});

describe("agency services translations", () => {
  const dir = join(import.meta.dir, "../plugins/agency-services");
  const source = readdirSync(dir)
    .filter((f) => /\.tsx?$/.test(f) && f !== "i18n.ts")
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");

  const keys = new Set<string>();
  for (const m of source.matchAll(/\bta?\(\s*"([a-z0-9_]+)"/g)) keys.add(m[1]);
  // ta(cond ? "a" : "b"), but not a template literal's ${cond ? "x" : "y"}.
  for (const m of source.matchAll(/\bta?\([^()`]*?\?\s*"([a-z0-9_]+)"\s*:\s*"([a-z0-9_]+)"/g)) {
    keys.add(m[1]);
    keys.add(m[2]);
  }
  for (const m of source.matchAll(/"(col_[a-z_]+)"/g)) keys.add(m[1]);
  for (const m of source.matchAll(/"agency_services\.([a-z0-9_]+)"/g)) keys.add(m[1]);

  // Keys built from a value at runtime.
  const kinds = ["package", "addon", "service"];
  const families: string[] = [
    ...CATEGORIES.map((c) => `category_${c}`),
    ...["one_time", "recurring"].map((b) => `billing_${b}`),
    ...[...kinds, "custom"].map((k) => `kind_${k}`),
    ...kinds.flatMap((k) => [`new_${k}`, `edit_${k}`, `empty_${k}`, `features_placeholder_${k}`]),
    ...["packages", "addons", "services"].flatMap((s) => [`tab_${s}`, `tab_${s}_hint`]),
    ...["quote", "invoice"].flatMap((m) => [`mode_${m}`, `mode_${m}_hint`]),
    ...["quoted", "active", "cancelled"].map((s) => `order_status_${s}`),
    ...["all", "quoted", "active", "cancelled"].map((s) => `order_tab_${s}`),
    ...["active", "paused", "ended", "cancelled"].map((s) => `sub_status_${s}`),
    ...["active", "paused", "ended", "cancelled", "all"].map((s) => `sub_tab_${s}`),
    ...["schedule", "manual", "order"].map((s) => `source_${s}`),
  ];
  for (const k of families) keys.add(k);

  test("finds the keys it checks", () => {
    expect(keys.size).toBeGreaterThan(200);
  });

  for (const lang of ["en", "tr"] as const) {
    test(`every key the plugin uses exists in ${lang}`, () => {
      const t = createT(lang);
      const missing = [...keys].filter((k) => t(`agency_services.${k}`) === `agency_services.${k}`);
      expect(missing).toEqual([]);
    });
  }
});

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import type { Hono } from "hono";
import { createApp } from "../app";
import { closeDatabase, getDb, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import "../plugins";
import {
  type CatalogItem,
  createItem,
  deleteItem,
  getItem,
  listItems,
  setPackageAddons,
  updateItem,
} from "../plugins/agency-services/catalog";
import { DEFAULT_CONFIG, updateConfig } from "../plugins/agency-services/config";
import { seedExampleCatalog } from "../plugins/agency-services/examples";
import {
  activateOrder,
  buildDocument,
  cancelOrder,
  createOrder,
  normalizeLines,
  type OrderLineInput,
} from "../plugins/agency-services/orders";
import { addMonths, isIsoDate, periodEnd } from "../plugins/agency-services/periods";
import {
  billNow,
  createSubscription,
  deleteSubscription,
  getHistory,
  getSubscription,
  getSummary,
  pauseSubscription,
  resumeSubscription,
  runDueBilling,
  updateSubscription,
} from "../plugins/agency-services/subscriptions";
import { runPluginMigrations } from "../plugins/runner";
import { setPluginEnabled } from "../plugins/settings";
import { deleteInvoice, getInvoice } from "../services/invoice.service";
import { getQuote } from "../services/quote.service";
import { updateSettings } from "../services/settings.service";
import { resetEnvCache } from "../utils/env";

const TEST_DB = "./data/test-agency-services.db";
const TODAY = "2026-12-01";
let app: Hono;
let token: string;

function api(path: string, init: RequestInit = {}) {
  return app.request(`/api/v1/plugins/agency-services${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string>),
    },
  });
}

function makeCustomer(name: string): string {
  const row = getDb()
    .query("INSERT INTO customers (name, email) VALUES (?, ?) RETURNING id")
    .get(name, `${name.toLowerCase().replace(/\W+/g, ".")}@example.lk`) as { id: string };
  return row.id;
}

function resetAgencyData() {
  const db = getDb();
  db.exec(`
    DELETE FROM agency_billing_log;
    DELETE FROM agency_subscriptions;
    DELETE FROM agency_orders;
    DELETE FROM agency_package_addons;
    DELETE FROM agency_items;
    DELETE FROM agency_config;
  `);
}

beforeAll(async () => {
  process.env.DATABASE_PATH = TEST_DB;
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASS = "agencytestadminpass";
  process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-chars-long";
  process.env.RATE_LIMIT_ENABLED = "false";
  resetEnvCache();
  initDatabase();
  runMigrations();
  runPluginMigrations();
  await seed();
  // A Sri Lankan agency: rupees, ISO dates, Net 14 by default.
  updateSettings({
    base_currency: "LKR",
    currency: "LKR",
    date_format: "YYYY-MM-DD",
    default_payment_terms: "Net 14",
  });
  app = createApp();

  const res = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "agencytestadminpass" }),
  });
  token = ((await res.json()) as { data: { token: string } }).data.token;
});

afterAll(() => {
  closeDatabase();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB + suffix);
    } catch {}
  }
});

describe("periods", () => {
  test("month addition clamps to short months and keeps the anchor day", () => {
    expect(addMonths("2027-01-31", 1)).toBe("2027-02-28");
    expect(addMonths("2027-02-28", 1, 31)).toBe("2027-03-31");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2026-11-15", 14)).toBe("2028-01-15");
    expect(addMonths("2027-03-31", -1)).toBe("2027-02-28");
  });

  test("a period ends the day before the next one starts", () => {
    expect(periodEnd("2027-02-15", "year", 1)).toBe("2028-02-14");
    expect(periodEnd("2026-12-01", "month", 1)).toBe("2026-12-31");
    expect(periodEnd("2026-12-01", "month", 3)).toBe("2027-02-28");
  });

  test("only real calendar dates are accepted", () => {
    expect(isIsoDate("2027-02-28")).toBe(true);
    expect(isIsoDate("2027-02-29")).toBe(false);
    expect(isIsoDate("2027-2-1")).toBe(false);
  });
});

describe("catalog", () => {
  beforeEach(resetAgencyData);

  test("an item keeps a core product in sync", () => {
    const pkg = createItem({
      kind: "package",
      name: "Business Website",
      category: "web_design",
      features: ["Up to 12 pages", "  ", "Blog section"],
      price: 95000,
    });
    expect(pkg.features).toEqual(["Up to 12 pages", "Blog section"]);
    expect(pkg.product_id).not.toBeNull();
    const product = () =>
      getDb().query("SELECT * FROM products WHERE id = ?").get(pkg.product_id) as {
        name: string;
        unit_price: number;
        unit: string;
        is_active: number;
      };
    expect(product()).toMatchObject({ name: "Business Website", unit_price: 95000, unit: "piece" });

    updateItem(pkg.id, { price: 99000, is_active: false });
    expect(product()).toMatchObject({ unit_price: 99000, is_active: 0 });
  });

  test("recurring items use their interval as the unit and keep a setup fee", () => {
    const smm = createItem({
      kind: "package",
      name: "Social Media – Starter",
      billing: "recurring",
      interval_unit: "month",
      price: 35000,
      setup_fee: 10000,
    });
    expect(smm).toMatchObject({ interval_unit: "month", interval_count: 1, unit: "month" });
    expect(smm.setup_fee).toBe(10000);

    const oneTime = updateItem(smm.id, { billing: "one_time" })!;
    expect(oneTime).toMatchObject({ interval_unit: null, setup_fee: 0 });
  });

  test("packages pair with add-ons; free months only on included recurring add-ons", () => {
    const pkg = createItem({ kind: "package", name: "Starter Website", price: 45000 });
    const hosting = createItem({
      kind: "addon",
      name: "Web hosting",
      billing: "recurring",
      interval_unit: "year",
      price: 12000,
    });
    const page = createItem({ kind: "addon", name: "Additional page", price: 5000, unit: "page" });
    const service = createItem({ kind: "service", name: "SEO audit", price: 20000 });

    const result = setPackageAddons(pkg.id, [
      { addon_id: hosting.id, mode: "included", free_months: 12 },
      { addon_id: page.id, mode: "included", free_months: 6 },
    ]);
    expect(result.ok).toBe(true);
    const paired = getItem(pkg.id)!;
    expect(paired.addons).toEqual([
      { addon_id: hosting.id, mode: "included", free_months: 12 },
      { addon_id: page.id, mode: "included", free_months: 0 },
    ]);
    expect(getItem(hosting.id)!.packages).toEqual([
      { id: pkg.id, name: "Starter Website", mode: "included" },
    ]);

    expect(
      setPackageAddons(pkg.id, [{ addon_id: service.id, mode: "optional", free_months: 0 }]),
    ).toEqual({ ok: false, error: "Add-on not found" });
    expect(setPackageAddons(page.id, [])).toEqual({
      ok: false,
      error: "Only packages offer add-ons",
    });
  });

  test("deleting an item retires its product when a document uses it", () => {
    const used = createItem({ kind: "service", name: "Logo design", price: 15000 });
    const unused = createItem({ kind: "service", name: "Banner design", price: 4000 });
    const customer = makeCustomer("Retire Ltd");
    getDb().run(
      `INSERT INTO quotes (id, quote_number, customer_id, issue_date) VALUES ('q-retire', 'Q-RET', ?, ?)`,
      [customer, TODAY],
    );
    getDb().run(
      "INSERT INTO quote_items (quote_id, product_id, description) VALUES ('q-retire', ?, 'Logo')",
      [used.product_id],
    );

    expect(deleteItem(used.id)).toBe(true);
    expect(deleteItem(unused.id)).toBe(true);
    const product = (id: string | null) =>
      getDb().query("SELECT is_active FROM products WHERE id = ?").get(id) as {
        is_active: number;
      } | null;
    expect(product(used.product_id)?.is_active).toBe(0);
    expect(product(unused.product_id)).toBeNull();
    expect(getItem(used.id)).toBeNull();
  });

  test("the example catalog loads once, in rupees for an LKR workspace", () => {
    const items = seedExampleCatalog()!;
    expect(items.length).toBeGreaterThan(15);
    const business = items.find((i) => i.name === "Business Website")!;
    expect(business.price).toBe(95000);
    expect(business.addons.filter((a) => a.mode === "included")).toHaveLength(2);
    expect(business.addons.find((a) => a.mode === "included")?.free_months).toBe(12);
    expect(seedExampleCatalog()).toBeNull();
  });
});

describe("order documents", () => {
  const fmt = { money: (n: number) => `LKR ${n.toFixed(2)}`, date: (d: string) => d };

  function websiteLines(): OrderLineInput[] {
    return [
      {
        kind: "package",
        name: "Business Website",
        description: "Business Website — Up to 12 pages · Blog section",
        billing: "one_time",
        unit_price: 95000,
      },
      {
        kind: "addon",
        name: "Web hosting – Business",
        billing: "recurring",
        interval_unit: "year",
        unit_price: 24000,
        free_months: 12,
        reference: "acme.lk",
        included: true,
      },
      {
        kind: "addon",
        name: "Logo design",
        billing: "one_time",
        unit_price: 15000,
        included: true,
      },
      {
        kind: "addon",
        name: "Additional page",
        billing: "one_time",
        unit_price: 5000,
        quantity: 3,
        unit: "page",
      },
      {
        kind: "service",
        name: "Social media management",
        billing: "recurring",
        interval_unit: "month",
        unit_price: 35000,
        setup_fee: 10000,
      },
    ];
  }

  test("a quote lists included add-ons on the package and summarises renewals", () => {
    const doc = buildDocument(normalizeLines(websiteLines()), {
      mode: "quote",
      startDate: TODAY,
      ...fmt,
    });
    expect(doc.items.map((i) => [i.description, i.quantity, i.unit_price])).toEqual([
      [
        "Business Website — Up to 12 pages · Blog section. Includes: Web hosting – Business (acme.lk) (first year free), Logo design",
        1,
        95000,
      ],
      ["Additional page", 3, 5000],
      ["Setup: Social media management", 1, 10000],
      ["Social media management (billed monthly)", 1, 35000],
    ]);
    expect(doc.items.map((i) => i.sort_order)).toEqual([0, 1, 2, 3]);
    expect(doc.recurring_summary).toBe(
      "Recurring charges: Web hosting – Business (acme.lk): free for the first year, then LKR 24000.00 per year; Social media management: LKR 35000.00 per month.",
    );
  });

  test("an invoice prints the first period's dates", () => {
    const doc = buildDocument(normalizeLines(websiteLines()), {
      mode: "invoice",
      startDate: TODAY,
      ...fmt,
    });
    expect(doc.items.at(-1)?.description).toBe("Social media management (2026-12-01 – 2026-12-31)");
  });

  test("an included add-on without a package line gets a zero-priced line", () => {
    const doc = buildDocument(
      normalizeLines([
        {
          kind: "addon",
          name: "Logo design",
          billing: "one_time",
          unit_price: 15000,
          included: true,
        },
      ]),
      { mode: "quote", startDate: TODAY, ...fmt },
    );
    expect(doc.items).toHaveLength(1);
    expect(doc.items[0]).toMatchObject({ description: "Logo design (included)", unit_price: 0 });
  });

  test("references to deleted catalog items and tax rates are dropped", () => {
    const [line] = normalizeLines([
      {
        item_id: "gone",
        tax_id: "gone",
        kind: "service",
        name: "X",
        billing: "one_time",
        unit_price: 1,
      },
    ]);
    expect(line).toMatchObject({ item_id: null, product_id: null, tax_id: null });
  });
});

describe("orders", () => {
  let customer: string;
  let pkg: CatalogItem;
  let hosting: CatalogItem;
  let smm: CatalogItem;

  beforeEach(() => {
    resetAgencyData();
    customer = makeCustomer(`Order Client ${Math.random().toString(36).slice(2, 7)}`);
    pkg = createItem({ kind: "package", name: "Business Website", price: 95000 });
    hosting = createItem({
      kind: "addon",
      name: "Web hosting",
      billing: "recurring",
      interval_unit: "year",
      price: 24000,
    });
    smm = createItem({
      kind: "service",
      name: "Social media management",
      billing: "recurring",
      interval_unit: "month",
      price: 35000,
    });
  });

  function lines(): OrderLineInput[] {
    return [
      { item_id: pkg.id, kind: "package", name: pkg.name, billing: "one_time", unit_price: 95000 },
      {
        item_id: hosting.id,
        kind: "addon",
        name: hosting.name,
        billing: "recurring",
        interval_unit: "year",
        unit_price: 24000,
        free_months: 12,
        reference: "client.lk",
        included: true,
      },
      {
        item_id: smm.id,
        kind: "service",
        name: smm.name,
        billing: "recurring",
        interval_unit: "month",
        unit_price: 35000,
      },
    ];
  }

  test("a quoted order becomes an invoice and subscriptions on activation", () => {
    const created = createOrder(
      { customer_id: customer, lines: lines(), mode: "quote", notes: "Thank you!" },
      null,
      TODAY,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const order = created.data;
    expect(order).toMatchObject({
      status: "quoted",
      title: "Business Website",
      currency: "LKR",
      initial_total: 130000,
      monthly_recurring: 37000,
    });

    const quote = getQuote(order.quote_id!)!;
    expect(quote.total).toBe(130000);
    expect(quote.items.map((i) => i.product_id)).toEqual([pkg.product_id, smm.product_id]);
    expect(quote.notes).toStartWith("Thank you!\n\nRecurring charges:");

    const activated = activateOrder(order.id, { start_date: "2026-12-10" }, TODAY);
    expect(activated.ok).toBe(true);
    if (!activated.ok) return;
    expect(activated.data.status).toBe("active");
    expect(getQuote(order.quote_id!)!.status).toBe("converted");
    const invoice = getInvoice(activated.data.invoice_id!)!;
    expect(invoice.total).toBe(130000);

    const subs = getDb()
      .query(
        "SELECT name, reference, next_billing_date, anchor_day, last_invoice_id FROM agency_subscriptions WHERE order_id = ? ORDER BY name",
      )
      .all(order.id);
    expect(subs).toEqual([
      // The first month was on the quote, so the next renewal is a month on.
      {
        name: "Social media management",
        reference: null,
        next_billing_date: "2027-01-10",
        anchor_day: 10,
        last_invoice_id: invoice.id,
      },
      // Hosting is free for the first year.
      {
        name: "Web hosting",
        reference: "client.lk",
        next_billing_date: "2027-12-10",
        anchor_day: 10,
        last_invoice_id: null,
      },
    ]);
  });

  test("activating links the invoice a quote was already converted into", async () => {
    const created = createOrder(
      { customer_id: customer, lines: lines(), mode: "quote" },
      null,
      TODAY,
    );
    if (!created.ok) throw new Error(created.error);
    // Converted through the core Quotes screen first, e.g. into instalments.
    const res = await app.request(`/api/v1/quotes/${created.data.quote_id}/convert`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(201);
    const converted = getQuote(created.data.quote_id!)!.converted_invoice_id;
    const countInvoices = () =>
      (getDb().query("SELECT COUNT(*) AS n FROM invoices").get() as { n: number }).n;
    const before = countInvoices();

    const activated = activateOrder(created.data.id, {}, TODAY);
    if (!activated.ok) throw new Error(activated.error);
    expect(activated.data.invoice_id).toBe(converted);
    expect(countInvoices()).toBe(before);
  });

  test("an invoice order starts its subscriptions at once", () => {
    const created = createOrder(
      { customer_id: customer, lines: lines(), mode: "invoice", start_date: TODAY },
      null,
      TODAY,
    );
    if (!created.ok) throw new Error(created.error);
    expect(created.data.status).toBe("active");
    const invoice = getInvoice(created.data.invoice_id!)!;
    expect(invoice.due_date).toBe("2026-12-15");
    expect(invoice.payment_terms).toBe("Net 14");
    expect(invoice.items.at(-1)?.description).toBe(
      "Social media management (2026-12-01 – 2026-12-31)",
    );
    const smmSub = getDb()
      .query("SELECT id FROM agency_subscriptions WHERE order_id = ? AND name = ?")
      .get(created.data.id, smm.name) as { id: string };
    expect(getHistory(smmSub.id)).toEqual([
      expect.objectContaining({
        period_start: "2026-12-01",
        period_end: "2026-12-31",
        amount: 35000,
        source: "order",
      }),
    ]);
  });

  test("activating without an invoice bills every subscription from the start", () => {
    const created = createOrder(
      { customer_id: customer, lines: lines(), mode: "quote" },
      null,
      TODAY,
    );
    if (!created.ok) throw new Error(created.error);
    const activated = activateOrder(
      created.data.id,
      { start_date: TODAY, create_invoice: false },
      TODAY,
    );
    if (!activated.ok) throw new Error(activated.error);
    expect(activated.data.invoice_id).toBeNull();
    expect(getQuote(created.data.quote_id!)!.status).toBe("draft");
    const dates = getDb()
      .query("SELECT next_billing_date FROM agency_subscriptions WHERE order_id = ? ORDER BY name")
      .all(created.data.id)
      .map((r) => (r as { next_billing_date: string }).next_billing_date);
    expect(dates).toEqual(["2026-12-01", "2027-12-01"]);
  });

  test("cancelling an active order cancels its subscriptions", () => {
    const created = createOrder(
      { customer_id: customer, lines: lines(), mode: "invoice" },
      null,
      TODAY,
    );
    if (!created.ok) throw new Error(created.error);
    expect(cancelOrder(created.data.id).ok).toBe(true);
    const statuses = getDb()
      .query("SELECT DISTINCT status FROM agency_subscriptions WHERE order_id = ?")
      .all(created.data.id);
    expect(statuses).toEqual([{ status: "cancelled" }]);
    expect(activateOrder(created.data.id, {}, TODAY)).toMatchObject({ ok: false });
  });
});

describe("renewal billing", () => {
  let customer: string;

  beforeEach(() => {
    resetAgencyData();
    updateConfig({ ...DEFAULT_CONFIG });
    customer = makeCustomer(`Renewal Client ${Math.random().toString(36).slice(2, 7)}`);
  });

  function sub(input: Partial<Parameters<typeof createSubscription>[0]> = {}) {
    const res = createSubscription({
      customer_id: customer,
      name: "Domain renewal",
      reference: "client.lk",
      price: 5500,
      interval_unit: "year",
      next_billing_date: "2026-12-10",
      ...input,
    });
    if (!res.ok) throw new Error(res.error);
    return res.data;
  }

  test("renewals inside the lead window share one invoice, due on the renewal date", async () => {
    const domain = sub();
    const hosting = sub({
      name: "Web hosting",
      reference: null,
      price: 24000,
      next_billing_date: "2026-12-14",
    });
    const later = sub({ name: "Maintenance", price: 30000, next_billing_date: "2027-01-20" });

    const run = await runDueBilling(TODAY);
    expect(run.invoices).toHaveLength(1);
    expect(run.periods).toBe(2);

    const invoice = getInvoice(run.invoices[0])!;
    expect(invoice).toMatchObject({
      status: "draft",
      customer_id: customer,
      currency: "LKR",
      issue_date: TODAY,
      due_date: "2026-12-10",
      service_period_start: "2026-12-10",
      service_period_end: "2027-12-13",
      total: 29500,
    });
    expect(invoice.items.map((i) => [i.description, i.unit])).toEqual([
      ["Domain renewal – client.lk (2026-12-10 – 2027-12-09)", "year"],
      ["Web hosting (2026-12-14 – 2027-12-13)", "year"],
    ]);
    expect(getSubscription(domain.id)!.next_billing_date).toBe("2027-12-10");
    expect(getSubscription(hosting.id)!.last_invoice_id).toBe(invoice.id);
    expect(getSubscription(later.id)!.next_billing_date).toBe("2027-01-20");

    // Running again bills nothing new.
    expect((await runDueBilling(TODAY)).invoices).toHaveLength(0);
  });

  test("without bundling each renewal gets its own invoice", async () => {
    updateConfig({ bundle: false });
    sub();
    sub({ name: "Web hosting", next_billing_date: "2026-12-05" });
    expect((await runDueBilling(TODAY)).invoices).toHaveLength(2);
  });

  test("missed periods are caught up on one invoice and an end date ends it", async () => {
    const monthly = sub({
      name: "Social media management",
      reference: null,
      price: 35000,
      interval_unit: "month",
      start_date: "2026-09-01",
      next_billing_date: "2026-10-01",
      end_date: "2026-12-31",
    });
    const run = await runDueBilling(TODAY);
    const invoice = getInvoice(run.invoices[0])!;
    expect(invoice.items.map((i) => i.description)).toEqual([
      "Social media management (2026-10-01 – 2026-10-31)",
      "Social media management (2026-11-01 – 2026-11-30)",
      "Social media management (2026-12-01 – 2026-12-31)",
    ]);
    // Billed late, so it is due on issue rather than in the past.
    expect(invoice.due_date).toBe(TODAY);
    expect(getSubscription(monthly.id)).toMatchObject({
      status: "ended",
      next_billing_date: "2027-01-01",
    });
  });

  test("a renewal on the 31st comes back to the 31st after February", async () => {
    const s = sub({ interval_unit: "month", next_billing_date: "2027-01-31" });
    await billNow(s.id, TODAY);
    expect(getSubscription(s.id)!.next_billing_date).toBe("2027-02-28");
    await billNow(s.id, TODAY);
    expect(getSubscription(s.id)!.next_billing_date).toBe("2027-03-31");
  });

  test("bill now invoices the next period whatever its date", async () => {
    const s = sub({ next_billing_date: "2027-06-01" });
    const res = await billNow(s.id, TODAY);
    if (!res.ok) throw new Error(res.error);
    expect(getInvoice(res.data.invoice_id)!.items[0].description).toBe(
      "Domain renewal – client.lk (2027-06-01 – 2028-05-31)",
    );
    expect(getSubscription(s.id)!.next_billing_date).toBe("2028-06-01");
    expect(getHistory(s.id)).toHaveLength(1);
  });

  test("a period whose invoice was deleted can be billed again", async () => {
    const s = sub();
    const first = await billNow(s.id, TODAY);
    if (!first.ok) throw new Error(first.error);
    deleteInvoice(first.data.invoice_id);
    updateSubscription(s.id, { next_billing_date: "2026-12-10" });
    const again = await billNow(s.id, TODAY);
    expect(again.ok).toBe(true);
    // A live invoice blocks re-billing the same period.
    updateSubscription(s.id, { next_billing_date: "2026-12-10" });
    expect(await billNow(s.id, TODAY)).toMatchObject({
      ok: false,
      error: "This period has already been invoiced",
    });
  });

  test("auto-send issues the renewal invoice even when email is not set up", async () => {
    updateConfig({ auto_send: true });
    sub();
    const run = await runDueBilling(TODAY);
    const invoice = getInvoice(run.invoices[0])!;
    expect(invoice.status).toBe("sent");
    expect(invoice.invoice_number.startsWith("DRAFT")).toBe(false);
  });

  test("resuming skips renewals that fell inside the pause", () => {
    const s = sub({ interval_unit: "month", price: 35000, next_billing_date: "2026-09-05" });
    expect(pauseSubscription(s.id).ok).toBe(true);
    const resumed = resumeSubscription(s.id, TODAY);
    if (!resumed.ok) throw new Error(resumed.error);
    expect(resumed.data).toMatchObject({ status: "active", next_billing_date: "2026-12-05" });
  });

  test("a billed subscription is cancelled instead of deleted", async () => {
    const billed = sub();
    await billNow(billed.id, TODAY);
    expect(deleteSubscription(billed.id)).toEqual({ ok: true, data: { deleted: false } });
    expect(getSubscription(billed.id)!.status).toBe("cancelled");

    const fresh = sub({ name: "Unbilled" });
    expect(deleteSubscription(fresh.id)).toEqual({ ok: true, data: { deleted: true } });
    expect(getSubscription(fresh.id)).toBeNull();
  });

  test("dates are validated", () => {
    expect(
      createSubscription({
        customer_id: customer,
        name: "Bad",
        price: 1,
        interval_unit: "month",
        start_date: "2027-01-01",
        next_billing_date: "2026-12-01",
      }),
    ).toMatchObject({ ok: false });
  });

  test("the summary reports recurring revenue and upcoming renewals", () => {
    sub();
    sub({ name: "Social", price: 35000, interval_unit: "month", next_billing_date: "2027-03-01" });
    const paused = sub({ name: "Paused", price: 99999, interval_unit: "month" });
    pauseSubscription(paused.id);
    const summary = getSummary(TODAY);
    expect(summary.counts).toMatchObject({ active: 2, paused: 1 });
    expect(summary.recurring).toEqual([
      { currency: "LKR", monthly: 35458.33, yearly: 425500, count: 2 },
    ]);
    expect(summary.upcoming).toEqual({ count: 1, totals: [{ currency: "LKR", amount: 5500 }] });
    expect(summary.ready_to_invoice).toBe(1);
  });
});

describe("agency services api", () => {
  beforeAll(() => {
    resetAgencyData();
  });

  test("routes answer 404 while the plugin is disabled", async () => {
    setPluginEnabled("agency-services", false);
    expect((await api("/items")).status).toBe(404);
    setPluginEnabled("agency-services", true);
    expect((await api("/items")).status).toBe(200);
  });

  test("catalog, order and subscription round trip", async () => {
    setPluginEnabled("agency-services", true);
    const customer = makeCustomer("Api Client");

    const bad = await api("/items", {
      method: "POST",
      body: JSON.stringify({ kind: "package", name: "" }),
    });
    expect(bad.status).toBe(400);

    const created = await api("/items", {
      method: "POST",
      body: JSON.stringify({
        kind: "package",
        name: "Landing page",
        features: ["One page", "Contact form"],
        price: 30000,
      }),
    });
    expect(created.status).toBe(201);
    const item = ((await created.json()) as { data: CatalogItem }).data;

    const order = await api("/orders", {
      method: "POST",
      body: JSON.stringify({
        customer_id: customer,
        mode: "quote",
        lines: [
          {
            item_id: item.id,
            kind: "package",
            name: item.name,
            billing: "one_time",
            unit_price: 30000,
          },
        ],
      }),
    });
    expect(order.status).toBe(201);
    const orderBody = (await order.json()) as { data: { id: string; quote_number: string } };
    expect(orderBody.data.quote_number).toBeTruthy();

    const activity = getDb()
      .query(
        "SELECT action, resource_type FROM activity_log WHERE metadata LIKE ? ORDER BY rowid DESC",
      )
      .get(`%${orderBody.data.id}%`);
    expect(activity).toEqual({ action: "created", resource_type: "quote" });

    const subRes = await api("/subscriptions", {
      method: "POST",
      body: JSON.stringify({
        customer_id: customer,
        name: "Hosting",
        price: 12000,
        interval_unit: "year",
        next_billing_date: "2027-02-30",
      }),
    });
    expect(subRes.status).toBe(400);

    const summary = await api("/subscriptions/summary");
    expect(summary.status).toBe(200);

    const config = await api("/config", {
      method: "PUT",
      body: JSON.stringify({ lead_days: 21, auto_send: false }),
    });
    expect(((await config.json()) as { data: { lead_days: number } }).data.lead_days).toBe(21);
    expect(listItems().map((i) => i.name)).toContain("Landing page");
  });
});

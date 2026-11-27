// Orders: a sale built from the catalog. The builder sends lines (packages,
// their included add-ons, optional add-ons, services, custom lines). An order
// becomes a core quote ("quoted", activated once the client accepts) or a
// core invoice ("active" at once). Activation starts a subscription for every
// recurring line.
//
// The first document bills one-time lines, setup fees and the first period of
// each recurring line. A recurring line with free months (hosting included
// for the first year) bills nothing yet; its subscription starts billing when
// the free period ends. Included add-ons with nothing to bill are listed on
// their package's line instead of as zero-priced lines, and every recurring
// charge is summarised in the document notes so the client sees what renews.

import crypto from "node:crypto";
import { getDb } from "../../database/connection";
import { getBaseCurrency } from "../../services/exchange-rate.service";
import { createInvoice } from "../../services/invoice.service";
import { convertToInvoice, createQuote, getQuote } from "../../services/quote.service";
import { getAllSettings } from "../../services/settings.service";
import { todayIso } from "../../utils/date";
import { type Billing, type Category, recurringUnit } from "./catalog";
import {
  addDays,
  addInterval,
  addMonths,
  dayOfMonth,
  type IntervalUnit,
  monthlyValue,
  periodEnd,
  round2,
} from "./periods";
import {
  cancelOrderSubscriptions,
  documentFormatters,
  insertSubscription,
  logInitialPeriod,
  type Result,
} from "./subscriptions";

export const LINE_KINDS = ["package", "addon", "service", "custom"] as const;
export type LineKind = (typeof LINE_KINDS)[number];

export const ORDER_STATUSES = ["quoted", "active", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const MAX_ORDER_LINES = 100;

export interface OrderLineInput {
  item_id?: string | null;
  kind: LineKind;
  category?: Category;
  name: string;
  /** Line text on the document. Defaults to the name. */
  description?: string;
  quantity?: number;
  unit_price?: number;
  unit?: string;
  tax_id?: string | null;
  billing: Billing;
  interval_unit?: IntervalUnit | null;
  interval_count?: number;
  /** Recurring lines: billed once, on the first document. */
  setup_fee?: number;
  /** Recurring lines: months before the first paid period starts. */
  free_months?: number;
  /** Recurring lines: what the charge is for, e.g. a domain name. */
  reference?: string | null;
  /** Came with a package rather than being picked separately. */
  included?: boolean;
}

export interface OrderLine {
  item_id: string | null;
  product_id: string | null;
  kind: LineKind;
  category: Category;
  name: string;
  description: string;
  quantity: number;
  unit_price: number;
  unit: string;
  tax_id: string | null;
  billing: Billing;
  interval_unit: IntervalUnit | null;
  interval_count: number;
  setup_fee: number;
  free_months: number;
  reference: string | null;
  included: boolean;
}

const newId = () => crypto.randomBytes(16).toString("hex");
const fail = (error: string, status: 400 | 404 = 400) => ({ ok: false as const, error, status });

function existingIds(table: "agency_items" | "tax_definitions", ids: string[]) {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map<string, string | null>();
  const column = table === "agency_items" ? "product_id" : "NULL";
  const rows = getDb()
    .query(
      `SELECT id, ${column} AS product_id FROM ${table} WHERE id IN (${unique.map(() => "?").join(", ")})`,
    )
    .all(...unique) as { id: string; product_id: string | null }[];
  return new Map(rows.map((r) => [r.id, r.product_id]));
}

/** Resolve defaults and drop references that no longer exist (an item or tax
 *  rate deleted while the builder was open), so nothing trips a foreign key. */
export function normalizeLines(input: OrderLineInput[]): OrderLine[] {
  const items = existingIds(
    "agency_items",
    input.map((l) => l.item_id).filter((id): id is string => !!id),
  );
  const taxes = existingIds(
    "tax_definitions",
    input.map((l) => l.tax_id).filter((id): id is string => !!id),
  );
  return input.map((l) => {
    const recurring = l.billing === "recurring";
    const intervalUnit: IntervalUnit | null = recurring ? (l.interval_unit ?? "month") : null;
    const intervalCount = recurring ? Math.max(1, Math.floor(l.interval_count ?? 1)) : 1;
    const itemId = l.item_id && items.has(l.item_id) ? l.item_id : null;
    const name = l.name.trim();
    return {
      item_id: itemId,
      product_id: itemId ? (items.get(itemId) ?? null) : null,
      kind: l.kind,
      category: l.category ?? "other",
      name,
      description: l.description?.trim() || name,
      quantity: l.quantity ?? 1,
      unit_price: l.unit_price ?? 0,
      unit: recurring
        ? recurringUnit(intervalUnit as IntervalUnit, intervalCount)
        : l.unit?.trim() || "piece",
      tax_id: l.tax_id && taxes.has(l.tax_id) ? l.tax_id : null,
      billing: l.billing,
      interval_unit: intervalUnit,
      interval_count: intervalCount,
      setup_fee: recurring ? Math.max(0, l.setup_fee ?? 0) : 0,
      free_months: recurring ? Math.max(0, Math.floor(l.free_months ?? 0)) : 0,
      reference: recurring ? l.reference?.trim() || null : null,
      included: l.included === true,
    };
  });
}

// --- Document text -------------------------------------------------------------
// Documents go to clients, so this is the document's language (English, like
// the rest of the text the core generates on documents), not the UI's.

/** "month", "3 months", "year", "2 years". */
export function spanText(months: number): string {
  if (months % 12 === 0) {
    const years = months / 12;
    return years === 1 ? "year" : `${years} years`;
  }
  return months === 1 ? "month" : `${months} months`;
}

function perText(unit: IntervalUnit, count: number): string {
  if (count === 1) return unit === "month" ? "per month" : "per year";
  return `every ${count} ${unit}s`;
}

function billedText(unit: IntervalUnit, count: number): string {
  if (count === 1) return unit === "month" ? "billed monthly" : "billed yearly";
  return `billed every ${count} ${unit}s`;
}

export interface DocumentItem {
  product_id: string | null;
  description: string;
  quantity: number;
  unit_price: number;
  unit: string;
  tax_id: string | null;
  sort_order: number;
}

export interface BuiltDocument {
  items: DocumentItem[];
  /** One paragraph listing every recurring charge, for the document notes. */
  recurring_summary: string | null;
}

export interface DocumentOptions {
  mode: "quote" | "invoice";
  /** Service start; an invoice prints the first period's dates from it. */
  startDate: string;
  money: (amount: number) => string;
  date: (iso: string) => string;
}

export function buildDocument(lines: OrderLine[], opts: DocumentOptions): BuiltDocument {
  const items: DocumentItem[] = [];
  const includes = new Map<number, string[]>();
  const recurring: string[] = [];
  let packageIndex: number | null = null;

  const push = (item: Omit<DocumentItem, "sort_order">) => {
    items.push({ ...item, sort_order: items.length });
    return items.length - 1;
  };

  for (const line of lines) {
    const isRecurring = line.billing === "recurring";
    const unit = line.interval_unit as IntervalUnit;
    const free = isRecurring && line.free_months > 0;
    const label = line.reference ? `${line.name} (${line.reference})` : line.name;
    const base = {
      product_id: line.product_id,
      quantity: line.quantity,
      unit_price: line.unit_price,
      unit: line.unit,
      tax_id: line.tax_id,
    };

    if (isRecurring) {
      const amount = opts.money(round2(line.unit_price * line.quantity));
      const intro = free ? `free for the first ${spanText(line.free_months)}, then ` : "";
      recurring.push(`${label}: ${intro}${amount} ${perText(unit, line.interval_count)}`);
    }

    if (line.setup_fee > 0) {
      push({
        ...base,
        product_id: null,
        description: `Setup: ${line.name}`,
        quantity: 1,
        unit_price: line.setup_fee,
        unit: "piece",
      });
    }

    // Nothing to bill now: a recurring line in its free period, or an
    // included one-time add-on.
    if (free || (line.included && !isRecurring)) {
      if (line.included && packageIndex !== null) {
        const listed = free ? `${label} (first ${spanText(line.free_months)} free)` : label;
        includes.set(packageIndex, [...(includes.get(packageIndex) ?? []), listed]);
      } else if (line.included) {
        // No package line to list it on, so it gets a line of its own.
        push({ ...base, description: `${line.description} (included)`, unit_price: 0 });
      }
      continue;
    }

    let description = line.description;
    if (isRecurring) {
      const ref = line.reference ? ` – ${line.reference}` : "";
      const anchor = dayOfMonth(opts.startDate);
      const when =
        opts.mode === "invoice"
          ? `${opts.date(opts.startDate)} – ${opts.date(periodEnd(opts.startDate, unit, line.interval_count, anchor))}`
          : billedText(unit, line.interval_count);
      description = `${line.description}${ref} (${when})`;
    }
    const index = push({ ...base, description });
    if (line.kind === "package") packageIndex = index;
  }

  for (const [index, listed] of includes) {
    const text = items[index].description.replace(/[.\s]+$/, "");
    items[index].description = `${text}. Includes: ${listed.join(", ")}`;
  }

  return {
    items,
    recurring_summary: recurring.length > 0 ? `Recurring charges: ${recurring.join("; ")}.` : null,
  };
}

export function orderTotals(lines: OrderLine[], doc: BuiltDocument) {
  return {
    initial_total: round2(doc.items.reduce((sum, i) => sum + i.quantity * i.unit_price, 0)),
    monthly_recurring: round2(
      lines
        .filter((l) => l.billing === "recurring")
        .reduce(
          (sum, l) =>
            sum +
            monthlyValue(
              l.unit_price * l.quantity,
              l.interval_unit as IntervalUnit,
              l.interval_count,
            ),
          0,
        ),
    ),
  };
}

function joinNotes(notes: string | null | undefined, summary: string | null): string | null {
  const parts = [notes?.trim(), summary].filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join("\n\n") : null;
}

/** Due date from the workspace's default payment terms ("Net 30"). */
function defaultTerms(today: string): { payment_terms: string | null; due_date: string | null } {
  const terms = getAllSettings().default_payment_terms?.trim() || "";
  if (!terms) return { payment_terms: null, due_date: null };
  if (/^due on receipt$/i.test(terms)) return { payment_terms: terms, due_date: today };
  const net = terms.match(/^net\s+(\d+)$/i);
  return { payment_terms: terms, due_date: net ? addDays(today, Number(net[1])) : null };
}

function defaultTitle(lines: OrderLine[]): string {
  const packages = lines.filter((l) => l.kind === "package").map((l) => l.name);
  const title = packages.length > 0 ? packages.join(" + ") : lines[0].name;
  return title.slice(0, 200);
}

/** Start a subscription for every recurring line. A line whose first period
 *  is on `invoiceId` renews one interval after the start; a line with free
 *  months starts billing when they end; with no invoice, billing starts on
 *  the start date. */
function startSubscriptions(
  orderId: string,
  customerId: string,
  currency: string,
  lines: OrderLine[],
  startDate: string,
  invoiceId: string | null,
): void {
  const anchor = dayOfMonth(startDate);
  for (const line of lines) {
    if (line.billing !== "recurring") continue;
    const unit = line.interval_unit as IntervalUnit;
    const billedNow = invoiceId !== null && line.free_months === 0;
    const next = billedNow
      ? addInterval(startDate, unit, line.interval_count, anchor)
      : addMonths(startDate, line.free_months, anchor);
    const subId = insertSubscription({
      customer_id: customerId,
      item_id: line.item_id,
      order_id: orderId,
      name: line.name,
      reference: line.reference,
      category: line.category,
      price: line.unit_price,
      quantity: line.quantity,
      currency,
      tax_id: line.tax_id,
      interval_unit: unit,
      interval_count: line.interval_count,
      start_date: startDate,
      next_billing_date: next,
      anchor_day: anchor,
    });
    if (billedNow && invoiceId) {
      logInitialPeriod(
        subId,
        invoiceId,
        { start: startDate, end: periodEnd(startDate, unit, line.interval_count, anchor) },
        line.unit_price * line.quantity,
      );
    }
  }
}

// --- Reads -------------------------------------------------------------------

interface OrderRow {
  id: string;
  customer_id: string;
  status: OrderStatus;
  title: string;
  currency: string;
  lines: string;
  initial_total: number;
  monthly_recurring: number;
  notes: string | null;
  quote_id: string | null;
  invoice_id: string | null;
  start_date: string | null;
  activated_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrderView extends Omit<OrderRow, "lines"> {
  lines: OrderLine[];
  customer_name: string;
  quote_number: string | null;
  quote_status: string | null;
  invoice_number: string | null;
  invoice_status: string | null;
  subscription_count: number;
}

const ORDER_SELECT = `SELECT o.*, c.name AS customer_name,
    q.quote_number, CASE WHEN q.deleted_at IS NOT NULL THEN 'deleted' ELSE q.status END AS quote_status,
    i.invoice_number, CASE WHEN i.deleted_at IS NOT NULL THEN 'deleted' ELSE i.status END AS invoice_status,
    (SELECT COUNT(*) FROM agency_subscriptions s WHERE s.order_id = o.id) AS subscription_count
  FROM agency_orders o
  JOIN customers c ON c.id = o.customer_id
  LEFT JOIN quotes q ON q.id = o.quote_id
  LEFT JOIN invoices i ON i.id = o.invoice_id`;

function parseLines(raw: string): OrderLine[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as OrderLine[]) : [];
  } catch {
    return [];
  }
}

function toView(row: OrderRow & Omit<OrderView, keyof OrderRow>): OrderView {
  return { ...row, lines: parseLines(row.lines) };
}

export function listOrders(filters: { status?: OrderStatus; customer_id?: string } = {}) {
  const conditions: string[] = [];
  const params: string[] = [];
  if (filters.status) {
    conditions.push("o.status = ?");
    params.push(filters.status);
  }
  if (filters.customer_id) {
    conditions.push("o.customer_id = ?");
    params.push(filters.customer_id);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = getDb()
    .query(`${ORDER_SELECT} ${where} ORDER BY o.created_at DESC, o.rowid DESC`)
    .all(...params) as Parameters<typeof toView>[0][];
  return rows.map(toView);
}

export function getOrder(id: string): OrderView | null {
  const row = getDb().query(`${ORDER_SELECT} WHERE o.id = ?`).get(id) as
    | Parameters<typeof toView>[0]
    | null;
  return row ? toView(row) : null;
}

function getOrderRow(id: string): OrderRow | null {
  return getDb().query("SELECT * FROM agency_orders WHERE id = ?").get(id) as OrderRow | null;
}

// --- Writes ------------------------------------------------------------------

export interface CreateOrderInput {
  customer_id: string;
  currency?: string;
  lines: OrderLineInput[];
  notes?: string | null;
  mode: "quote" | "invoice";
  /** Invoice mode: when the services start. Defaults to today. */
  start_date?: string;
  /** Invoice mode: base-currency units per unit of a foreign currency. */
  exchange_rate?: number;
  /** Quote mode: the quote's validity. */
  valid_until?: string | null;
  title?: string;
}

export function createOrder(
  input: CreateOrderInput,
  userId: string | null,
  today = todayIso(),
): Result<OrderView> {
  const db = getDb();
  const customer = db
    .query("SELECT id, currency FROM customers WHERE id = ?")
    .get(input.customer_id) as {
    id: string;
    currency: string | null;
  } | null;
  if (!customer) return fail("Customer not found");
  if (input.lines.length === 0) return fail("Add at least one line");

  const lines = normalizeLines(input.lines);
  if (lines.some((l) => l.name === "")) return fail("Every line needs a name");

  const currency = (input.currency || customer.currency || getBaseCurrency()).toUpperCase();
  const startDate = input.start_date ?? today;
  const doc = buildDocument(lines, {
    mode: input.mode,
    startDate,
    ...documentFormatters(customer.id, currency),
  });
  const totals = orderTotals(lines, doc);
  const notes = joinNotes(input.notes, doc.recurring_summary);
  const id = newId();

  db.transaction(() => {
    db.run(
      `INSERT INTO agency_orders (id, customer_id, status, title, currency, lines, initial_total,
         monthly_recurring, notes, created_by)
       VALUES (?, ?, 'quoted', ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        customer.id,
        input.title?.trim() || defaultTitle(lines),
        currency,
        JSON.stringify(lines),
        totals.initial_total,
        totals.monthly_recurring,
        input.notes?.trim() || null,
        userId,
      ],
    );

    if (input.mode === "quote") {
      const quote = createQuote({
        customer_id: customer.id,
        issue_date: today,
        valid_until: input.valid_until || null,
        notes,
        currency,
        items: doc.items,
      });
      db.run("UPDATE agency_orders SET quote_id = ? WHERE id = ?", [quote.id, id]);
      return;
    }

    let invoiceId: string | null = null;
    if (doc.items.length > 0) {
      const terms = defaultTerms(today);
      invoiceId = createInvoice({
        customer_id: customer.id,
        issue_date: today,
        due_date: terms.due_date,
        payment_terms: terms.payment_terms,
        notes,
        currency,
        exchange_rate: input.exchange_rate,
        items: doc.items,
      }).id;
    }
    startSubscriptions(id, customer.id, currency, lines, startDate, invoiceId);
    db.run(
      `UPDATE agency_orders SET status = 'active', invoice_id = ?, start_date = ?,
         activated_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`,
      [invoiceId, startDate, id],
    );
  })();

  return { ok: true, data: getOrder(id)! };
}

/** Activate a quoted order once the client accepts: turn the quote into an
 *  invoice (or link the one it was already converted into, instalments
 *  included) and start the subscriptions. With `create_invoice: false`
 *  nothing is invoiced and every subscription bills from the start date. */
export function activateOrder(
  id: string,
  opts: { start_date?: string; create_invoice?: boolean } = {},
  today = todayIso(),
): Result<OrderView> {
  const order = getOrderRow(id);
  if (!order) return fail("Order not found", 404);
  if (order.status !== "quoted") return fail("Only a quoted order can be activated");

  const startDate = opts.start_date ?? today;
  const db = getDb();
  const error = db.transaction((): string | null => {
    let invoiceId: string | null = null;
    if (opts.create_invoice !== false) {
      const quote = order.quote_id ? getQuote(order.quote_id) : null;
      if (!quote || quote.deleted_at) return "The quotation for this order was deleted";
      if (quote.status === "converted" && quote.converted_invoice_id) {
        invoiceId = quote.converted_invoice_id;
      } else {
        const converted = convertToInvoice(quote.id);
        if (!converted.success) return converted.error;
        invoiceId = converted.data.invoice_id;
      }
    }
    const lines = parseLines(order.lines);
    startSubscriptions(order.id, order.customer_id, order.currency, lines, startDate, invoiceId);
    db.run(
      `UPDATE agency_orders SET status = 'active', invoice_id = ?, start_date = ?,
         activated_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`,
      [invoiceId, startDate, id],
    );
    return null;
  })();

  if (error) return fail(error);
  return { ok: true, data: getOrder(id)! };
}

/** Cancel an order. An active order's running subscriptions are cancelled
 *  with it; its quote and invoice are left as they are. */
export function cancelOrder(id: string): Result<OrderView> {
  const order = getOrderRow(id);
  if (!order) return fail("Order not found", 404);
  if (order.status === "cancelled") return fail("This order is already cancelled");
  const db = getDb();
  db.transaction(() => {
    if (order.status === "active") cancelOrderSubscriptions(id);
    db.run(
      "UPDATE agency_orders SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?",
      [id],
    );
  })();
  return { ok: true, data: getOrder(id)! };
}

/** Delete a quoted or cancelled order. Its documents and any subscriptions
 *  stay; they only lose the link back. */
export function deleteOrder(id: string): Result<{ id: string }> {
  const order = getOrderRow(id);
  if (!order) return fail("Order not found", 404);
  if (order.status === "active") return fail("Cancel an active order before deleting it");
  getDb().run("DELETE FROM agency_orders WHERE id = ?", [id]);
  return { ok: true, data: { id } };
}

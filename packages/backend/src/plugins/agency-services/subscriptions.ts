// Client subscriptions: recurring charges such as domains, hosting, social
// media retainers and maintenance contracts, and the renewal billing engine.
//
// A subscription bills in advance, one period at a time. next_billing_date is
// the first day of the next unbilled period (the renewal date); the period is
// invoiced lead_days before it. Renewals of one client that fall due in the
// same run share an invoice. Every billed period is logged with a UNIQUE
// (subscription, period_start), so no period can be invoiced twice.

import crypto from "node:crypto";
import { getDb } from "../../database/connection";
import { getBaseCurrency } from "../../services/exchange-rate.service";
import { createInvoice, finaliseForSending } from "../../services/invoice.service";
import { sendInvoiceEmail } from "../../services/invoice-send.service";
import { getAllSettings } from "../../services/settings.service";
import { formatCurrency } from "../../utils/currency";
import { formatDateStr, todayIso } from "../../utils/date";
import { logger } from "../../utils/logger";
import { type Category, recurringUnit } from "./catalog";
import { getConfig } from "./config";
import {
  addDays,
  addInterval,
  dayOfMonth,
  type IntervalUnit,
  monthlyValue,
  round2,
} from "./periods";

export const SUBSCRIPTION_STATUSES = ["active", "paused", "cancelled", "ended"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** A run never bills more than this many periods of one subscription, so a
 *  renewal date mistyped years into the past cannot flood a client. */
export const MAX_PERIODS_PER_RUN = 24;

export interface SubscriptionRow {
  id: string;
  customer_id: string;
  item_id: string | null;
  order_id: string | null;
  name: string;
  reference: string | null;
  category: Category;
  price: number;
  quantity: number;
  currency: string;
  tax_id: string | null;
  interval_unit: IntervalUnit;
  interval_count: number;
  start_date: string;
  next_billing_date: string;
  anchor_day: number;
  end_date: string | null;
  status: SubscriptionStatus;
  notes: string | null;
  last_invoice_id: string | null;
  last_billed_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SubscriptionView extends SubscriptionRow {
  customer_name: string;
  last_invoice_number: string | null;
  last_invoice_status: string | null;
  /** Price × quantity for one period. */
  period_amount: number;
  /** period_amount expressed per month. */
  monthly_value: number;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: string; status: 400 | 404 };

const newId = () => crypto.randomBytes(16).toString("hex");
const fail = (error: string, status: 400 | 404 = 400) => ({ ok: false as const, error, status });

// --- Reads -------------------------------------------------------------------

export interface SubscriptionFilters {
  status?: SubscriptionStatus;
  customer_id?: string;
  category?: string;
  search?: string;
  /** Active subscriptions renewing within this many days (overdue included). */
  due_within_days?: number;
}

export function listSubscriptions(
  filters: SubscriptionFilters = {},
  today = todayIso(),
): SubscriptionView[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (filters.status) {
    conditions.push("s.status = ?");
    params.push(filters.status);
  }
  if (filters.customer_id) {
    conditions.push("s.customer_id = ?");
    params.push(filters.customer_id);
  }
  if (filters.category) {
    conditions.push("s.category = ?");
    params.push(filters.category);
  }
  if (filters.search) {
    conditions.push("(s.name LIKE ? OR s.reference LIKE ? OR c.name LIKE ?)");
    const q = `%${filters.search}%`;
    params.push(q, q, q);
  }
  if (filters.due_within_days !== undefined) {
    conditions.push("s.status = 'active' AND s.next_billing_date <= ?");
    params.push(addDays(today, filters.due_within_days));
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = getDb()
    .query(
      `SELECT s.*, c.name AS customer_name,
              i.invoice_number AS last_invoice_number, i.status AS last_invoice_status
       FROM agency_subscriptions s
       JOIN customers c ON c.id = s.customer_id
       LEFT JOIN invoices i ON i.id = s.last_invoice_id AND i.deleted_at IS NULL
       ${where}
       ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
                s.next_billing_date, c.name COLLATE NOCASE`,
    )
    .all(...params) as (SubscriptionRow & {
    customer_name: string;
    last_invoice_number: string | null;
    last_invoice_status: string | null;
  })[];
  return rows.map(toView);
}

function toView(
  row: SubscriptionRow & {
    customer_name: string;
    last_invoice_number: string | null;
    last_invoice_status: string | null;
  },
): SubscriptionView {
  const periodAmount = round2(row.price * row.quantity);
  return {
    ...row,
    period_amount: periodAmount,
    monthly_value: round2(monthlyValue(periodAmount, row.interval_unit, row.interval_count)),
  };
}

function getRow(id: string): SubscriptionRow | null {
  return getDb()
    .query("SELECT * FROM agency_subscriptions WHERE id = ?")
    .get(id) as SubscriptionRow | null;
}

export function getSubscription(id: string): SubscriptionView | null {
  const row = getDb()
    .query(
      `SELECT s.*, c.name AS customer_name,
              i.invoice_number AS last_invoice_number, i.status AS last_invoice_status
       FROM agency_subscriptions s
       JOIN customers c ON c.id = s.customer_id
       LEFT JOIN invoices i ON i.id = s.last_invoice_id AND i.deleted_at IS NULL
       WHERE s.id = ?`,
    )
    .get(id) as Parameters<typeof toView>[0] | null;
  return row ? toView(row) : null;
}

export function getHistory(id: string) {
  return getDb()
    .query(
      `SELECT l.*, i.invoice_number, i.status AS invoice_status, i.deleted_at AS invoice_deleted_at
       FROM agency_billing_log l
       LEFT JOIN invoices i ON i.id = l.invoice_id
       WHERE l.subscription_id = ?
       ORDER BY l.period_start DESC`,
    )
    .all(id);
}

export interface CurrencyTotal {
  currency: string;
  amount: number;
}

export interface SubscriptionSummary {
  base_currency: string;
  lead_days: number;
  auto_send: boolean;
  counts: Record<SubscriptionStatus, number>;
  /** Active subscriptions' recurring revenue, per currency. */
  recurring: { currency: string; monthly: number; yearly: number; count: number }[];
  /** Active renewals in the next 30 days (or already due). */
  upcoming: { count: number; totals: CurrencyTotal[] };
  /** Active renewals inside the invoicing window right now. */
  ready_to_invoice: number;
}

export function getSummary(today = todayIso()): SubscriptionSummary {
  const cfg = getConfig();
  const rows = getDb()
    .query(
      "SELECT status, currency, price, quantity, interval_unit, interval_count, next_billing_date FROM agency_subscriptions",
    )
    .all() as Pick<
    SubscriptionRow,
    | "status"
    | "currency"
    | "price"
    | "quantity"
    | "interval_unit"
    | "interval_count"
    | "next_billing_date"
  >[];

  const counts: Record<SubscriptionStatus, number> = {
    active: 0,
    paused: 0,
    cancelled: 0,
    ended: 0,
  };
  const recurring = new Map<string, { monthly: number; count: number }>();
  const upcoming = new Map<string, number>();
  let upcomingCount = 0;
  let ready = 0;
  const in30 = addDays(today, 30);
  const horizon = addDays(today, cfg.lead_days);

  for (const r of rows) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    if (r.status !== "active") continue;
    const amount = r.price * r.quantity;
    const rec = recurring.get(r.currency) ?? { monthly: 0, count: 0 };
    rec.monthly += monthlyValue(amount, r.interval_unit, r.interval_count);
    rec.count += 1;
    recurring.set(r.currency, rec);
    if (r.next_billing_date <= in30) {
      upcomingCount += 1;
      upcoming.set(r.currency, (upcoming.get(r.currency) ?? 0) + amount);
    }
    if (r.next_billing_date <= horizon) ready += 1;
  }

  return {
    base_currency: getBaseCurrency(),
    lead_days: cfg.lead_days,
    auto_send: cfg.auto_send,
    counts,
    recurring: [...recurring.entries()].map(([currency, v]) => ({
      currency,
      monthly: round2(v.monthly),
      yearly: round2(v.monthly * 12),
      count: v.count,
    })),
    upcoming: {
      count: upcomingCount,
      totals: [...upcoming.entries()].map(([currency, amount]) => ({
        currency,
        amount: round2(amount),
      })),
    },
    ready_to_invoice: ready,
  };
}

// --- Writes ------------------------------------------------------------------

export interface SubscriptionInput {
  customer_id: string;
  item_id?: string | null;
  order_id?: string | null;
  name: string;
  reference?: string | null;
  category?: Category;
  price: number;
  quantity?: number;
  currency?: string;
  tax_id?: string | null;
  interval_unit: IntervalUnit;
  interval_count?: number;
  start_date?: string;
  next_billing_date: string;
  /** Day of month renewals fall on; defaults to next_billing_date's day. */
  anchor_day?: number;
  end_date?: string | null;
  notes?: string | null;
}

export type SubscriptionUpdate = Partial<
  Omit<SubscriptionInput, "customer_id" | "order_id" | "anchor_day">
>;

function customerCurrency(customerId: string): { exists: boolean; currency: string | null } {
  const row = getDb().query("SELECT currency FROM customers WHERE id = ?").get(customerId) as {
    currency: string | null;
  } | null;
  return { exists: row !== null, currency: row?.currency || null };
}

function checkDates(start: string, next: string, end: string | null): string | null {
  if (next < start) return "The next renewal date cannot be before the start date";
  if (end && end < start) return "The end date cannot be before the start date";
  return null;
}

/** Insert a subscription row. Callers validate; this never throws on input. */
export function insertSubscription(input: SubscriptionInput): string {
  const id = newId();
  const start = input.start_date ?? input.next_billing_date;
  getDb().run(
    `INSERT INTO agency_subscriptions (id, customer_id, item_id, order_id, name, reference, category,
       price, quantity, currency, tax_id, interval_unit, interval_count, start_date,
       next_billing_date, anchor_day, end_date, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.customer_id,
      input.item_id ?? null,
      input.order_id ?? null,
      input.name.trim(),
      input.reference?.trim() || null,
      input.category ?? "other",
      input.price,
      input.quantity ?? 1,
      (input.currency || getBaseCurrency()).toUpperCase(),
      input.tax_id || null,
      input.interval_unit,
      Math.max(1, Math.floor(input.interval_count ?? 1)),
      start,
      input.next_billing_date,
      input.anchor_day ?? dayOfMonth(input.next_billing_date),
      input.end_date || null,
      input.notes?.trim() || null,
    ],
  );
  return id;
}

/** Whether a tax definition exists, for validating ids before they reach a
 *  foreign key. */
export function taxExists(taxId: string | null | undefined): boolean {
  if (!taxId) return true;
  return getDb().query("SELECT 1 FROM tax_definitions WHERE id = ?").get(taxId) !== null;
}

export function createSubscription(input: SubscriptionInput): Result<SubscriptionView> {
  const customer = customerCurrency(input.customer_id);
  if (!customer.exists) return fail("Customer not found");
  if (input.item_id) {
    const item = getDb().query("SELECT id FROM agency_items WHERE id = ?").get(input.item_id);
    if (!item) return fail("Catalog item not found");
  }
  if (!taxExists(input.tax_id)) return fail("Tax rate not found");
  const start = input.start_date ?? input.next_billing_date;
  const invalid = checkDates(start, input.next_billing_date, input.end_date ?? null);
  if (invalid) return fail(invalid);
  const id = insertSubscription({
    ...input,
    currency: input.currency || customer.currency || getBaseCurrency(),
  });
  return { ok: true, data: getSubscription(id)! };
}

export function updateSubscription(
  id: string,
  input: SubscriptionUpdate,
): Result<SubscriptionView> {
  const existing = getRow(id);
  if (!existing) return fail("Subscription not found", 404);
  if (input.item_id) {
    const item = getDb().query("SELECT id FROM agency_items WHERE id = ?").get(input.item_id);
    if (!item) return fail("Catalog item not found");
  }
  if (!taxExists(input.tax_id)) return fail("Tax rate not found");

  const next = input.next_billing_date ?? existing.next_billing_date;
  const start = input.start_date ?? existing.start_date;
  const end = input.end_date !== undefined ? input.end_date || null : existing.end_date;
  const invalid = checkDates(start, next, end);
  if (invalid) return fail(invalid);

  // Moving the renewal date re-anchors it; extending an ended contract revives it.
  const anchor = input.next_billing_date !== undefined ? dayOfMonth(next) : existing.anchor_day;
  let status = existing.status;
  if (status === "ended" && (end === null || next <= end)) status = "active";
  if (status === "active" && end !== null && next > end) status = "ended";

  getDb().run(
    `UPDATE agency_subscriptions SET item_id = ?, name = ?, reference = ?, category = ?, price = ?,
       quantity = ?, currency = ?, tax_id = ?, interval_unit = ?, interval_count = ?,
       start_date = ?, next_billing_date = ?, anchor_day = ?, end_date = ?, notes = ?,
       status = ?, updated_at = datetime('now')
     WHERE id = ?`,
    [
      input.item_id !== undefined ? input.item_id || null : existing.item_id,
      input.name?.trim() || existing.name,
      input.reference !== undefined ? input.reference?.trim() || null : existing.reference,
      input.category ?? existing.category,
      input.price ?? existing.price,
      input.quantity ?? existing.quantity,
      (input.currency || existing.currency).toUpperCase(),
      input.tax_id !== undefined ? input.tax_id || null : existing.tax_id,
      input.interval_unit ?? existing.interval_unit,
      input.interval_count !== undefined
        ? Math.max(1, Math.floor(input.interval_count))
        : existing.interval_count,
      start,
      next,
      anchor,
      end,
      input.notes !== undefined ? input.notes?.trim() || null : existing.notes,
      status,
      id,
    ],
  );
  return { ok: true, data: getSubscription(id)! };
}

export function pauseSubscription(id: string): Result<SubscriptionView> {
  const sub = getRow(id);
  if (!sub) return fail("Subscription not found", 404);
  if (sub.status !== "active") return fail("Only an active subscription can be paused");
  getDb().run(
    "UPDATE agency_subscriptions SET status = 'paused', updated_at = datetime('now') WHERE id = ?",
    [id],
  );
  return { ok: true, data: getSubscription(id)! };
}

/** Resume a paused subscription. Renewals that fell inside the pause are
 *  skipped, not billed: the next renewal moves to the first period starting
 *  today or later, on the same anchor day. */
export function resumeSubscription(id: string, today = todayIso()): Result<SubscriptionView> {
  const sub = getRow(id);
  if (!sub) return fail("Subscription not found", 404);
  if (sub.status !== "paused") return fail("Only a paused subscription can be resumed");

  let next = sub.next_billing_date;
  for (let i = 0; next < today && i < 1200; i++) {
    next = addInterval(next, sub.interval_unit, sub.interval_count, sub.anchor_day);
  }
  const status = sub.end_date && next > sub.end_date ? "ended" : "active";
  getDb().run(
    "UPDATE agency_subscriptions SET status = ?, next_billing_date = ?, updated_at = datetime('now') WHERE id = ?",
    [status, next, id],
  );
  return { ok: true, data: getSubscription(id)! };
}

export function cancelSubscription(id: string): Result<SubscriptionView> {
  const sub = getRow(id);
  if (!sub) return fail("Subscription not found", 404);
  if (sub.status !== "active" && sub.status !== "paused") {
    return fail("This subscription is not running");
  }
  getDb().run(
    "UPDATE agency_subscriptions SET status = 'cancelled', cancelled_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
    [id],
  );
  return { ok: true, data: getSubscription(id)! };
}

/** Delete a subscription that never billed. One with billing history is
 *  cancelled instead, so the record behind its invoices survives. */
export function deleteSubscription(id: string): Result<{ deleted: boolean }> {
  const sub = getRow(id);
  if (!sub) return fail("Subscription not found", 404);
  const billed = getDb()
    .query("SELECT COUNT(*) AS n FROM agency_billing_log WHERE subscription_id = ?")
    .get(id) as { n: number };
  if (billed.n > 0) {
    if (sub.status === "active" || sub.status === "paused") cancelSubscription(id);
    return { ok: true, data: { deleted: false } };
  }
  getDb().run("DELETE FROM agency_subscriptions WHERE id = ?", [id]);
  return { ok: true, data: { deleted: true } };
}

// --- Billing -----------------------------------------------------------------

interface BillableRow extends SubscriptionRow {
  product_id: string | null;
}

interface DuePeriod {
  start: string;
  end: string;
}

interface BillingEntry {
  sub: BillableRow;
  periods: DuePeriod[];
  /** next_billing_date after these periods. */
  next: string;
  /** No period starts on or before end_date any more. */
  ended: boolean;
}

/** The periods of `sub` starting on or before `horizon` (at least one when
 *  `force`), and where the renewal date moves to after them. */
function duePeriods(sub: BillableRow, horizon: string, force = false): BillingEntry {
  const periods: DuePeriod[] = [];
  let start = sub.next_billing_date;
  while (
    (start <= horizon || (force && periods.length === 0)) &&
    periods.length < MAX_PERIODS_PER_RUN
  ) {
    if (sub.end_date && start > sub.end_date) break;
    const next = addInterval(start, sub.interval_unit, sub.interval_count, sub.anchor_day);
    periods.push({ start, end: addDays(next, -1) });
    start = next;
  }
  return { sub, periods, next: start, ended: sub.end_date !== null && start > sub.end_date };
}

/** Money and date formatting for a document, in the customer's locale. */
export function documentFormatters(customerId: string, currency: string) {
  const settings = getAllSettings();
  const customer = getDb().query("SELECT language FROM customers WHERE id = ?").get(customerId) as {
    language: string | null;
  } | null;
  const locale = customer?.language || undefined;
  return {
    money: (n: number) => formatCurrency(n, currency, settings.number_format || undefined, locale),
    date: (iso: string) => formatDateStr(iso, settings.date_format || undefined, locale),
  };
}

export function renewalDescription(
  sub: Pick<SubscriptionRow, "name" | "reference">,
  period: DuePeriod,
  date: (iso: string) => string,
): string {
  const label = sub.reference ? `${sub.name} – ${sub.reference}` : sub.name;
  return `${label} (${date(period.start)} – ${date(period.end)})`;
}

/** True when this period is already on an invoice that still counts. A log
 *  row whose invoice was deleted or voided is stale and is cleared, so the
 *  period can be billed again. */
function alreadyBilled(subscriptionId: string, periodStart: string): boolean {
  const db = getDb();
  const row = db
    .query(
      `SELECT l.id, l.invoice_id, i.status, i.deleted_at
       FROM agency_billing_log l LEFT JOIN invoices i ON i.id = l.invoice_id
       WHERE l.subscription_id = ? AND l.period_start = ?`,
    )
    .get(subscriptionId, periodStart) as {
    id: string;
    invoice_id: string | null;
    status: string | null;
    deleted_at: string | null;
  } | null;
  if (!row) return false;
  const live = row.invoice_id !== null && row.status !== null && !row.deleted_at;
  if (live && row.status !== "voided") return true;
  db.run("DELETE FROM agency_billing_log WHERE id = ?", [row.id]);
  return false;
}

/** Invoice the given periods of one client's subscriptions on one invoice and
 *  move each renewal date on. Returns the new invoice id, or null when every
 *  period turned out to be billed already. Atomic. */
function billEntries(
  customerId: string,
  currency: string,
  entries: BillingEntry[],
  source: "schedule" | "manual",
  today: string,
): string | null {
  const db = getDb();
  const { date } = documentFormatters(customerId, currency);

  return db.transaction(() => {
    const items: Parameters<typeof createInvoice>[0]["items"] = [];
    const logs: { subId: string; period: DuePeriod; amount: number }[] = [];
    for (const entry of entries) {
      for (const period of entry.periods) {
        if (alreadyBilled(entry.sub.id, period.start)) continue;
        items.push({
          product_id: entry.sub.product_id,
          description: renewalDescription(entry.sub, period, date),
          quantity: entry.sub.quantity,
          unit_price: entry.sub.price,
          unit: recurringUnit(entry.sub.interval_unit, entry.sub.interval_count),
          tax_id: entry.sub.tax_id,
          sort_order: items.length,
        });
        logs.push({
          subId: entry.sub.id,
          period,
          amount: round2(entry.sub.price * entry.sub.quantity),
        });
      }
    }

    let invoiceId: string | null = null;
    if (items.length > 0) {
      const starts = logs.map((l) => l.period.start).sort();
      const ends = logs.map((l) => l.period.end).sort();
      // Due on the renewal date, so the client pays before the service lapses.
      const dueDate = starts[0] > today ? starts[0] : today;
      invoiceId = createInvoice({
        customer_id: customerId,
        issue_date: today,
        due_date: dueDate,
        service_period_start: starts[0],
        service_period_end: ends[ends.length - 1],
        currency,
        items,
      }).id;
      const insert = db.prepare(
        `INSERT INTO agency_billing_log (id, subscription_id, invoice_id, period_start, period_end, amount, source)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const l of logs) {
        insert.run(newId(), l.subId, invoiceId, l.period.start, l.period.end, l.amount, source);
      }
    }

    const billed = new Set(logs.map((l) => l.subId));
    for (const entry of entries) {
      const lastInvoice = billed.has(entry.sub.id) ? invoiceId : null;
      db.run(
        `UPDATE agency_subscriptions SET next_billing_date = ?, status = ?,
           last_invoice_id = COALESCE(?, last_invoice_id),
           last_billed_at = CASE WHEN ? IS NULL THEN last_billed_at ELSE datetime('now') END,
           updated_at = datetime('now')
         WHERE id = ?`,
        [
          entry.next,
          entry.ended ? "ended" : entry.sub.status,
          lastInvoice,
          lastInvoice,
          entry.sub.id,
        ],
      );
    }
    return invoiceId;
  })();
}

/** Issue and email a renewal invoice when auto-send is on. Delivery failures
 *  are logged and never undo the invoice. */
async function deliver(invoiceId: string): Promise<void> {
  try {
    finaliseForSending(invoiceId);
    const sent = await sendInvoiceEmail(invoiceId, {
      attachEinvoice: true,
      skipInvalidEinvoice: true,
    });
    if (!sent.success) {
      logger.warn(
        { invoiceId, error: sent.error },
        "Agency renewal invoice issued but not emailed",
      );
    }
  } catch (err) {
    logger.error({ err, invoiceId }, "Agency renewal invoice delivery failed");
  }
}

const BILLABLE_SELECT = `SELECT s.*, ai.product_id FROM agency_subscriptions s
  LEFT JOIN agency_items ai ON ai.id = s.item_id`;

export interface BillingRunResult {
  invoices: string[];
  periods: number;
  errors: number;
}

/** Bill every active subscription whose renewal falls inside the invoicing
 *  window. Run by the scheduler; safe to call repeatedly. */
export async function runDueBilling(today = todayIso()): Promise<BillingRunResult> {
  const db = getDb();
  const cfg = getConfig();
  const horizon = addDays(today, cfg.lead_days);

  db.run(
    `UPDATE agency_subscriptions SET status = 'ended', updated_at = datetime('now')
     WHERE status = 'active' AND end_date IS NOT NULL AND next_billing_date > end_date`,
  );

  const due = db
    .query(
      `${BILLABLE_SELECT} WHERE s.status = 'active' AND s.next_billing_date <= ?
       ORDER BY s.customer_id, s.next_billing_date, s.name COLLATE NOCASE`,
    )
    .all(horizon) as BillableRow[];

  const groups = new Map<string, BillingEntry[]>();
  for (const sub of due) {
    const entry = duePeriods(sub, horizon);
    if (entry.periods.length === 0) continue;
    const key = cfg.bundle ? `${sub.customer_id}|${sub.currency}` : sub.id;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }

  const result: BillingRunResult = { invoices: [], periods: 0, errors: 0 };
  for (const entries of groups.values()) {
    const { customer_id, currency } = entries[0].sub;
    try {
      const invoiceId = billEntries(customer_id, currency, entries, "schedule", today);
      if (invoiceId) {
        result.invoices.push(invoiceId);
        result.periods += entries.reduce((n, e) => n + e.periods.length, 0);
      }
    } catch (err) {
      result.errors += 1;
      logger.error({ err, customer_id }, "Agency renewal billing failed");
    }
  }

  if (cfg.auto_send) for (const id of result.invoices) await deliver(id);
  return result;
}

/** Invoice the next period of one subscription now, whatever its date. */
export async function billNow(
  id: string,
  today = todayIso(),
): Promise<Result<{ invoice_id: string }>> {
  const sub = getDb().query(`${BILLABLE_SELECT} WHERE s.id = ?`).get(id) as BillableRow | null;
  if (!sub) return fail("Subscription not found", 404);
  if (sub.status !== "active") return fail("Only an active subscription can be billed");
  const entry = duePeriods(sub, today, true);
  if (entry.periods.length === 0) return fail("This subscription has reached its end date");

  const invoiceId = billEntries(sub.customer_id, sub.currency, [entry], "manual", today);
  if (!invoiceId) return fail("This period has already been invoiced");
  if (getConfig().auto_send) await deliver(invoiceId);
  return { ok: true, data: { invoice_id: invoiceId } };
}

/** Log a period billed on an order's first invoice, so its history is whole. */
export function logInitialPeriod(
  subscriptionId: string,
  invoiceId: string,
  period: DuePeriod,
  amount: number,
): void {
  getDb().run(
    `INSERT OR IGNORE INTO agency_billing_log (id, subscription_id, invoice_id, period_start, period_end, amount, source)
     VALUES (?, ?, ?, ?, ?, ?, 'order')`,
    [newId(), subscriptionId, invoiceId, period.start, period.end, round2(amount)],
  );
  getDb().run(
    "UPDATE agency_subscriptions SET last_invoice_id = ?, last_billed_at = datetime('now') WHERE id = ?",
    [invoiceId, subscriptionId],
  );
}

/** Cancel every running subscription an order started. */
export function cancelOrderSubscriptions(orderId: string): number {
  return getDb().run(
    `UPDATE agency_subscriptions SET status = 'cancelled', cancelled_at = datetime('now'),
       updated_at = datetime('now')
     WHERE order_id = ? AND status IN ('active', 'paused')`,
    [orderId],
  ).changes;
}

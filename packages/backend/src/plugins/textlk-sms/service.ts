// text.lk SMS business logic: template rendering, idempotent delivery with a
// log, the two event handlers (invoice issued, payment recorded), the two
// scheduled jobs (payment reminders, upcoming recurring invoices), and custom
// messages.

import crypto from "node:crypto";
import { getDb } from "../../database/connection";
import { getInvoice, publishInvoice, SHAREABLE_STATUSES } from "../../services/invoice.service";
import { getAllSettings } from "../../services/settings.service";
import { formatCurrency, outstandingBalance } from "../../utils/currency";
import { formatDateStr, todayIso } from "../../utils/date";
import { getEnv } from "../../utils/env";
import { logger } from "../../utils/logger";
import type { PluginEvent } from "../registry";
import { getSmsTransport, normalizePhone } from "./client";
import { getConfig, isConfigured, type SmsConfig, type TemplateKey } from "./config";

export interface SmsLogRow {
  id: string;
  event: string;
  ref_key: string | null;
  customer_id: string | null;
  invoice_id: string | null;
  recipient: string;
  message: string;
  status: "pending" | "sent" | "failed";
  provider_uid: string | null;
  error: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
}

/** Replace {{name}} placeholders. Unknown or empty variables render as "". */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => vars[key] ?? "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function getLogRow(id: string): SmsLogRow | null {
  return getDb().query("SELECT * FROM textlk_sms_log WHERE id = ?").get(id) as SmsLogRow | null;
}

interface CustomerRow {
  id: string;
  name: string;
  phone: string | null;
  language: string | null;
}

function getCustomer(id: string): CustomerRow | null {
  return getDb()
    .query("SELECT id, name, phone, language FROM customers WHERE id = ?")
    .get(id) as CustomerRow | null;
}

interface DeliverInput {
  event: string;
  /** Idempotency key for automatic sends; null for custom/test sends. */
  refKey: string | null;
  customerId: string | null;
  invoiceId: string | null;
  phone: string | null;
  message: string;
}

/**
 * Send one SMS and log it. With a refKey the log row is claimed before the
 * network call, so a concurrent or repeated trigger for the same key sends
 * nothing and returns null.
 */
async function deliver(cfg: SmsConfig, input: DeliverInput): Promise<SmsLogRow | null> {
  const db = getDb();
  const id = crypto.randomBytes(16).toString("hex");
  const normalized = normalizePhone(input.phone);
  const claimed = db.run(
    `INSERT OR IGNORE INTO textlk_sms_log
       (id, event, ref_key, customer_id, invoice_id, recipient, message, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [
      id,
      input.event,
      input.refKey,
      input.customerId,
      input.invoiceId,
      normalized ?? input.phone ?? "",
      input.message,
    ],
  );
  if (claimed.changes === 0) return null;

  await attempt(cfg, id, normalized, input.message);
  return getLogRow(id);
}

async function attempt(
  cfg: SmsConfig,
  logId: string,
  recipient: string | null,
  message: string,
): Promise<void> {
  const result = recipient
    ? await getSmsTransport().send({
        apiToken: cfg.api_token,
        senderId: cfg.sender_id,
        recipient,
        message,
      })
    : ({ ok: false, error: "Invalid phone number" } as const);

  getDb().run(
    `UPDATE textlk_sms_log
     SET status = ?, provider_uid = ?, error = ?, attempts = attempts + 1, updated_at = datetime('now')
     WHERE id = ?`,
    [
      result.ok ? "sent" : "failed",
      result.ok ? result.uid : null,
      result.ok ? null : result.error,
      logId,
    ],
  );
  if (!result.ok) logger.warn({ logId, error: result.error }, "SMS delivery failed");
}

// --- Template variables ------------------------------------------------------

interface InvoiceContext {
  invoiceId: string;
  customer: CustomerRow;
  vars: Record<string, string>;
}

/**
 * Variables for an invoice-related message. When the template links to the
 * invoice and it has never been shared, it is published first, as the email
 * send does. An invoice someone deliberately unpublished stays unpublished.
 */
function invoiceContext(invoiceId: string, template: string): InvoiceContext | null {
  const invoice = getInvoice(invoiceId);
  if (!invoice || invoice.type !== "invoice") return null;
  const customer = getCustomer(invoice.customer_id);
  if (!customer) return null;

  const settings = getAllSettings();
  const locale = invoice.locale || customer.language || undefined;
  const money = (n: number) =>
    formatCurrency(n, invoice.currency, settings.number_format || undefined, locale);
  const date = (d: string | null) =>
    d ? formatDateStr(d, settings.date_format || undefined, locale) : "";

  let link = "";
  if (/\{\{\s*invoice_link\s*\}\}/.test(template)) {
    const shared =
      invoice.share_token || !SHAREABLE_STATUSES.includes(invoice.status)
        ? invoice
        : (publishInvoice(invoiceId) ?? invoice);
    const origin = getEnv().PUBLIC_BASE_URL;
    if (shared.share_token && shared.is_published && origin) {
      link = `${origin}/public/invoice/${shared.share_token}`;
    }
  }

  return {
    invoiceId,
    customer,
    vars: {
      company_name: settings.company_name || "",
      customer_name: customer.name,
      invoice_number: invoice.invoice_number,
      total: money(invoice.total),
      amount_paid: money(invoice.amount_paid || 0),
      amount_due: money(
        outstandingBalance(invoice.total, invoice.amount_paid || 0, invoice.currency),
      ),
      due_date: date(invoice.due_date),
      issue_date: date(invoice.issue_date),
      invoice_link: link,
    },
  };
}

// --- Event handlers ----------------------------------------------------------

export async function onInvoiceIssued(invoiceId: string): Promise<SmsLogRow | null> {
  const cfg = getConfig();
  if (!isConfigured(cfg) || !cfg.events.invoice_issued) return null;
  const ctx = invoiceContext(invoiceId, cfg.templates.invoice_issued);
  if (!ctx?.customer.phone) return null;

  return deliver(cfg, {
    event: "invoice_issued",
    refKey: `issued:${invoiceId}`,
    customerId: ctx.customer.id,
    invoiceId,
    phone: ctx.customer.phone,
    message: renderTemplate(cfg.templates.invoice_issued, ctx.vars),
  });
}

export async function onPaymentRecorded(
  invoiceId: string,
  paymentId: string,
): Promise<SmsLogRow | null> {
  const cfg = getConfig();
  if (!isConfigured(cfg) || !cfg.events.payment_received) return null;
  const payment = getDb().query("SELECT amount FROM payments WHERE id = ?").get(paymentId) as {
    amount: number;
  } | null;
  if (!payment) return null;
  const ctx = invoiceContext(invoiceId, cfg.templates.payment_received);
  if (!ctx?.customer.phone) return null;

  const invoice = getInvoice(invoiceId);
  const settings = getAllSettings();
  const paymentAmount = formatCurrency(
    payment.amount,
    invoice?.currency,
    settings.number_format || undefined,
    invoice?.locale || ctx.customer.language || undefined,
  );

  return deliver(cfg, {
    event: "payment_received",
    refKey: `payment:${paymentId}`,
    customerId: ctx.customer.id,
    invoiceId,
    phone: ctx.customer.phone,
    message: renderTemplate(cfg.templates.payment_received, {
      ...ctx.vars,
      payment_amount: paymentAmount,
    }),
  });
}

export async function handleEvent(event: PluginEvent): Promise<void> {
  if (event.type === "invoice.issued") await onInvoiceIssued(event.invoiceId);
  else if (event.type === "payment.recorded")
    await onPaymentRecorded(event.invoiceId, event.paymentId);
}

// --- Scheduled jobs ----------------------------------------------------------

const REMINDER_TEMPLATE: Record<string, TemplateKey> = {
  before_due: "reminder_before_due",
  on_due: "reminder_on_due",
  after_due: "reminder_after_due",
};

/**
 * SMS counterpart of the core email reminders: the same active reminder rules
 * pick the invoices (due date offset from today), each rule sends at most
 * once per invoice.
 */
export async function processPaymentReminders(cfg: SmsConfig, today: string): Promise<number> {
  const db = getDb();
  const rules = db
    .query("SELECT id, type, days_offset FROM reminder_rules WHERE is_active = 1")
    .all() as { id: string; type: string; days_offset: number }[];

  let sent = 0;
  for (const rule of rules) {
    const templateKey = REMINDER_TEMPLATE[rule.type];
    if (!templateKey) continue;
    const offset =
      rule.type === "before_due"
        ? rule.days_offset
        : rule.type === "after_due"
          ? -rule.days_offset
          : 0;
    const dueDate = addDays(today, offset);

    const invoices = db
      .query(
        `SELECT i.id FROM invoices i
         JOIN customers c ON c.id = i.customer_id
         WHERE i.status IN ('sent', 'partially_paid', 'overdue')
           AND i.type = 'invoice'
           AND i.deleted_at IS NULL
           AND i.due_date = ?
           AND c.phone IS NOT NULL AND TRIM(c.phone) != ''
           AND NOT EXISTS (
             SELECT 1 FROM textlk_sms_log l WHERE l.ref_key = 'reminder:' || ? || ':' || i.id
           )`,
      )
      .all(dueDate, rule.id) as { id: string }[];

    for (const inv of invoices) {
      const template = cfg.templates[templateKey];
      const ctx = invoiceContext(inv.id, template);
      if (!ctx) continue;
      const row = await deliver(cfg, {
        event: "payment_reminder",
        refKey: `reminder:${rule.id}:${inv.id}`,
        customerId: ctx.customer.id,
        invoiceId: inv.id,
        phone: ctx.customer.phone,
        message: renderTemplate(template, ctx.vars),
      });
      if (row?.status === "sent") sent++;
    }
  }
  return sent;
}

/**
 * Notice ahead of a recurring profile's next invoice: sent once per run date,
 * when that date falls within the next `recurring_reminder_days` days.
 */
export async function processRecurringUpcoming(cfg: SmsConfig, today: string): Promise<number> {
  const db = getDb();
  const horizon = addDays(today, cfg.recurring_reminder_days);
  const profiles = db
    .query(
      `SELECT r.id, r.next_run_date, r.frequency, r.customer_id,
              i.total, i.currency, i.locale,
              c.name AS customer_name, c.phone, c.language
       FROM recurring_invoices r
       JOIN customers c ON c.id = r.customer_id
       JOIN invoices i ON i.id = r.template_invoice_id
       WHERE r.status = 'active'
         AND r.next_run_date > ? AND r.next_run_date <= ?
         AND (r.end_date IS NULL OR r.next_run_date <= r.end_date)
         AND c.phone IS NOT NULL AND TRIM(c.phone) != ''
         AND NOT EXISTS (
           SELECT 1 FROM textlk_sms_log l
           WHERE l.ref_key = 'recurring:' || r.id || ':' || r.next_run_date
         )`,
    )
    .all(today, horizon) as {
    id: string;
    next_run_date: string;
    frequency: string;
    customer_id: string;
    total: number;
    currency: string;
    locale: string | null;
    customer_name: string;
    phone: string;
    language: string | null;
  }[];
  if (profiles.length === 0) return 0;

  const settings = getAllSettings();
  let sent = 0;
  for (const p of profiles) {
    const locale = p.locale || p.language || undefined;
    const row = await deliver(cfg, {
      event: "recurring_upcoming",
      refKey: `recurring:${p.id}:${p.next_run_date}`,
      customerId: p.customer_id,
      invoiceId: null,
      phone: p.phone,
      message: renderTemplate(cfg.templates.recurring_upcoming, {
        company_name: settings.company_name || "",
        customer_name: p.customer_name,
        total: formatCurrency(p.total, p.currency, settings.number_format || undefined, locale),
        next_date: formatDateStr(p.next_run_date, settings.date_format || undefined, locale),
        frequency: p.frequency,
      }),
    });
    if (row?.status === "sent") sent++;
  }
  return sent;
}

export async function runScheduled(today = todayIso()): Promise<void> {
  const cfg = getConfig();
  if (!isConfigured(cfg)) return;
  const reminders = cfg.events.payment_reminders ? await processPaymentReminders(cfg, today) : 0;
  const upcoming = cfg.events.recurring_upcoming ? await processRecurringUpcoming(cfg, today) : 0;
  if (reminders + upcoming > 0) {
    logger.info({ reminders, upcoming }, "text.lk SMS: scheduled messages sent");
  }
}

// --- Custom, test, retry -----------------------------------------------------

export const MAX_CUSTOM_RECIPIENTS = 50;

export type SendOutcome =
  | { success: true; data: SmsLogRow[] }
  | { success: false; error: string; status: 400 };

export async function sendCustom(input: {
  customer_ids?: string[];
  numbers?: string[];
  message: string;
}): Promise<SendOutcome> {
  const cfg = getConfig();
  if (!isConfigured(cfg)) {
    return { success: false, error: "text.lk is not configured", status: 400 };
  }
  const companyName = getAllSettings().company_name || "";

  const targets: { customer: CustomerRow | null; phone: string }[] = [];
  for (const id of new Set(input.customer_ids ?? [])) {
    const customer = getCustomer(id);
    if (!customer) return { success: false, error: "Customer not found", status: 400 };
    if (!customer.phone?.trim()) {
      return { success: false, error: `${customer.name} has no phone number`, status: 400 };
    }
    targets.push({ customer, phone: customer.phone });
  }
  for (const n of new Set((input.numbers ?? []).map((n) => n.trim()).filter(Boolean))) {
    targets.push({ customer: null, phone: n });
  }
  if (targets.length === 0) return { success: false, error: "No recipients", status: 400 };
  if (targets.length > MAX_CUSTOM_RECIPIENTS) {
    return {
      success: false,
      error: `At most ${MAX_CUSTOM_RECIPIENTS} recipients per send`,
      status: 400,
    };
  }
  const invalid = targets.find((t) => !normalizePhone(t.phone));
  if (invalid) {
    return { success: false, error: `Invalid phone number: ${invalid.phone}`, status: 400 };
  }

  const rows: SmsLogRow[] = [];
  for (const t of targets) {
    const row = await deliver(cfg, {
      event: "custom",
      refKey: null,
      customerId: t.customer?.id ?? null,
      invoiceId: null,
      phone: t.phone,
      message: renderTemplate(input.message, {
        company_name: companyName,
        customer_name: t.customer?.name ?? "",
      }),
    });
    if (row) rows.push(row);
  }
  return { success: true, data: rows };
}

export async function sendTest(to: string): Promise<SendOutcome> {
  const cfg = getConfig();
  if (!isConfigured(cfg)) {
    return { success: false, error: "Set the API token and sender ID first", status: 400 };
  }
  if (!normalizePhone(to)) return { success: false, error: "Invalid phone number", status: 400 };
  const companyName = getAllSettings().company_name || "Inkvoice";
  const row = await deliver(cfg, {
    event: "test",
    refKey: null,
    customerId: null,
    invoiceId: null,
    phone: to,
    message: `Test message from ${companyName}. text.lk SMS is working.`,
  });
  return { success: true, data: row ? [row] : [] };
}

export async function retry(
  logId: string,
): Promise<{ ok: true; row: SmsLogRow } | { ok: false; error: string; status: 400 | 404 }> {
  const row = getLogRow(logId);
  if (!row) return { ok: false, error: "Not found", status: 404 };
  if (row.status !== "failed") {
    return { ok: false, error: "Only failed messages can be retried", status: 400 };
  }
  const cfg = getConfig();
  if (!isConfigured(cfg)) return { ok: false, error: "text.lk is not configured", status: 400 };
  await attempt(cfg, row.id, normalizePhone(row.recipient), row.message);
  return { ok: true, row: getLogRow(row.id) as SmsLogRow };
}

// --- Reads -------------------------------------------------------------------

export function listLog(params: { status?: string; limit: number; offset: number }) {
  const db = getDb();
  const where = params.status ? "WHERE l.status = ?" : "";
  const args = params.status ? [params.status] : [];
  const rows = db
    .query(
      `SELECT l.*, c.name AS customer_name, i.invoice_number
       FROM textlk_sms_log l
       LEFT JOIN customers c ON c.id = l.customer_id
       LEFT JOIN invoices i ON i.id = l.invoice_id
       ${where}
       ORDER BY l.created_at DESC, l.rowid DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...args, params.limit, params.offset);
  const { n } = db.query(`SELECT COUNT(*) AS n FROM textlk_sms_log l ${where}`).get(...args) as {
    n: number;
  };
  return { rows, total: n };
}

export function listRecipients() {
  return getDb()
    .query(
      `SELECT id, name, phone FROM customers
       WHERE phone IS NOT NULL AND TRIM(phone) != ''
       ORDER BY name COLLATE NOCASE`,
    )
    .all() as { id: string; name: string; phone: string }[];
}

// Plugin configuration, stored as one JSON document in textlk_sms_config.
// Missing fields fall back to DEFAULT_CONFIG, so adding a field later needs no
// data migration.

import { getDb } from "../../database/connection";

export const EVENTS = [
  "invoice_issued",
  "payment_received",
  "payment_reminders",
  "recurring_upcoming",
] as const;
export type SmsEvent = (typeof EVENTS)[number];

export const TEMPLATE_KEYS = [
  "invoice_issued",
  "payment_received",
  "reminder_before_due",
  "reminder_on_due",
  "reminder_after_due",
  "recurring_upcoming",
] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export interface SmsConfig {
  api_token: string;
  sender_id: string;
  events: Record<SmsEvent, boolean>;
  /** Days before a recurring profile's next run to send the upcoming notice. */
  recurring_reminder_days: number;
  templates: Record<TemplateKey, string>;
}

export const DEFAULT_TEMPLATES: Record<TemplateKey, string> = {
  invoice_issued:
    "Dear {{customer_name}}, invoice {{invoice_number}} for {{total}} has been issued, due {{due_date}}. View: {{invoice_link}} - {{company_name}}",
  payment_received:
    "Thank you {{customer_name}}! We received {{payment_amount}} for invoice {{invoice_number}}. Balance: {{amount_due}}. - {{company_name}}",
  reminder_before_due:
    "Reminder: invoice {{invoice_number}} ({{amount_due}}) is due on {{due_date}}. {{invoice_link}} - {{company_name}}",
  reminder_on_due:
    "Reminder: invoice {{invoice_number}} ({{amount_due}}) is due today. {{invoice_link}} - {{company_name}}",
  reminder_after_due:
    "Invoice {{invoice_number}} ({{amount_due}}) was due on {{due_date}} and is overdue. Please arrange payment. - {{company_name}}",
  recurring_upcoming:
    "Dear {{customer_name}}, your next {{frequency}} invoice of {{total}} will be issued on {{next_date}}. - {{company_name}}",
};

export const DEFAULT_CONFIG: SmsConfig = {
  api_token: "",
  sender_id: "",
  events: {
    invoice_issued: true,
    payment_received: true,
    payment_reminders: true,
    recurring_upcoming: true,
  },
  recurring_reminder_days: 3,
  templates: { ...DEFAULT_TEMPLATES },
};

const KEY = "config";

export function getConfig(): SmsConfig {
  const row = getDb().query("SELECT value FROM textlk_sms_config WHERE key = ?").get(KEY) as {
    value: string;
  } | null;
  let stored: Partial<SmsConfig> = {};
  if (row) {
    try {
      stored = JSON.parse(row.value) as Partial<SmsConfig>;
    } catch {
      stored = {};
    }
  }
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    events: { ...DEFAULT_CONFIG.events, ...stored.events },
    templates: { ...DEFAULT_TEMPLATES, ...stored.templates },
  };
}

export interface ConfigUpdate {
  /** undefined keeps the stored token; "" clears it. */
  api_token?: string;
  sender_id?: string;
  events?: Partial<Record<SmsEvent, boolean>>;
  recurring_reminder_days?: number;
  templates?: Partial<Record<TemplateKey, string>>;
}

export function updateConfig(update: ConfigUpdate): SmsConfig {
  const current = getConfig();
  const next: SmsConfig = {
    api_token: update.api_token === undefined ? current.api_token : update.api_token.trim(),
    sender_id: update.sender_id === undefined ? current.sender_id : update.sender_id.trim(),
    events: { ...current.events, ...update.events },
    recurring_reminder_days: update.recurring_reminder_days ?? current.recurring_reminder_days,
    templates: { ...current.templates, ...update.templates },
  };
  getDb().run(
    `INSERT INTO textlk_sms_config (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [KEY, JSON.stringify(next)],
  );
  return next;
}

export function isConfigured(cfg: SmsConfig): boolean {
  return cfg.api_token !== "" && cfg.sender_id !== "";
}

/** The config as the browser may see it: the token reduced to a hint. */
export function publicConfig(cfg: SmsConfig) {
  const { api_token, ...rest } = cfg;
  return {
    ...rest,
    api_token_set: api_token !== "",
    api_token_hint: api_token ? `••••${api_token.slice(-4)}` : null,
  };
}

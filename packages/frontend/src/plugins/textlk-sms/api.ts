// Typed client for the text.lk SMS plugin API (/api/v1/plugins/textlk-sms).

import { pluginFetch } from "../api";

const BASE = "/plugins/textlk-sms";

export const SMS_EVENTS = [
  "invoice_issued",
  "payment_received",
  "payment_reminders",
  "recurring_upcoming",
] as const;
export type SmsEvent = (typeof SMS_EVENTS)[number];

export const SMS_TEMPLATE_KEYS = [
  "invoice_issued",
  "payment_received",
  "reminder_before_due",
  "reminder_on_due",
  "reminder_after_due",
  "recurring_upcoming",
] as const;
export type SmsTemplateKey = (typeof SMS_TEMPLATE_KEYS)[number];

export interface SmsConfig {
  sender_id: string;
  events: Record<SmsEvent, boolean>;
  recurring_reminder_days: number;
  templates: Record<SmsTemplateKey, string>;
  api_token_set: boolean;
  api_token_hint: string | null;
  public_base_url_set: boolean;
  active_reminder_rules: number;
}

export interface SmsConfigUpdate {
  api_token?: string;
  sender_id?: string;
  events?: Partial<Record<SmsEvent, boolean>>;
  recurring_reminder_days?: number;
  templates?: Partial<Record<SmsTemplateKey, string>>;
}

export interface SmsLogRow {
  id: string;
  event: string;
  customer_id: string | null;
  customer_name: string | null;
  invoice_id: string | null;
  invoice_number: string | null;
  recipient: string;
  message: string;
  status: "pending" | "sent" | "failed";
  error: string | null;
  attempts: number;
  created_at: string;
}

export interface SmsRecipient {
  id: string;
  name: string;
  phone: string;
}

type Ok<T> = { success: true; data: T };

export const smsApi = {
  getConfig: () => pluginFetch<Ok<SmsConfig>>(`${BASE}/config`),
  updateConfig: (body: SmsConfigUpdate) =>
    pluginFetch<Ok<SmsConfig>>(`${BASE}/config`, { method: "PUT", body: JSON.stringify(body) }),
  sendTest: (to: string) =>
    pluginFetch<Ok<SmsLogRow | null>>(`${BASE}/test`, {
      method: "POST",
      body: JSON.stringify({ to }),
    }),
  recipients: () => pluginFetch<Ok<SmsRecipient[]>>(`${BASE}/recipients`),
  send: (body: { customer_ids: string[]; numbers: string[]; message: string }) =>
    pluginFetch<Ok<SmsLogRow[]>>(`${BASE}/send`, { method: "POST", body: JSON.stringify(body) }),
  log: (params: { status?: string; limit: number; offset: number }) => {
    const q = new URLSearchParams({ limit: String(params.limit), offset: String(params.offset) });
    if (params.status) q.set("status", params.status);
    return pluginFetch<Ok<{ rows: SmsLogRow[]; total: number }>>(`${BASE}/log?${q}`);
  },
  retry: (id: string) => pluginFetch<Ok<SmsLogRow>>(`${BASE}/log/${id}/retry`, { method: "POST" }),
};

// GSM 03.38 basic set plus the extension table (which costs two septets).
const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENDED = "^{}\\[~]|€\f";

/** Characters and SMS parts a message will bill as. Sinhala, Tamil or emoji
 *  switch the whole message to Unicode (70 per part, 67 when split). */
export function smsSegments(text: string): { chars: number; parts: number; unicode: boolean } {
  let septets = 0;
  let unicode = false;
  for (const ch of text) {
    if (GSM_BASIC.includes(ch)) septets += 1;
    else if (GSM_EXTENDED.includes(ch)) septets += 2;
    else {
      unicode = true;
      break;
    }
  }
  if (unicode) {
    const units = text.length; // UTF-16 code units, as UCS-2 counts them
    return { chars: units, parts: units <= 70 ? (units ? 1 : 0) : Math.ceil(units / 67), unicode };
  }
  return {
    chars: septets,
    parts: septets <= 160 ? (septets ? 1 : 0) : Math.ceil(septets / 153),
    unicode,
  };
}

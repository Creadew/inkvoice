import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import type { Hono } from "hono";
import { createApp } from "../app";
import { closeDatabase, getDb, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import "../plugins";
import { runPluginMigrations } from "../plugins/runner";
import { setPluginEnabled } from "../plugins/settings";
import { normalizePhone, type SendResult, setSmsTransport } from "../plugins/textlk-sms/client";
import { DEFAULT_CONFIG, getConfig, updateConfig } from "../plugins/textlk-sms/config";
import {
  processPaymentReminders,
  processRecurringUpcoming,
  renderTemplate,
} from "../plugins/textlk-sms/service";
import { createInvoice } from "../services/invoice.service";
import { createRecurring } from "../services/recurring.service";
import { createRule } from "../services/reminder.service";
import { todayIso } from "../utils/date";
import { resetEnvCache } from "../utils/env";

const TEST_DB = "./data/test-textlk-sms.db";
let app: Hono;
let token: string;

interface Sent {
  recipient: string;
  message: string;
  senderId: string;
  apiToken: string;
}
let sent: Sent[] = [];
let nextResult: SendResult = { ok: true, uid: "uid-1" };

// Event handlers run on a microtask after the request; give them a beat.
const flush = () => new Promise((r) => setTimeout(r, 25));

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function api(path: string, init: RequestInit = {}) {
  return app.request(`/api/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string>),
    },
  });
}

function makeCustomer(name: string, phone: string | null): string {
  const row = getDb()
    .query("INSERT INTO customers (name, phone) VALUES (?, ?) RETURNING id")
    .get(name, phone) as { id: string };
  return row.id;
}

function makeInvoice(customerId: string, dueDate: string | null = addDays(todayIso(), 14)) {
  return createInvoice({
    customer_id: customerId,
    issue_date: todayIso(),
    due_date: dueDate,
    currency: "LKR",
    items: [{ description: "Design work", quantity: 1, unit_price: 25000 }],
  } as Parameters<typeof createInvoice>[0]);
}

function logRows() {
  return getDb().query("SELECT * FROM textlk_sms_log ORDER BY rowid").all() as {
    event: string;
    ref_key: string | null;
    recipient: string;
    message: string;
    status: string;
    error: string | null;
    id: string;
  }[];
}

beforeAll(async () => {
  process.env.DATABASE_PATH = TEST_DB;
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASS = "smstestadminpass";
  process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-chars-long";
  process.env.RATE_LIMIT_ENABLED = "false";
  process.env.PUBLIC_BASE_URL = "https://billing.example.lk";
  resetEnvCache();
  initDatabase();
  runMigrations();
  runPluginMigrations();
  await seed();
  app = createApp();

  const res = await app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "smstestadminpass" }),
  });
  token = ((await res.json()) as { data: { token: string } }).data.token;

  setSmsTransport({
    async send(opts) {
      sent.push(opts);
      return nextResult;
    },
  });
});

afterAll(() => {
  setSmsTransport(null);
  delete process.env.PUBLIC_BASE_URL;
  resetEnvCache();
  closeDatabase();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB + suffix);
    } catch {}
  }
});

beforeEach(() => {
  sent = [];
  nextResult = { ok: true, uid: "uid-1" };
  getDb().run("DELETE FROM textlk_sms_log");
  getDb().run("DELETE FROM reminder_rules");
  setPluginEnabled("textlk-sms", true);
  updateConfig({
    ...DEFAULT_CONFIG,
    api_token: "tok-secret-1234",
    sender_id: "Creadew",
  });
});

describe("normalizePhone", () => {
  test.each([
    ["0771234567", "94771234567"],
    ["077 123 4567", "94771234567"],
    ["771234567", "94771234567"],
    ["94771234567", "94771234567"],
    ["+94 77 123 4567", "94771234567"],
    ["+94 (0)77 123 4567", "94771234567"],
    ["0094771234567", "94771234567"],
    ["+44 7700 900123", "447700900123"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  test.each([[""], ["12345"], ["abc"], [null]])("rejects %p", (input) => {
    expect(normalizePhone(input)).toBeNull();
  });
});

describe("renderTemplate", () => {
  test("substitutes known variables and blanks unknown ones", () => {
    expect(
      renderTemplate("Hi {{ customer_name }}, {{nope}} total {{total}}", {
        customer_name: "Nimal",
        total: "LKR 100.00",
      }),
    ).toBe("Hi Nimal, total LKR 100.00");
  });
});

describe("config API", () => {
  test("masks the token and keeps it out of core settings", async () => {
    const res = await api("/plugins/textlk-sms/config");
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect(body.data.api_token).toBeUndefined();
    expect(body.data.api_token_set).toBe(true);
    expect(body.data.api_token_hint).toBe("••••1234");
    expect(body.data.public_base_url_set).toBe(true);

    const settings = await (await api("/settings")).text();
    expect(settings).not.toContain("tok-secret-1234");
  });

  test("PUT without api_token keeps the stored token", async () => {
    const res = await api("/plugins/textlk-sms/config", {
      method: "PUT",
      body: JSON.stringify({ sender_id: "NewSender", events: { payment_received: false } }),
    });
    expect(res.status).toBe(200);
    const cfg = getConfig();
    expect(cfg.api_token).toBe("tok-secret-1234");
    expect(cfg.sender_id).toBe("NewSender");
    expect(cfg.events.payment_received).toBe(false);
    expect(cfg.events.invoice_issued).toBe(true);
  });

  test("rejects an over-long alphanumeric sender ID", async () => {
    const res = await api("/plugins/textlk-sms/config", {
      method: "PUT",
      body: JSON.stringify({ sender_id: "WayTooLongSender" }),
    });
    expect(res.status).toBe(400);
  });

  test("routes 404 while the plugin is disabled", async () => {
    setPluginEnabled("textlk-sms", false);
    const res = await api("/plugins/textlk-sms/config");
    expect(res.status).toBe(404);
  });
});

describe("invoice issued", () => {
  test("sends once when a draft is marked sent, with a public link", async () => {
    const customerId = makeCustomer("Nimal Perera", "077 123 4567");
    const invoice = makeInvoice(customerId);
    await flush();
    expect(sent).toHaveLength(0); // drafts never send

    const res = await api(`/invoices/${invoice.id}/mark-sent`, { method: "POST" });
    expect(res.status).toBe(200);
    await flush();

    expect(sent).toHaveLength(1);
    expect(sent[0].recipient).toBe("94771234567");
    expect(sent[0].senderId).toBe("Creadew");
    expect(sent[0].apiToken).toBe("tok-secret-1234");
    expect(sent[0].message).toContain("Nimal Perera");
    expect(sent[0].message).not.toContain("DRAFT");
    expect(sent[0].message).toContain("https://billing.example.lk/public/invoice/");

    const row = logRows()[0];
    expect(row.status).toBe("sent");
    expect(row.ref_key).toBe(`issued:${invoice.id}`);

    // The link in the SMS must actually resolve.
    const shareToken = sent[0].message.match(/public\/invoice\/(\w+)/)?.[1];
    const pub = await app.request(`/api/v1/public/invoices/${shareToken}`);
    expect(pub.status).toBe(200);
  });

  test("skips customers without a phone and respects the event toggle", async () => {
    const noPhone = makeInvoice(makeCustomer("No Phone", null));
    await api(`/invoices/${noPhone.id}/mark-sent`, { method: "POST" });

    updateConfig({ events: { invoice_issued: false } });
    const toggledOff = makeInvoice(makeCustomer("Toggled", "0711111111"));
    await api(`/invoices/${toggledOff.id}/mark-sent`, { method: "POST" });
    await flush();

    expect(sent).toHaveLength(0);
  });

  test("sends nothing while the plugin is disabled", async () => {
    setPluginEnabled("textlk-sms", false);
    const invoice = makeInvoice(makeCustomer("Disabled", "0712222222"));
    await api(`/invoices/${invoice.id}/mark-sent`, { method: "POST" });
    await flush();
    expect(sent).toHaveLength(0);
  });

  test("logs a provider failure, and retry resends it", async () => {
    nextResult = { ok: false, error: "Insufficient balance" };
    const invoice = makeInvoice(makeCustomer("Retry Me", "0713333333"));
    await api(`/invoices/${invoice.id}/mark-sent`, { method: "POST" });
    await flush();

    const failed = logRows()[0];
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("Insufficient balance");

    nextResult = { ok: true, uid: "uid-2" };
    const res = await api(`/plugins/textlk-sms/log/${failed.id}/retry`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(logRows()[0].status).toBe("sent");
    expect(sent).toHaveLength(2);

    const again = await api(`/plugins/textlk-sms/log/${failed.id}/retry`, { method: "POST" });
    expect(again.status).toBe(400);
    expect(sent).toHaveLength(2);
  });
});

describe("payment received", () => {
  test("sends for each recorded payment, including mark-paid", async () => {
    const invoice = makeInvoice(makeCustomer("Payer", "0714444444"));
    await api(`/invoices/${invoice.id}/mark-sent`, { method: "POST" });
    await flush();
    sent = [];

    await api(`/invoices/${invoice.id}/payments`, {
      method: "POST",
      body: JSON.stringify({ amount: 10000, payment_date: todayIso() }),
    });
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].message).toContain("10,000");

    await api(`/invoices/${invoice.id}/mark-paid`, { method: "POST" });
    await flush();
    expect(sent).toHaveLength(2);
    expect(sent[1].message).toContain("15,000");
    expect(logRows().filter((r) => r.event === "payment_received")).toHaveLength(2);
  });
});

describe("scheduled", () => {
  test("payment reminders follow active rules and send once per rule", async () => {
    const today = todayIso();
    createRule({
      name: "3 days before",
      days_offset: 3,
      type: "before_due",
      email_subject: "s",
      email_body: "b",
      is_active: true,
    });
    const due = makeInvoice(makeCustomer("Reminded", "0715555555"), addDays(today, 3));
    const notDue = makeInvoice(makeCustomer("Not Yet", "0716666666"), addDays(today, 10));
    await api(`/invoices/${due.id}/mark-sent`, { method: "POST" });
    await api(`/invoices/${notDue.id}/mark-sent`, { method: "POST" });
    await flush();
    sent = [];

    expect(await processPaymentReminders(getConfig(), today)).toBe(1);
    expect(await processPaymentReminders(getConfig(), today)).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].recipient).toBe("94715555555");
    expect(sent[0].message).toContain("Reminder");
  });

  test("upcoming recurring notice is sent once per run date", async () => {
    const today = todayIso();
    const customerId = makeCustomer("Retainer Client", "0717777777");
    const templateInvoice = makeInvoice(customerId);
    createRecurring({
      customer_id: customerId,
      template_invoice_id: templateInvoice.id,
      frequency: "monthly",
      next_run_date: addDays(today, 2),
    });
    createRecurring({
      customer_id: customerId,
      template_invoice_id: templateInvoice.id,
      frequency: "monthly",
      next_run_date: addDays(today, 20), // outside the 3-day window
    });

    expect(await processRecurringUpcoming(getConfig(), today)).toBe(1);
    expect(await processRecurringUpcoming(getConfig(), today)).toBe(0);
    expect(sent[0].message).toContain("monthly");
    expect(sent[0].message).toContain("25,000");
  });
});

describe("custom messages", () => {
  test("sends to customers and raw numbers with variables", async () => {
    const customerId = makeCustomer("Kamala", "0718888888");
    const res = await api("/plugins/textlk-sms/send", {
      method: "POST",
      body: JSON.stringify({
        customer_ids: [customerId],
        numbers: ["0719999999"],
        message: "Hello {{customer_name}}, our office is closed on Poya day.",
      }),
    });
    expect(res.status).toBe(201);
    expect(sent.map((s) => s.recipient)).toEqual(["94718888888", "94719999999"]);
    expect(sent[0].message).toBe("Hello Kamala, our office is closed on Poya day.");
    expect(sent[1].message).toBe("Hello , our office is closed on Poya day.");
  });

  test("rejects invalid numbers before sending anything", async () => {
    const res = await api("/plugins/textlk-sms/send", {
      method: "POST",
      body: JSON.stringify({ numbers: ["0719999999", "123"], message: "Hi" }),
    });
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  test("log lists sent messages with customer names", async () => {
    const customerId = makeCustomer("Logged", "0710000001");
    await api("/plugins/textlk-sms/send", {
      method: "POST",
      body: JSON.stringify({ customer_ids: [customerId], message: "Hi" }),
    });
    const res = await api("/plugins/textlk-sms/log?status=sent");
    const body = (await res.json()) as {
      data: { rows: { customer_name: string }[]; total: number };
    };
    expect(body.data.total).toBe(1);
    expect(body.data.rows[0].customer_name).toBe("Logged");
  });
});

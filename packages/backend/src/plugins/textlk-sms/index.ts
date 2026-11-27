// text.lk SMS plugin: SMS to customers when an invoice is issued, when a
// payment is recorded, for unpaid-invoice reminders (driven by the core
// reminder rules), ahead of a recurring invoice, and as custom messages.
// Mounted at /api/v1/plugins/textlk-sms.
//
// Permissions: configuration follows reminder rules (settings:read/update);
// sending a custom SMS follows emailing an invoice (invoices:publish); the log
// and recipient list need customers:read.

import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../../database/connection";
import { requirePermission } from "../../middleware/auth";
import { getEnv } from "../../utils/env";
import { registerBackendPlugin } from "../registry";
import { EVENTS, getConfig, publicConfig, TEMPLATE_KEYS, updateConfig } from "./config";
import { textlkSmsMigrations } from "./migrations";
import * as svc from "./service";

const routes = new Hono();

const ok = (data: unknown) => ({ success: true as const, data });

function configResponse() {
  const activeRules = getDb()
    .query("SELECT COUNT(*) AS n FROM reminder_rules WHERE is_active = 1")
    .get() as { n: number };
  return {
    ...publicConfig(getConfig()),
    // Without PUBLIC_BASE_URL scheduler- and event-sent SMS cannot carry a link.
    public_base_url_set: getEnv().PUBLIC_BASE_URL !== "",
    active_reminder_rules: activeRules.n,
  };
}

routes.get("/config", requirePermission("settings", "read"), (c) => c.json(ok(configResponse())));

const configSchema = z.object({
  api_token: z.string().max(500).optional(),
  sender_id: z
    .string()
    .trim()
    // text.lk: a phone number with country code, or up to 11 alphanumerics.
    .regex(/^([A-Za-z0-9 ]{1,11}|\d{1,15})$/, "Sender ID must be up to 11 letters or digits")
    .or(z.literal(""))
    .optional(),
  events: z
    .object(Object.fromEntries(EVENTS.map((e) => [e, z.boolean()])))
    .partial()
    .optional(),
  recurring_reminder_days: z.number().int().min(1).max(30).optional(),
  templates: z
    .object(Object.fromEntries(TEMPLATE_KEYS.map((k) => [k, z.string().trim().min(1).max(1000)])))
    .partial()
    .optional(),
});

routes.put("/config", requirePermission("settings", "update"), async (c) => {
  const parsed = configSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return c.json({ success: false, error: issue?.message ?? "Invalid configuration" }, 400);
  }
  updateConfig(parsed.data);
  return c.json(ok(configResponse()));
});

const testSchema = z.object({ to: z.string().min(1).max(30) });

routes.post("/test", requirePermission("settings", "update"), async (c) => {
  const parsed = testSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: "Invalid phone number" }, 400);
  const result = await svc.sendTest(parsed.data.to);
  if (!result.success) return c.json({ success: false, error: result.error }, result.status);
  return c.json(ok(result.data[0] ?? null));
});

routes.get("/recipients", requirePermission("customers", "read"), (c) =>
  c.json(ok(svc.listRecipients())),
);

const sendSchema = z.object({
  customer_ids: z.array(z.string().min(1)).optional(),
  numbers: z.array(z.string().min(1).max(30)).optional(),
  message: z.string().trim().min(1).max(1000),
});

routes.post("/send", requirePermission("invoices", "publish"), async (c) => {
  const parsed = sendSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, error: "Invalid message" }, 400);
  const result = await svc.sendCustom(parsed.data);
  if (!result.success) return c.json({ success: false, error: result.error }, result.status);
  return c.json(ok(result.data), 201);
});

routes.get("/log", requirePermission("customers", "read"), (c) => {
  const status = c.req.query("status");
  const limit = Math.min(Math.max(1, Number.parseInt(c.req.query("limit") || "50", 10) || 50), 200);
  const offset = Math.max(0, Number.parseInt(c.req.query("offset") || "0", 10) || 0);
  return c.json(
    ok(
      svc.listLog({
        status: status && ["sent", "failed", "pending"].includes(status) ? status : undefined,
        limit,
        offset,
      }),
    ),
  );
});

routes.post("/log/:id/retry", requirePermission("invoices", "publish"), async (c) => {
  const result = await svc.retry(c.req.param("id"));
  if (!result.ok) return c.json({ success: false, error: result.error }, result.status);
  return c.json(ok(result.row));
});

registerBackendPlugin({
  id: "textlk-sms",
  version: "1.0.0",
  routes,
  migrations: textlkSmsMigrations,
  meta: {
    name: "text.lk SMS",
    tagline: "SMS your customers through the text.lk gateway.",
    description:
      "Sends SMS when an invoice is issued, when a payment is received, for unpaid-invoice reminders, before a recurring invoice is generated, and as custom messages. Requires a text.lk account, API token and approved sender ID.",
    category: "integrations",
    icon: "MessageSquare",
  },
  onEvent: svc.handleEvent,
  onSchedule: () => svc.runScheduled(),
});

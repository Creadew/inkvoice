// Agency Services plugin: a service catalog (packages with feature lists,
// add-ons paired to packages, standalone services), orders that turn catalog
// lines into a quote or an invoice, and client subscriptions for recurring
// charges (domains, hosting, retainers, maintenance) with renewal invoices
// created ahead of each renewal date. Mounted at /api/v1/plugins/agency-services.
//
// Permissions follow the core resources the data stands for: the catalog is
// products, orders and subscriptions are invoices (as quotes and recurring
// invoices are), and the plugin configuration is settings.

import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { requirePermission } from "../../middleware/auth";
import { logActivity } from "../../services/activity.service";
import { registerBackendPlugin } from "../registry";
import {
  BILLING_TYPES,
  CATEGORIES,
  createItem,
  deleteItem,
  duplicateItem,
  getItem,
  INTERVAL_UNITS,
  ITEM_KINDS,
  type ItemKind,
  listItems,
  MAX_FEATURE_LENGTH,
  MAX_FEATURES,
  MAX_FREE_MONTHS,
  PAIRING_MODES,
  setPackageAddons,
  updateItem,
} from "./catalog";
import { getConfig, updateConfig } from "./config";
import { seedExampleCatalog } from "./examples";
import { agencyServicesMigrations } from "./migrations";
import {
  activateOrder,
  cancelOrder,
  createOrder,
  deleteOrder,
  getOrder,
  LINE_KINDS,
  listOrders,
  MAX_ORDER_LINES,
  ORDER_STATUSES,
  type OrderStatus,
} from "./orders";
import { isIsoDate } from "./periods";
import {
  billNow,
  cancelSubscription,
  createSubscription,
  deleteSubscription,
  getHistory,
  getSubscription,
  getSummary,
  listSubscriptions,
  pauseSubscription,
  resumeSubscription,
  runDueBilling,
  SUBSCRIPTION_STATUSES,
  type SubscriptionStatus,
  taxExists,
  updateSubscription,
} from "./subscriptions";

const PLUGIN_ID = "agency-services";

const routes = new Hono();

const ok = (data: unknown) => ({ success: true as const, data });

function actor(c: Context): { userId: string | null; username: string | null } {
  const user = c.get("user") as { sub?: string; username?: string } | undefined;
  return {
    userId: (c.get("userId") as string | undefined) ?? user?.sub ?? null,
    username: user?.username ?? null,
  };
}

async function parse<T>(
  c: Context,
  schema: z.ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (parsed.success) return { ok: true, data: parsed.data };
  const issue = parsed.error.issues[0];
  const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
  return { ok: false, error: issue ? `${where}${issue.message}` : "Invalid request body" };
}

function log(
  c: Context,
  action: string,
  resourceType: "quote" | "invoice",
  resourceId: string,
  metadata: Record<string, unknown>,
) {
  const { userId, username } = actor(c);
  logActivity({
    user_id: userId,
    user_name: username,
    action,
    resource_type: resourceType,
    resource_id: resourceId,
    metadata: { ...metadata, source: PLUGIN_ID },
  });
}

const isoDate = z.string().refine(isIsoDate, "Use a YYYY-MM-DD date");
const amount = z.number().finite().min(0).max(1e12);
const id = z.string().min(1).max(64);
const currency = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, "Use a three-letter currency code");

// --- Catalog -------------------------------------------------------------------

const itemSchema = z.object({
  kind: z.enum(ITEM_KINDS),
  name: z.string().trim().min(1).max(200),
  category: z.enum(CATEGORIES).optional(),
  description: z.string().max(2000).nullable().optional(),
  features: z.array(z.string().max(MAX_FEATURE_LENGTH)).max(MAX_FEATURES).optional(),
  billing: z.enum(BILLING_TYPES).optional(),
  price: amount.optional(),
  setup_fee: amount.optional(),
  interval_unit: z.enum(INTERVAL_UNITS).nullable().optional(),
  interval_count: z.number().int().min(1).max(120).optional(),
  unit: z.string().trim().max(40).optional(),
  tax_id: id.nullable().optional(),
  is_active: z.boolean().optional(),
});
const itemUpdateSchema = itemSchema.omit({ kind: true }).partial();

routes.get("/items", requirePermission("products", "read"), (c) => {
  const kind = c.req.query("kind");
  return c.json(
    ok(
      listItems({
        kind: (ITEM_KINDS as readonly string[]).includes(kind ?? "")
          ? (kind as ItemKind)
          : undefined,
        includeInactive: c.req.query("include_inactive") === "true",
      }),
    ),
  );
});

// Before /items/:id, so "examples" is never read as an id.
routes.post("/items/examples", requirePermission("products", "create"), (c) => {
  const items = seedExampleCatalog();
  if (!items) return c.json({ success: false, error: "The catalog already has items" }, 409);
  return c.json(ok(items), 201);
});

routes.get("/items/:id", requirePermission("products", "read"), (c) => {
  const item = getItem(c.req.param("id"));
  if (!item) return c.json({ success: false, error: "Item not found" }, 404);
  return c.json(ok(item));
});

routes.post("/items", requirePermission("products", "create"), async (c) => {
  const body = await parse(c, itemSchema);
  if (!body.ok) return c.json({ success: false, error: body.error }, 400);
  if (!taxExists(body.data.tax_id)) {
    return c.json({ success: false, error: "Tax rate not found" }, 400);
  }
  return c.json(ok(createItem(body.data)), 201);
});

routes.put("/items/:id", requirePermission("products", "update"), async (c) => {
  const body = await parse(c, itemUpdateSchema);
  if (!body.ok) return c.json({ success: false, error: body.error }, 400);
  if (!taxExists(body.data.tax_id)) {
    return c.json({ success: false, error: "Tax rate not found" }, 400);
  }
  const item = updateItem(c.req.param("id"), body.data);
  if (!item) return c.json({ success: false, error: "Item not found" }, 404);
  return c.json(ok(item));
});

routes.delete("/items/:id", requirePermission("products", "delete"), (c) => {
  if (!deleteItem(c.req.param("id"))) {
    return c.json({ success: false, error: "Item not found" }, 404);
  }
  return c.json(ok({ id: c.req.param("id") }));
});

routes.post("/items/:id/duplicate", requirePermission("products", "create"), (c) => {
  const copy = duplicateItem(c.req.param("id"));
  if (!copy) return c.json({ success: false, error: "Item not found" }, 404);
  return c.json(ok(copy), 201);
});

const pairingsSchema = z.object({
  addons: z
    .array(
      z.object({
        addon_id: id,
        mode: z.enum(PAIRING_MODES),
        free_months: z.number().int().min(0).max(MAX_FREE_MONTHS).optional(),
      }),
    )
    .max(200),
});

routes.put("/items/:id/addons", requirePermission("products", "update"), async (c) => {
  const body = await parse(c, pairingsSchema);
  if (!body.ok) return c.json({ success: false, error: body.error }, 400);
  const result = setPackageAddons(
    c.req.param("id"),
    body.data.addons.map((a) => ({ ...a, free_months: a.free_months ?? 0 })),
  );
  if (!result.ok) {
    const status = result.error === "Package not found" ? 404 : 400;
    return c.json({ success: false, error: result.error }, status);
  }
  return c.json(ok(result.item));
});

// --- Orders --------------------------------------------------------------------

const lineSchema = z.object({
  item_id: id.nullable().optional(),
  kind: z.enum(LINE_KINDS),
  category: z.enum(CATEGORIES).optional(),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  quantity: z.number().finite().positive().max(1e9).optional(),
  // Negative prices allowed, for a discount line.
  unit_price: z.number().finite().min(-1e12).max(1e12).optional(),
  unit: z.string().trim().max(40).optional(),
  tax_id: id.nullable().optional(),
  billing: z.enum(BILLING_TYPES),
  interval_unit: z.enum(INTERVAL_UNITS).nullable().optional(),
  interval_count: z.number().int().min(1).max(120).optional(),
  setup_fee: amount.optional(),
  free_months: z.number().int().min(0).max(MAX_FREE_MONTHS).optional(),
  reference: z.string().max(200).nullable().optional(),
  included: z.boolean().optional(),
});

const orderSchema = z.object({
  customer_id: id,
  currency: currency.optional(),
  lines: z.array(lineSchema).min(1).max(MAX_ORDER_LINES),
  notes: z.string().max(5000).nullable().optional(),
  mode: z.enum(["quote", "invoice"]),
  start_date: isoDate.optional(),
  exchange_rate: z.number().finite().positive().optional(),
  valid_until: isoDate.nullable().optional(),
  title: z.string().max(200).optional(),
});

routes.get("/orders", requirePermission("invoices", "read"), (c) => {
  const status = c.req.query("status");
  return c.json(
    ok(
      listOrders({
        status: (ORDER_STATUSES as readonly string[]).includes(status ?? "")
          ? (status as OrderStatus)
          : undefined,
        customer_id: c.req.query("customer_id") || undefined,
      }),
    ),
  );
});

routes.get("/orders/:id", requirePermission("invoices", "read"), (c) => {
  const order = getOrder(c.req.param("id"));
  if (!order) return c.json({ success: false, error: "Order not found" }, 404);
  return c.json(ok(order));
});

routes.post("/orders", requirePermission("invoices", "create"), async (c) => {
  const body = await parse(c, orderSchema);
  if (!body.ok) return c.json({ success: false, error: body.error }, 400);
  const result = createOrder(body.data, actor(c).userId);
  if (!result.ok) return c.json({ success: false, error: result.error }, result.status);
  const order = result.data;
  if (order.quote_id) {
    log(c, "created", "quote", order.quote_id, {
      quote_number: order.quote_number,
      order_id: order.id,
    });
  }
  if (order.invoice_id) {
    log(c, "created", "invoice", order.invoice_id, {
      invoice_number: order.invoice_number,
      order_id: order.id,
    });
  }
  return c.json(ok(order), 201);
});

const activateSchema = z.object({
  start_date: isoDate.optional(),
  create_invoice: z.boolean().optional(),
});

routes.post("/orders/:id/activate", requirePermission("invoices", "create"), async (c) => {
  const body = await parse(c, activateSchema);
  if (!body.ok) return c.json({ success: false, error: body.error }, 400);
  const before = getOrder(c.req.param("id"));
  const result = activateOrder(c.req.param("id"), body.data);
  if (!result.ok) return c.json({ success: false, error: result.error }, result.status);
  const order = result.data;
  // Only an invoice this activation created is news to the activity log.
  if (order.invoice_id && before?.quote_status !== "converted") {
    log(c, "created", "invoice", order.invoice_id, {
      invoice_number: order.invoice_number,
      order_id: order.id,
    });
  }
  return c.json(ok(order));
});

routes.post("/orders/:id/cancel", requirePermission("invoices", "update"), (c) => {
  const result = cancelOrder(c.req.param("id"));
  if (!result.ok) return c.json({ success: false, error: result.error }, result.status);
  return c.json(ok(result.data));
});

routes.delete("/orders/:id", requirePermission("invoices", "delete"), (c) => {
  const result = deleteOrder(c.req.param("id"));
  if (!result.ok) return c.json({ success: false, error: result.error }, result.status);
  return c.json(ok(result.data));
});

// --- Subscriptions -------------------------------------------------------------

const subscriptionSchema = z.object({
  customer_id: id,
  item_id: id.nullable().optional(),
  name: z.string().trim().min(1).max(200),
  reference: z.string().max(200).nullable().optional(),
  category: z.enum(CATEGORIES).optional(),
  price: amount,
  quantity: z.number().finite().positive().max(1e9).optional(),
  currency: currency.optional(),
  tax_id: id.nullable().optional(),
  interval_unit: z.enum(INTERVAL_UNITS),
  interval_count: z.number().int().min(1).max(120).optional(),
  start_date: isoDate.optional(),
  next_billing_date: isoDate,
  end_date: isoDate.nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});
const subscriptionUpdateSchema = subscriptionSchema.omit({ customer_id: true }).partial();

routes.get("/subscriptions", requirePermission("invoices", "read"), (c) => {
  const status = c.req.query("status");
  const dueWithin = Number.parseInt(c.req.query("due_within") ?? "", 10);
  return c.json(
    ok(
      listSubscriptions({
        status: (SUBSCRIPTION_STATUSES as readonly string[]).includes(status ?? "")
          ? (status as SubscriptionStatus)
          : undefined,
        customer_id: c.req.query("customer_id") || undefined,
        category: c.req.query("category") || undefined,
        search: c.req.query("search")?.trim() || undefined,
        due_within_days:
          Number.isFinite(dueWithin) && dueWithin >= 0 ? Math.min(dueWithin, 3650) : undefined,
      }),
    ),
  );
});

// Before /subscriptions/:id, so "summary" is never read as an id.
routes.get("/subscriptions/summary", requirePermission("invoices", "read"), (c) =>
  c.json(ok(getSummary())),
);

routes.get("/subscriptions/:id", requirePermission("invoices", "read"), (c) => {
  const sub = getSubscription(c.req.param("id"));
  if (!sub) return c.json({ success: false, error: "Subscription not found" }, 404);
  return c.json(ok(sub));
});

routes.get("/subscriptions/:id/history", requirePermission("invoices", "read"), (c) => {
  if (!getSubscription(c.req.param("id"))) {
    return c.json({ success: false, error: "Subscription not found" }, 404);
  }
  return c.json(ok(getHistory(c.req.param("id"))));
});

routes.post("/subscriptions", requirePermission("invoices", "create"), async (c) => {
  const body = await parse(c, subscriptionSchema);
  if (!body.ok) return c.json({ success: false, error: body.error }, 400);
  const result = createSubscription(body.data);
  if (!result.ok) return c.json({ success: false, error: result.error }, result.status);
  return c.json(ok(result.data), 201);
});

routes.put("/subscriptions/:id", requirePermission("invoices", "update"), async (c) => {
  const body = await parse(c, subscriptionUpdateSchema);
  if (!body.ok) return c.json({ success: false, error: body.error }, 400);
  const result = updateSubscription(c.req.param("id"), body.data);
  if (!result.ok) return c.json({ success: false, error: result.error }, result.status);
  return c.json(ok(result.data));
});

for (const [action, fn] of [
  ["pause", pauseSubscription],
  ["resume", (subId: string) => resumeSubscription(subId)],
  ["cancel", cancelSubscription],
] as const) {
  routes.post(`/subscriptions/:id/${action}`, requirePermission("invoices", "update"), (c) => {
    const result = fn(c.req.param("id"));
    if (!result.ok) return c.json({ success: false, error: result.error }, result.status);
    return c.json(ok(result.data));
  });
}

routes.delete("/subscriptions/:id", requirePermission("invoices", "delete"), (c) => {
  const result = deleteSubscription(c.req.param("id"));
  if (!result.ok) return c.json({ success: false, error: result.error }, result.status);
  return c.json(ok(result.data));
});

routes.post("/subscriptions/:id/bill", requirePermission("invoices", "create"), async (c) => {
  const result = await billNow(c.req.param("id"));
  if (!result.ok) return c.json({ success: false, error: result.error }, result.status);
  log(c, "created", "invoice", result.data.invoice_id, { subscription_id: c.req.param("id") });
  return c.json(ok(result.data), 201);
});

routes.post("/billing/run", requirePermission("invoices", "create"), async (c) => {
  const result = await runDueBilling();
  for (const invoiceId of result.invoices) log(c, "created", "invoice", invoiceId, {});
  return c.json(ok(result));
});

// --- Configuration -------------------------------------------------------------

const configSchema = z.object({
  lead_days: z.number().int().min(0).max(90).optional(),
  auto_send: z.boolean().optional(),
  bundle: z.boolean().optional(),
});

routes.get("/config", requirePermission("settings", "read"), (c) => c.json(ok(getConfig())));

routes.put("/config", requirePermission("settings", "update"), async (c) => {
  const body = await parse(c, configSchema);
  if (!body.ok) return c.json({ success: false, error: body.error }, 400);
  return c.json(ok(updateConfig(body.data)));
});

registerBackendPlugin({
  id: PLUGIN_ID,
  version: "1.0.0",
  routes,
  migrations: agencyServicesMigrations,
  meta: {
    name: "Agency Services",
    tagline: "Packages, add-ons and recurring client services for agencies.",
    description:
      "For web design, marketing, software and design agencies. Build a service catalog of packages with feature lists, add-ons paired to packages (optional or included, such as hosting free for the first year) and standalone services. Turn a package and its add-ons into a quotation or an invoice in one step. Track every client's recurring charges, such as domain names, web hosting, social media retainers and annual maintenance, with renewal invoices created ahead of each renewal date.",
    category: "billing",
    icon: "Briefcase",
  },
  onSchedule: async () => {
    await runDueBilling();
  },
});

// Typed client for the Agency Services plugin API
// (/api/v1/plugins/agency-services).

import { pluginFetch } from "../api";

const BASE = "/plugins/agency-services";

export const ITEM_KINDS = ["package", "addon", "service"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export type LineKind = ItemKind | "custom";
export type Billing = "one_time" | "recurring";
export type IntervalUnit = "month" | "year";
export type PairingMode = "optional" | "included";

export const CATEGORIES = [
  "web_design",
  "development",
  "marketing",
  "graphic_design",
  "hosting",
  "domains",
  "maintenance",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface PackageAddon {
  addon_id: string;
  mode: PairingMode;
  free_months: number;
}

export interface CatalogItem {
  id: string;
  kind: ItemKind;
  name: string;
  category: Category;
  description: string | null;
  features: string[];
  billing: Billing;
  price: number;
  setup_fee: number;
  interval_unit: IntervalUnit | null;
  interval_count: number;
  unit: string;
  tax_id: string | null;
  product_id: string | null;
  is_active: number;
  addons: PackageAddon[];
  packages: { id: string; name: string; mode: PairingMode }[];
}

export interface ItemInput {
  kind: ItemKind;
  name: string;
  category: Category;
  description: string | null;
  features: string[];
  billing: Billing;
  price: number;
  setup_fee: number;
  interval_unit: IntervalUnit | null;
  interval_count: number;
  unit: string;
  tax_id: string | null;
  is_active?: boolean;
}

export interface OrderLineInput {
  item_id: string | null;
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

export type OrderStatus = "quoted" | "active" | "cancelled";

export interface Order {
  id: string;
  customer_id: string;
  customer_name: string;
  status: OrderStatus;
  title: string;
  currency: string;
  lines: OrderLineInput[];
  initial_total: number;
  monthly_recurring: number;
  notes: string | null;
  quote_id: string | null;
  quote_number: string | null;
  quote_status: string | null;
  invoice_id: string | null;
  invoice_number: string | null;
  invoice_status: string | null;
  subscription_count: number;
  start_date: string | null;
  activated_at: string | null;
  created_at: string;
}

export interface CreateOrderInput {
  customer_id: string;
  currency: string;
  lines: OrderLineInput[];
  notes: string | null;
  mode: "quote" | "invoice";
  start_date?: string;
  exchange_rate?: number;
  valid_until?: string | null;
}

export type SubscriptionStatus = "active" | "paused" | "cancelled" | "ended";

export interface Subscription {
  id: string;
  customer_id: string;
  customer_name: string;
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
  end_date: string | null;
  status: SubscriptionStatus;
  notes: string | null;
  last_invoice_id: string | null;
  last_invoice_number: string | null;
  last_invoice_status: string | null;
  period_amount: number;
  monthly_value: number;
}

export interface SubscriptionInput {
  customer_id: string;
  item_id: string | null;
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
  end_date: string | null;
  notes: string | null;
}

export interface SubscriptionFilters {
  status?: SubscriptionStatus;
  customer_id?: string;
  category?: string;
  search?: string;
  due_within?: number;
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
  recurring: { currency: string; monthly: number; yearly: number; count: number }[];
  upcoming: { count: number; totals: CurrencyTotal[] };
  ready_to_invoice: number;
}

export interface BillingLogRow {
  id: string;
  invoice_id: string | null;
  period_start: string;
  period_end: string;
  amount: number;
  source: "schedule" | "manual" | "order";
  created_at: string;
  invoice_number: string | null;
  invoice_status: string | null;
  invoice_deleted_at: string | null;
}

export interface AgencyConfig {
  lead_days: number;
  auto_send: boolean;
  bundle: boolean;
}

type Ok<T> = { success: true; data: T };

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});

function qs(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => [k, String(v)]);
  return entries.length ? `?${new URLSearchParams(entries).toString()}` : "";
}

const data = <T>(p: Promise<Ok<T>>) => p.then((r) => r.data);

export const agencyApi = {
  listItems: (includeInactive = false) =>
    data(
      pluginFetch<Ok<CatalogItem[]>>(
        `${BASE}/items${includeInactive ? "?include_inactive=true" : ""}`,
      ),
    ),
  createItem: (input: ItemInput) =>
    data(pluginFetch<Ok<CatalogItem>>(`${BASE}/items`, json("POST", input))),
  updateItem: (id: string, input: Partial<Omit<ItemInput, "kind">>) =>
    data(pluginFetch<Ok<CatalogItem>>(`${BASE}/items/${id}`, json("PUT", input))),
  deleteItem: (id: string) => pluginFetch(`${BASE}/items/${id}`, json("DELETE")),
  duplicateItem: (id: string) =>
    data(pluginFetch<Ok<CatalogItem>>(`${BASE}/items/${id}/duplicate`, json("POST"))),
  setAddons: (id: string, addons: PackageAddon[]) =>
    data(pluginFetch<Ok<CatalogItem>>(`${BASE}/items/${id}/addons`, json("PUT", { addons }))),
  loadExamples: () => data(pluginFetch<Ok<CatalogItem[]>>(`${BASE}/items/examples`, json("POST"))),

  listOrders: (status?: OrderStatus) =>
    data(pluginFetch<Ok<Order[]>>(`${BASE}/orders${qs({ status })}`)),
  createOrder: (input: CreateOrderInput) =>
    data(pluginFetch<Ok<Order>>(`${BASE}/orders`, json("POST", input))),
  activateOrder: (id: string, body: { start_date: string; create_invoice: boolean }) =>
    data(pluginFetch<Ok<Order>>(`${BASE}/orders/${id}/activate`, json("POST", body))),
  cancelOrder: (id: string) =>
    data(pluginFetch<Ok<Order>>(`${BASE}/orders/${id}/cancel`, json("POST"))),
  deleteOrder: (id: string) => pluginFetch(`${BASE}/orders/${id}`, json("DELETE")),

  listSubscriptions: (filters: SubscriptionFilters = {}) =>
    data(pluginFetch<Ok<Subscription[]>>(`${BASE}/subscriptions${qs({ ...filters })}`)),
  summary: () => data(pluginFetch<Ok<SubscriptionSummary>>(`${BASE}/subscriptions/summary`)),
  history: (id: string) =>
    data(pluginFetch<Ok<BillingLogRow[]>>(`${BASE}/subscriptions/${id}/history`)),
  createSubscription: (input: SubscriptionInput) =>
    data(pluginFetch<Ok<Subscription>>(`${BASE}/subscriptions`, json("POST", input))),
  updateSubscription: (id: string, input: Partial<Omit<SubscriptionInput, "customer_id">>) =>
    data(pluginFetch<Ok<Subscription>>(`${BASE}/subscriptions/${id}`, json("PUT", input))),
  subscriptionAction: (id: string, action: "pause" | "resume" | "cancel") =>
    data(pluginFetch<Ok<Subscription>>(`${BASE}/subscriptions/${id}/${action}`, json("POST"))),
  deleteSubscription: (id: string) =>
    data(pluginFetch<Ok<{ deleted: boolean }>>(`${BASE}/subscriptions/${id}`, json("DELETE"))),
  billNow: (id: string) =>
    data(pluginFetch<Ok<{ invoice_id: string }>>(`${BASE}/subscriptions/${id}/bill`, json("POST"))),
  runBilling: () =>
    data(
      pluginFetch<Ok<{ invoices: string[]; periods: number; errors: number }>>(
        `${BASE}/billing/run`,
        json("POST"),
      ),
    ),

  getConfig: () => data(pluginFetch<Ok<AgencyConfig>>(`${BASE}/config`)),
  updateConfig: (body: Partial<AgencyConfig>) =>
    data(pluginFetch<Ok<AgencyConfig>>(`${BASE}/config`, json("PUT", body))),
};

// Service catalog: packages, add-ons and standalone services, their feature
// lists, and which add-ons each package offers. Each item keeps one core
// product in sync (name, price, unit, tax, active flag), so the lines this
// plugin writes carry a product_id and the core product reports group them,
// and the items can also be picked on a hand-made invoice.

import crypto from "node:crypto";
import { getDb } from "../../database/connection";
import { createProduct, getProduct, updateProduct } from "../../services/product.service";
import type { IntervalUnit } from "./periods";

export const ITEM_KINDS = ["package", "addon", "service"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const BILLING_TYPES = ["one_time", "recurring"] as const;
export type Billing = (typeof BILLING_TYPES)[number];

export const INTERVAL_UNITS = ["month", "year"] as const;

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

export const PAIRING_MODES = ["optional", "included"] as const;
export type PairingMode = (typeof PAIRING_MODES)[number];

export const MAX_FEATURES = 40;
export const MAX_FEATURE_LENGTH = 200;
/** Longest free period an included add-on may carry. */
export const MAX_FREE_MONTHS = 120;

interface ItemRow {
  id: string;
  kind: ItemKind;
  name: string;
  category: Category;
  description: string | null;
  features: string;
  billing: Billing;
  price: number;
  setup_fee: number;
  interval_unit: IntervalUnit | null;
  interval_count: number;
  unit: string;
  tax_id: string | null;
  product_id: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface PackageAddon {
  addon_id: string;
  mode: PairingMode;
  free_months: number;
}

export interface CatalogItem extends Omit<ItemRow, "features"> {
  features: string[];
  /** Packages: the add-ons this package offers. Empty for other kinds. */
  addons: PackageAddon[];
  /** Add-ons: the packages that offer it. Empty for other kinds. */
  packages: { id: string; name: string; mode: PairingMode }[];
}

export interface ItemInput {
  kind: ItemKind;
  name: string;
  category?: Category;
  description?: string | null;
  features?: string[];
  billing?: Billing;
  price?: number;
  setup_fee?: number;
  interval_unit?: IntervalUnit | null;
  interval_count?: number;
  unit?: string;
  tax_id?: string | null;
  is_active?: boolean;
}

export type ItemUpdate = Partial<Omit<ItemInput, "kind">>;

const newId = () => crypto.randomBytes(16).toString("hex");

/** The unit printed on a recurring line: "month", "year", "3 months". */
export function recurringUnit(unit: IntervalUnit, count: number): string {
  return count === 1 ? unit : `${count} ${unit}s`;
}

export function normalizeFeatures(list: string[]): string[] {
  return list
    .map((f) => f.trim().slice(0, MAX_FEATURE_LENGTH))
    .filter((f) => f !== "")
    .slice(0, MAX_FEATURES);
}

function parseFeatures(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === "string") : [];
  } catch {
    return [];
  }
}

const CATEGORY_ORDER = `CASE category ${CATEGORIES.map((c, i) => `WHEN '${c}' THEN ${i}`).join(" ")} ELSE 99 END`;

interface PairRow {
  package_id: string;
  addon_id: string;
  mode: PairingMode;
  free_months: number;
  package_name: string;
}

function hydrate(rows: ItemRow[]): CatalogItem[] {
  if (rows.length === 0) return [];
  const pairs = getDb()
    .query(
      `SELECT pa.package_id, pa.addon_id, pa.mode, pa.free_months, p.name AS package_name
       FROM agency_package_addons pa JOIN agency_items p ON p.id = pa.package_id
       ORDER BY p.price, p.name COLLATE NOCASE`,
    )
    .all() as PairRow[];

  return rows.map((row) => ({
    ...row,
    features: parseFeatures(row.features),
    addons:
      row.kind === "package"
        ? pairs
            .filter((p) => p.package_id === row.id)
            .map((p) => ({ addon_id: p.addon_id, mode: p.mode, free_months: p.free_months }))
        : [],
    packages:
      row.kind === "addon"
        ? pairs
            .filter((p) => p.addon_id === row.id)
            .map((p) => ({ id: p.package_id, name: p.package_name, mode: p.mode }))
        : [],
  }));
}

export function listItems(filters: { kind?: ItemKind; includeInactive?: boolean } = {}) {
  const conditions: string[] = [];
  const params: string[] = [];
  if (filters.kind) {
    conditions.push("kind = ?");
    params.push(filters.kind);
  }
  if (!filters.includeInactive) conditions.push("is_active = 1");
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = getDb()
    .query(
      `SELECT * FROM agency_items ${where}
       ORDER BY kind, ${CATEGORY_ORDER}, billing, price, name COLLATE NOCASE`,
    )
    .all(...params) as ItemRow[];
  return hydrate(rows);
}

function getRow(id: string): ItemRow | null {
  return getDb().query("SELECT * FROM agency_items WHERE id = ?").get(id) as ItemRow | null;
}

export function getItem(id: string): CatalogItem | null {
  const row = getRow(id);
  return row ? hydrate([row])[0] : null;
}

type Resolved = Omit<ItemRow, "id" | "kind" | "product_id" | "created_at" | "updated_at">;

function resolve(input: ItemUpdate, existing?: ItemRow): Resolved {
  const billing = input.billing ?? existing?.billing ?? "one_time";
  const recurring = billing === "recurring";
  const intervalUnit = recurring
    ? (input.interval_unit ?? existing?.interval_unit ?? "month")
    : null;
  const intervalCount = recurring
    ? Math.max(1, Math.floor(input.interval_count ?? existing?.interval_count ?? 1))
    : 1;
  const unit = recurring
    ? recurringUnit(intervalUnit as IntervalUnit, intervalCount)
    : (input.unit ?? existing?.unit ?? "").trim() || "piece";
  return {
    name: (input.name ?? existing?.name ?? "").trim(),
    category: input.category ?? existing?.category ?? "other",
    description:
      input.description !== undefined
        ? input.description?.trim() || null
        : (existing?.description ?? null),
    features: JSON.stringify(
      input.features !== undefined
        ? normalizeFeatures(input.features)
        : existing
          ? parseFeatures(existing.features)
          : [],
    ),
    billing,
    price: input.price ?? existing?.price ?? 0,
    setup_fee: recurring ? (input.setup_fee ?? existing?.setup_fee ?? 0) : 0,
    interval_unit: intervalUnit,
    interval_count: intervalCount,
    unit,
    tax_id: input.tax_id !== undefined ? input.tax_id || null : (existing?.tax_id ?? null),
    is_active:
      input.is_active !== undefined ? (input.is_active ? 1 : 0) : (existing?.is_active ?? 1),
  };
}

/** Create or update the core product mirroring this item. Returns its id. */
function syncProduct(item: Resolved, productId: string | null): string {
  const existing = productId ? getProduct(productId) : null;
  const data = {
    name: item.name,
    description: item.description,
    // Keep whatever SKU someone gave the product under Products.
    sku: existing?.sku ?? null,
    unit_price: item.price,
    unit: item.unit,
    category: "service",
    tax_id: item.tax_id,
    is_active: item.is_active,
  };
  if (existing) {
    updateProduct(existing.id, data);
    return existing.id;
  }
  return createProduct(data).id;
}

/** Remove the mirrored product, or retire it when a document still uses it. */
function retireProduct(productId: string): void {
  const db = getDb();
  const used = db
    .query(
      `SELECT (SELECT COUNT(*) FROM invoice_items WHERE product_id = ?)
            + (SELECT COUNT(*) FROM quote_items WHERE product_id = ?) AS n`,
    )
    .get(productId, productId) as { n: number };
  if (used.n === 0) {
    try {
      db.run("DELETE FROM products WHERE id = ?", [productId]);
      return;
    } catch {
      // Referenced from somewhere we did not count: fall back to retiring it.
    }
  }
  db.run("UPDATE products SET is_active = 0, updated_at = datetime('now') WHERE id = ?", [
    productId,
  ]);
}

export function createItem(input: ItemInput): CatalogItem {
  const db = getDb();
  const id = newId();
  db.transaction(() => {
    const item = resolve(input);
    const productId = syncProduct(item, null);
    db.run(
      `INSERT INTO agency_items (id, kind, name, category, description, features, billing, price,
         setup_fee, interval_unit, interval_count, unit, tax_id, product_id, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.kind,
        item.name,
        item.category,
        item.description,
        item.features,
        item.billing,
        item.price,
        item.setup_fee,
        item.interval_unit,
        item.interval_count,
        item.unit,
        item.tax_id,
        productId,
        item.is_active,
      ],
    );
  })();
  return getItem(id)!;
}

export function updateItem(id: string, input: ItemUpdate): CatalogItem | null {
  const existing = getRow(id);
  if (!existing) return null;
  const db = getDb();
  db.transaction(() => {
    const item = resolve(input, existing);
    const productId = syncProduct(item, existing.product_id);
    db.run(
      `UPDATE agency_items SET name = ?, category = ?, description = ?, features = ?, billing = ?,
         price = ?, setup_fee = ?, interval_unit = ?, interval_count = ?, unit = ?, tax_id = ?,
         product_id = ?, is_active = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [
        item.name,
        item.category,
        item.description,
        item.features,
        item.billing,
        item.price,
        item.setup_fee,
        item.interval_unit,
        item.interval_count,
        item.unit,
        item.tax_id,
        productId,
        item.is_active,
        id,
      ],
    );
    // A free period only means something for a recurring add-on.
    if (item.billing === "one_time") {
      db.run("UPDATE agency_package_addons SET free_months = 0 WHERE addon_id = ?", [id]);
    }
  })();
  return getItem(id);
}

/** Delete an item. Pairings go with it; subscriptions and orders keep their
 *  own copy of everything they need. */
export function deleteItem(id: string): boolean {
  const existing = getRow(id);
  if (!existing) return false;
  const db = getDb();
  db.transaction(() => {
    db.run("DELETE FROM agency_items WHERE id = ?", [id]);
    if (existing.product_id) retireProduct(existing.product_id);
  })();
  return true;
}

/** Copy an item (and a package's pairings), for building the next tier. */
export function duplicateItem(id: string): CatalogItem | null {
  const source = getItem(id);
  if (!source) return null;
  const copy = createItem({
    kind: source.kind,
    name: `${source.name} (copy)`,
    category: source.category,
    description: source.description,
    features: source.features,
    billing: source.billing,
    price: source.price,
    setup_fee: source.setup_fee,
    interval_unit: source.interval_unit,
    interval_count: source.interval_count,
    unit: source.unit,
    tax_id: source.tax_id,
    is_active: source.is_active === 1,
  });
  if (source.kind === "package" && source.addons.length > 0) {
    const paired = setPackageAddons(copy.id, source.addons);
    if (paired.ok) return paired.item;
  }
  return copy;
}

export type PairingResult = { ok: true; item: CatalogItem } | { ok: false; error: string };

/** Replace the add-ons a package offers. */
export function setPackageAddons(packageId: string, pairings: PackageAddon[]): PairingResult {
  const pkg = getRow(packageId);
  if (!pkg) return { ok: false, error: "Package not found" };
  if (pkg.kind !== "package") return { ok: false, error: "Only packages offer add-ons" };

  const db = getDb();
  const unique = new Map<string, PackageAddon>();
  for (const p of pairings) unique.set(p.addon_id, p);

  const rows: PackageAddon[] = [];
  for (const p of unique.values()) {
    const addon = getRow(p.addon_id);
    if (!addon || addon.kind !== "addon") return { ok: false, error: "Add-on not found" };
    const freeMonths =
      p.mode === "included" && addon.billing === "recurring"
        ? Math.min(MAX_FREE_MONTHS, Math.max(0, Math.floor(p.free_months)))
        : 0;
    rows.push({ addon_id: addon.id, mode: p.mode, free_months: freeMonths });
  }

  db.transaction(() => {
    db.run("DELETE FROM agency_package_addons WHERE package_id = ?", [packageId]);
    const insert = db.prepare(
      "INSERT INTO agency_package_addons (package_id, addon_id, mode, free_months) VALUES (?, ?, ?, ?)",
    );
    for (const r of rows) insert.run(packageId, r.addon_id, r.mode, r.free_months);
  })();
  return { ok: true, item: getItem(packageId)! };
}

/** Core product id for each catalog item id that still has one. */
export function productIdsFor(itemIds: string[]): Map<string, string> {
  const ids = [...new Set(itemIds)];
  if (ids.length === 0) return new Map();
  const rows = getDb()
    .query(
      `SELECT id, product_id FROM agency_items
       WHERE product_id IS NOT NULL AND id IN (${ids.map(() => "?").join(", ")})`,
    )
    .all(...ids) as { id: string; product_id: string }[];
  return new Map(rows.map((r) => [r.id, r.product_id]));
}

export function catalogIsEmpty(): boolean {
  const row = getDb().query("SELECT COUNT(*) AS n FROM agency_items").get() as { n: number };
  return row.n === 0;
}

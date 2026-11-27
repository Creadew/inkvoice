// Order-builder logic with no React in it: turning catalog items into order
// lines, and the totals the summary shows. The server builds the actual
// document; these mirror its rules (see orders.ts in the backend plugin) so
// the builder shows what the quote or invoice will bill.

import type { CatalogItem, IntervalUnit, OrderLineInput } from "./api";

/** An order line being edited. `parentKey` ties an included add-on to the
 *  package line it came with, so removing the package removes it too. */
export interface DraftLine extends OrderLineInput {
  key: string;
  parentKey: string | null;
}

let seq = 0;
/** Not crypto.randomUUID: that only exists on HTTPS, and self-hosted installs
 *  are often reached over plain HTTP on a LAN. */
export const nextKey = () => `line-${++seq}`;

/** Document text for an item: its name, then its features (or description). */
export function itemLineText(item: Pick<CatalogItem, "name" | "features" | "description">) {
  if (item.features.length > 0) return `${item.name} — ${item.features.join(" · ")}`;
  if (item.description) return `${item.name} — ${item.description}`;
  return item.name;
}

export function lineFromItem(
  item: CatalogItem,
  opts: { included?: boolean; freeMonths?: number; parentKey?: string | null } = {},
): DraftLine {
  const recurring = item.billing === "recurring";
  return {
    key: nextKey(),
    parentKey: opts.parentKey ?? null,
    item_id: item.id,
    kind: item.kind,
    category: item.category,
    name: item.name,
    // Add-ons and services that are only a name read better without the
    // feature list once they are one line among several.
    description: item.kind === "package" ? itemLineText(item) : item.name,
    quantity: 1,
    unit_price: item.price,
    unit: item.unit,
    tax_id: item.tax_id,
    billing: item.billing,
    interval_unit: recurring ? (item.interval_unit ?? "month") : null,
    interval_count: recurring ? item.interval_count : 1,
    setup_fee: recurring ? item.setup_fee : 0,
    free_months: recurring ? (opts.freeMonths ?? 0) : 0,
    reference: null,
    included: opts.included ?? false,
  };
}

/** A package's line followed by the add-ons it includes. */
export function packageBlock(pkg: CatalogItem, catalog: CatalogItem[]): DraftLine[] {
  const line = lineFromItem(pkg);
  const byId = new Map(catalog.map((i) => [i.id, i]));
  const included = pkg.addons
    .filter((a) => a.mode === "included")
    .map((a) => {
      const addon = byId.get(a.addon_id);
      return addon?.is_active
        ? lineFromItem(addon, { included: true, freeMonths: a.free_months, parentKey: line.key })
        : null;
    })
    .filter((l): l is DraftLine => l !== null);
  return [line, ...included];
}

export function customLine(): DraftLine {
  return {
    key: nextKey(),
    parentKey: null,
    item_id: null,
    kind: "custom",
    category: "other",
    name: "",
    description: "",
    quantity: 1,
    unit_price: 0,
    unit: "piece",
    tax_id: null,
    billing: "one_time",
    interval_unit: null,
    interval_count: 1,
    setup_fee: 0,
    free_months: 0,
    reference: null,
    included: false,
  };
}

/** Remove a line, and the included add-ons of a removed package. */
export function removeLine(lines: DraftLine[], key: string): DraftLine[] {
  return lines.filter((l) => l.key !== key && l.parentKey !== key);
}

/** Whether a line's own amount is on the first document. */
export function billsNow(line: OrderLineInput): boolean {
  if (line.billing === "recurring") return line.free_months === 0;
  return !line.included;
}

export function monthsIn(unit: IntervalUnit, count: number): number {
  return unit === "year" ? 12 * count : count;
}

/** YYYY-MM-DD plus whole months, on `anchorDay` clamped to the month's
 *  length (Jan 31 + 1 month = Feb 28). Same rule as the server. */
export function addMonthsIso(iso: string, months: number, anchorDay?: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = (((index % 12) + 12) % 12) + 1;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(anchorDay ?? d, days);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The first renewal date of the subscription a recurring line starts.
 *  `invoiced`: the order's first invoice bills this line's first period. */
export function firstRenewalDate(line: OrderLineInput, startDate: string, invoiced: boolean) {
  const anchor = Number(startDate.slice(8, 10));
  const months =
    invoiced && line.free_months === 0
      ? monthsIn(line.interval_unit ?? "month", line.interval_count)
      : line.free_months;
  return addMonthsIso(startDate, months, anchor);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface OrderTotals {
  /** What the first quote or invoice bills, before tax. */
  dueNow: number;
  /** Recurring lines expressed per month. */
  monthly: number;
  recurringCount: number;
}

export function orderTotals(lines: OrderLineInput[]): OrderTotals {
  let dueNow = 0;
  let monthly = 0;
  let recurringCount = 0;
  for (const l of lines) {
    const amount = l.quantity * l.unit_price;
    if (billsNow(l)) dueNow += amount;
    if (l.billing === "recurring") {
      dueNow += l.setup_fee;
      monthly += amount / monthsIn(l.interval_unit ?? "month", l.interval_count);
      recurringCount += 1;
    }
  }
  return { dueNow: round2(dueNow), monthly: round2(monthly), recurringCount };
}

/** The payload line, without the editor's bookkeeping. */
export function toPayload({ key: _key, parentKey: _parent, ...line }: DraftLine): OrderLineInput {
  return line;
}

// Calendar arithmetic for billing periods, on YYYY-MM-DD strings in UTC so no
// timezone can move a renewal date. Month addition clamps to the end of a
// shorter month and takes an anchor day, so a renewal on the 31st bills on
// Feb 28 and then on Mar 31 again rather than drifting to the 28th for good.

export type IntervalUnit = "month" | "year";

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

function parts(iso: string): [number, number, number] {
  const [y, m, d] = iso.split("-").map(Number);
  return [y, m, d];
}

function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = parts(value);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

export function dayOfMonth(iso: string): number {
  return parts(iso)[2];
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = parts(iso);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** `iso` plus `months`, on `anchorDay` (default: the day of `iso`) clamped to
 *  the length of the target month. */
export function addMonths(iso: string, months: number, anchorDay?: number): string {
  const [y, m, d] = parts(iso);
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month1 = (((index % 12) + 12) % 12) + 1;
  const day = Math.min(anchorDay ?? d, daysInMonth(year, month1));
  return `${pad(year, 4)}-${pad(month1)}-${pad(day)}`;
}

export function intervalMonths(unit: IntervalUnit, count: number): number {
  return unit === "year" ? 12 * count : count;
}

export function addInterval(
  iso: string,
  unit: IntervalUnit,
  count: number,
  anchorDay?: number,
): string {
  return addMonths(iso, intervalMonths(unit, count), anchorDay);
}

/** Last day of the period that starts on `start`. */
export function periodEnd(
  start: string,
  unit: IntervalUnit,
  count: number,
  anchorDay?: number,
): string {
  return addDays(addInterval(start, unit, count, anchorDay), -1);
}

/** A per-period amount expressed per month, for recurring-revenue totals. */
export function monthlyValue(amount: number, unit: IntervalUnit, count: number): number {
  return amount / intervalMonths(unit, count);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

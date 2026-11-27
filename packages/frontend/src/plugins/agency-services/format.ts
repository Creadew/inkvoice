// Display helpers shared by the plugin's pages. Every UI string lives under
// the agency_services i18n namespace; useAgencyT() saves repeating it.

import { useCallback } from "react";
import { useTranslation } from "@/i18n";
import { formatCurrency } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings.store";
import type { Billing, IntervalUnit } from "./api";

export type AgencyT = (key: string, params?: Record<string, string | number>) => string;

export function useAgencyT(): AgencyT {
  const { t } = useTranslation();
  return useCallback(
    (key: string, params?: Record<string, string | number>) => t(`agency_services.${key}`, params),
    [t],
  );
}

export function useBaseCurrency(): string {
  return useSettingsStore((s) => s.settings.base_currency || s.settings.currency) || "USD";
}

/** "per month", "per year", "every 3 months". */
export function intervalLabel(t: AgencyT, unit: IntervalUnit, count: number): string {
  if (count === 1) return t(unit === "year" ? "per_year" : "per_month");
  return t(unit === "year" ? "every_n_years" : "every_n_months", { count });
}

/** "first year free", "first 6 months free". */
export function freeLabel(t: AgencyT, months: number): string {
  if (months % 12 === 0) {
    const years = months / 12;
    return years === 1 ? t("free_first_year") : t("free_first_years", { count: years });
  }
  return months === 1 ? t("free_first_month") : t("free_first_months", { count: months });
}

interface Priced {
  billing: Billing;
  price: number;
  setup_fee: number;
  interval_unit: IntervalUnit | null;
  interval_count: number;
  unit: string;
}

/** "LKR 35,000.00 per month + LKR 10,000.00 setup", "LKR 5,000.00 per page". */
export function priceLabel(t: AgencyT, item: Priced, currency: string): string {
  const price = formatCurrency(item.price, currency);
  if (item.billing === "recurring") {
    const base = `${price} ${intervalLabel(t, item.interval_unit ?? "month", item.interval_count)}`;
    return item.setup_fee > 0
      ? `${base} + ${t("setup_amount", { amount: formatCurrency(item.setup_fee, currency) })}`
      : base;
  }
  if (item.unit && item.unit !== "piece" && item.unit !== "lump_sum") {
    return `${price} ${t("per_unit", { unit: item.unit })}`;
  }
  return `${price} ${t("one_time_suffix")}`;
}

/** Whole days from today (local) to an ISO date; negative when past. */
export function daysUntil(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  const target = Date.UTC(y, m - 1, d);
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86_400_000);
}

/** "in 12 days", "today", "3 days ago". */
export function relativeDays(t: AgencyT, iso: string): string {
  const days = daysUntil(iso);
  if (days === 0) return t("due_today");
  if (days > 0) return days === 1 ? t("in_one_day") : t("in_n_days", { count: days });
  return days === -1 ? t("one_day_ago") : t("n_days_ago", { count: -days });
}

/** Local YYYY-MM-DD, n days from today. */
export function isoInDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const STATUS_BADGE: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  quoted: "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400",
  paused: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  cancelled: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400",
  ended: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400",
};

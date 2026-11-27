// Client subscriptions: every recurring charge (domains, hosting, retainers,
// maintenance) with its renewal date, recurring revenue at the top, and the
// renewal invoices the plugin creates ahead of each renewal.

import {
  CalendarClock,
  FileText,
  History,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  Receipt,
  Trash2,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/api/client";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { EmptyState } from "@/components/shared/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCan } from "@/hooks/use-can";
import { useTranslation } from "@/i18n";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import {
  agencyApi,
  type BillingLogRow,
  CATEGORIES,
  type CatalogItem,
  type CurrencyTotal,
  type Subscription,
  type SubscriptionStatus,
  type SubscriptionSummary,
} from "./api";
import {
  type AgencyT,
  daysUntil,
  intervalLabel,
  relativeDays,
  STATUS_BADGE,
  useAgencyT,
} from "./format";
import type { TaxOption } from "./ItemDialog";
import { type CustomerOption, SubscriptionDialog } from "./SubscriptionDialog";

const STATUS_TABS = ["active", "paused", "ended", "cancelled", "all"] as const;
type StatusTab = (typeof STATUS_TABS)[number];

const DUE_WINDOWS = [30, 60, 90] as const;

function totalsText(totals: CurrencyTotal[]): string {
  return totals.map((x) => formatCurrency(x.amount, x.currency)).join(" + ") || "—";
}

export default function SubscriptionsPage() {
  const ta = useAgencyT();
  const can = useCan();
  const canCreate = can("invoices", "create");
  const canUpdate = can("invoices", "update");
  const canDelete = can("invoices", "delete");

  const [summary, setSummary] = useState<SubscriptionSummary | null>(null);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<StatusTab>("active");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [dueWithin, setDueWithin] = useState("");

  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [taxes, setTaxes] = useState<TaxOption[]>([]);

  const [editing, setEditing] = useState<{ sub: Subscription | null } | null>(null);
  const [history, setHistory] = useState<Subscription | null>(null);
  const [billing, setBilling] = useState<Subscription | null>(null);
  const [cancelling, setCancelling] = useState<Subscription | null>(null);
  const [deleting, setDeleting] = useState<Subscription | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, sum] = await Promise.all([
        agencyApi.listSubscriptions({
          status: status === "all" ? undefined : (status as SubscriptionStatus),
          search: search.trim() || undefined,
          category: category === "all" ? undefined : category,
          due_within: dueWithin ? Number(dueWithin) : undefined,
        }),
        agencyApi.summary(),
      ]);
      setSubs(list);
      setSummary(sum);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }, [status, search, category, dueWithin]);

  useEffect(() => {
    const timer = setTimeout(load, 200);
    return () => clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    api
      .listCustomers({ limit: "1000" })
      .then((r) => setCustomers((r.data.items ?? []) as CustomerOption[]))
      .catch(() => setCustomers([]));
    agencyApi
      .listItems()
      .then(setCatalog)
      .catch(() => setCatalog([]));
    api
      .listTaxDefinitions()
      .then((r) => setTaxes((r.data ?? []) as TaxOption[]))
      .catch(() => setTaxes([]));
  }, []);

  /** Run an action; `message` may depend on its result. */
  const act = async <T,>(fn: () => Promise<T>, message: string | ((result: T) => string)) => {
    setBusy(true);
    try {
      const result = await fn();
      toast.success(typeof message === "function" ? message(result) : message);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
      setBilling(null);
      setCancelling(null);
      setDeleting(null);
    }
  };

  const runBilling = async () => {
    setBusy(true);
    try {
      const result = await agencyApi.runBilling();
      if (result.invoices.length > 0) {
        toast.success(ta("billing_run_done", { count: result.invoices.length }));
      } else {
        toast.info(ta("billing_run_nothing"));
      }
      if (result.errors > 0) toast.error(ta("billing_run_errors", { count: result.errors }));
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const base = summary?.base_currency ?? "";
  const baseRecurring = summary?.recurring.find((r) => r.currency === base);
  const otherRecurring = summary?.recurring.filter((r) => r.currency !== base) ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <CalendarClock className="h-6 w-6 text-primary" />
            {ta("subscriptions_title")}
          </h1>
          <p className="text-sm text-muted-foreground">{ta("subscriptions_subtitle")}</p>
        </div>
        {canCreate && (
          <Button onClick={() => setEditing({ sub: null })}>
            <Plus className="mr-2 h-4 w-4" />
            {ta("new_subscription")}
          </Button>
        )}
      </div>

      {summary && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            label={ta("stat_mrr")}
            value={formatCurrency(baseRecurring?.monthly ?? 0, base)}
            hint={
              otherRecurring.length > 0
                ? `+ ${otherRecurring.map((r) => formatCurrency(r.monthly, r.currency)).join(" + ")}`
                : ta("stat_active_count", { count: summary.counts.active })
            }
          />
          <StatCard
            label={ta("stat_arr")}
            value={formatCurrency(baseRecurring?.yearly ?? 0, base)}
            hint={ta("stat_arr_hint")}
          />
          <StatCard
            label={ta("stat_upcoming")}
            value={String(summary.upcoming.count)}
            hint={totalsText(summary.upcoming.totals)}
          />
          <Card size="sm">
            <CardContent className="space-y-1.5">
              <div className="text-xs text-muted-foreground">{ta("stat_ready")}</div>
              <div className="text-lg font-semibold tabular-nums">{summary.ready_to_invoice}</div>
              <div className="text-xs text-muted-foreground">
                {ta(summary.auto_send ? "lead_hint_auto" : "lead_hint_draft", {
                  days: summary.lead_days,
                })}
              </div>
              {canCreate && summary.ready_to_invoice > 0 && (
                <Button size="sm" variant="outline" onClick={runBilling} disabled={busy}>
                  <Receipt className="mr-1 h-3.5 w-3.5" />
                  {ta("run_billing")}
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <Tabs value={status} onValueChange={(v) => setStatus(v as StatusTab)}>
          <TabsList>
            {STATUS_TABS.map((s) => (
              <TabsTrigger key={s} value={s}>
                {ta(`sub_tab_${s}`)}
                {summary && s !== "all" && (
                  <span className="ml-1 text-muted-foreground tabular-nums">
                    {summary.counts[s]}
                  </span>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="w-full sm:w-56"
            placeholder={ta("search_subscriptions")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            className="form-select w-auto"
            aria-label={ta("field_category")}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="all">{ta("all_categories")}</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {ta(`category_${c}`)}
              </option>
            ))}
          </select>
          <select
            className="form-select w-auto"
            aria-label={ta("renewing_within")}
            value={dueWithin}
            onChange={(e) => setDueWithin(e.target.value)}
          >
            <option value="">{ta("renewing_any")}</option>
            {DUE_WINDOWS.map((d) => (
              <option key={d} value={d}>
                {ta("renewing_within_days", { count: d })}
              </option>
            ))}
          </select>
        </div>
      </div>

      {loaded && subs.length === 0 ? (
        <div className="glass-table-wrapper">
          <EmptyState
            icon={CalendarClock}
            title={ta("subscriptions_empty")}
            description={ta("subscriptions_empty_desc")}
            actionLabel={canCreate ? ta("new_subscription") : undefined}
            onAction={canCreate ? () => setEditing({ sub: null }) : undefined}
          />
        </div>
      ) : (
        <div className="glass-table-wrapper overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                {[
                  "col_client",
                  "col_service",
                  "col_amount",
                  "col_next_renewal",
                  "col_last_invoice",
                  "col_status",
                ].map((k) => (
                  <TableCell key={k} className="text-sm font-medium text-muted-foreground">
                    {ta(k)}
                  </TableCell>
                ))}
                <TableCell />
              </TableRow>
            </TableHeader>
            <TableBody>
              {subs.map((s) => {
                const running = s.status === "active" || s.status === "paused";
                const days = daysUntil(s.next_billing_date);
                return (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">
                      <Link to={`/customers/${s.customer_id}`} className="hover:underline">
                        {s.customer_name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <div>{s.name}</div>
                      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        {s.reference && <span className="font-mono">{s.reference}</span>}
                        <span>{ta(`category_${s.category}`)}</span>
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {formatCurrency(s.period_amount, s.currency)}
                      <div className="text-xs text-muted-foreground">
                        {intervalLabel(ta, s.interval_unit, s.interval_count)}
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {running ? (
                        <>
                          {formatDate(s.next_billing_date)}
                          <div
                            className={cn(
                              "text-xs",
                              days < 0
                                ? "text-destructive"
                                : days <= 30
                                  ? "text-amber-600 dark:text-amber-400"
                                  : "text-muted-foreground",
                            )}
                          >
                            {relativeDays(ta, s.next_billing_date)}
                          </div>
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm">
                      {s.last_invoice_id && s.last_invoice_number ? (
                        <Link
                          to={`/invoices/${s.last_invoice_id}`}
                          className="text-primary hover:underline"
                        >
                          {s.last_invoice_number}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className={STATUS_BADGE[s.status]}>
                        {ta(`sub_status_${s.status}`)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={<Button variant="ghost" size="icon-sm" />}
                          aria-label={ta("more_actions")}
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {canCreate && s.status === "active" && (
                            <DropdownMenuItem onClick={() => setBilling(s)}>
                              <FileText className="mr-2 h-4 w-4" />
                              {ta("bill_now")}
                            </DropdownMenuItem>
                          )}
                          {canUpdate && (
                            <DropdownMenuItem onClick={() => setEditing({ sub: s })}>
                              <Pencil className="mr-2 h-4 w-4" />
                              {ta("edit")}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem onClick={() => setHistory(s)}>
                            <History className="mr-2 h-4 w-4" />
                            {ta("billing_history")}
                          </DropdownMenuItem>
                          {canUpdate && s.status === "active" && (
                            <DropdownMenuItem
                              onClick={() =>
                                act(
                                  () => agencyApi.subscriptionAction(s.id, "pause"),
                                  ta("subscription_paused"),
                                )
                              }
                            >
                              <Pause className="mr-2 h-4 w-4" />
                              {ta("pause")}
                            </DropdownMenuItem>
                          )}
                          {canUpdate && s.status === "paused" && (
                            <DropdownMenuItem
                              onClick={() =>
                                act(
                                  () => agencyApi.subscriptionAction(s.id, "resume"),
                                  ta("subscription_resumed"),
                                )
                              }
                            >
                              <Play className="mr-2 h-4 w-4" />
                              {ta("resume")}
                            </DropdownMenuItem>
                          )}
                          {canUpdate && running && (
                            <DropdownMenuItem onClick={() => setCancelling(s)}>
                              <XCircle className="mr-2 h-4 w-4" />
                              {ta("cancel_subscription")}
                            </DropdownMenuItem>
                          )}
                          {canDelete && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                variant="destructive"
                                onClick={() => setDeleting(s)}
                              >
                                <Trash2 className="mr-2 h-4 w-4" />
                                {ta("delete")}
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <SubscriptionDialog
        open={editing !== null}
        subscription={editing?.sub ?? null}
        customers={customers}
        catalog={catalog}
        taxes={taxes}
        leadDays={summary?.lead_days ?? 14}
        onOpenChange={(o) => !o && setEditing(null)}
        onSaved={load}
      />
      <HistoryDialog subscription={history} ta={ta} onClose={() => setHistory(null)} />
      <ConfirmDialog
        open={billing !== null}
        onOpenChange={(o) => !o && setBilling(null)}
        title={ta("bill_now_title")}
        description={ta("bill_now_desc", {
          name: billing?.name ?? "",
          date: billing ? formatDate(billing.next_billing_date) : "",
        })}
        loading={busy}
        onConfirm={async () => {
          if (billing)
            await act(() => agencyApi.billNow(billing.id), ta("renewal_invoice_created"));
        }}
      />
      <ConfirmDialog
        open={cancelling !== null}
        onOpenChange={(o) => !o && setCancelling(null)}
        title={ta("cancel_subscription_title")}
        description={ta("cancel_subscription_desc")}
        variant="destructive"
        loading={busy}
        onConfirm={async () => {
          if (!cancelling) return;
          await act(
            () => agencyApi.subscriptionAction(cancelling.id, "cancel"),
            ta("subscription_cancelled"),
          );
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={ta("delete_subscription_title")}
        description={ta("delete_subscription_desc")}
        variant="destructive"
        loading={busy}
        onConfirm={async () => {
          if (!deleting) return;
          await act(
            () => agencyApi.deleteSubscription(deleting.id),
            (result) =>
              result.deleted ? ta("subscription_deleted") : ta("subscription_cancelled_instead"),
          );
        }}
      />
    </div>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card size="sm">
      <CardContent className="space-y-0.5">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="truncate text-lg font-semibold tabular-nums">{value}</div>
        {hint && <div className="truncate text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

function HistoryDialog({
  subscription,
  ta,
  onClose,
}: {
  subscription: Subscription | null;
  ta: AgencyT;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<BillingLogRow[] | null>(null);

  useEffect(() => {
    setRows(null);
    if (!subscription) return;
    agencyApi
      .history(subscription.id)
      .then(setRows)
      .catch((e) => {
        toast.error((e as Error).message);
        setRows([]);
      });
  }, [subscription]);

  return (
    <Dialog open={subscription !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {ta("billing_history")}: {subscription?.name}
            {subscription?.reference ? ` (${subscription.reference})` : ""}
          </DialogTitle>
        </DialogHeader>
        {rows === null ? (
          <p className="py-4 text-sm text-muted-foreground">{ta("loading")}</p>
        ) : rows.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">{ta("history_empty")}</p>
        ) : (
          <ul className="divide-y rounded-md border text-sm">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span>
                  {formatDate(r.period_start)} – {formatDate(r.period_end)}
                  <span className="block text-xs text-muted-foreground">
                    {ta(`source_${r.source}`)}
                  </span>
                </span>
                <span className="text-right">
                  <span className="block tabular-nums">
                    {formatCurrency(r.amount, subscription?.currency ?? "")}
                  </span>
                  {r.invoice_id && r.invoice_number && !r.invoice_deleted_at ? (
                    <Link
                      to={`/invoices/${r.invoice_id}`}
                      className="text-xs text-primary hover:underline"
                    >
                      {r.invoice_number}
                      {r.invoice_status && ` · ${t(`invoices.status_${r.invoice_status}`)}`}
                    </Link>
                  ) : (
                    <span className="text-xs text-muted-foreground">{ta("doc_deleted")}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

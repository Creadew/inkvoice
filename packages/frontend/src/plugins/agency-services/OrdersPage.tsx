// Orders built from the catalog. A quoted order waits for the client: once
// they accept, Activate converts the quotation into an invoice (or links the
// one it was already converted into) and starts the recurring services.

import { CirclePlay, MoreHorizontal, Plus, ShoppingBag, Trash2, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { EmptyState } from "@/components/shared/EmptyState";
import { FormField } from "@/components/shared/FormField";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCan } from "@/hooks/use-can";
import { useTranslation } from "@/i18n";
import { formatCurrency, formatDate } from "@/lib/utils";
import { agencyApi, type Order, type OrderStatus } from "./api";
import { type AgencyT, freeLabel, isoInDays, STATUS_BADGE, useAgencyT } from "./format";
import { firstRenewalDate } from "./lines";

const TABS = ["all", "quoted", "active", "cancelled"] as const;

export default function OrdersPage() {
  const ta = useAgencyT();
  const navigate = useNavigate();
  const { tab } = useParams<{ tab: string }>();
  const status = (TABS as readonly string[]).includes(tab ?? "")
    ? (tab as (typeof TABS)[number])
    : "all";
  const can = useCan();
  const canCreate = can("invoices", "create");
  const canUpdate = can("invoices", "update");
  const canDelete = can("invoices", "delete");

  const [orders, setOrders] = useState<Order[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [activating, setActivating] = useState<Order | null>(null);
  const [cancelling, setCancelling] = useState<Order | null>(null);
  const [deleting, setDeleting] = useState<Order | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setOrders(await agencyApi.listOrders(status === "all" ? undefined : (status as OrderStatus)));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(message);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
      setCancelling(null);
      setDeleting(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <ShoppingBag className="h-6 w-6 text-primary" />
            {ta("orders_title")}
          </h1>
          <p className="text-sm text-muted-foreground">{ta("orders_subtitle")}</p>
        </div>
        {canCreate && (
          <Button onClick={() => navigate("/agency/orders/new")}>
            <Plus className="mr-2 h-4 w-4" />
            {ta("new_order")}
          </Button>
        )}
      </div>

      <Tabs
        value={status}
        onValueChange={(v) => navigate(`/agency/orders/${v === "all" ? "" : v}`)}
      >
        <TabsList>
          {TABS.map((s) => (
            <TabsTrigger key={s} value={s}>
              {ta(`order_tab_${s}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {loaded && orders.length === 0 ? (
        <div className="glass-table-wrapper">
          <EmptyState
            icon={ShoppingBag}
            title={ta("orders_empty")}
            description={ta("orders_empty_desc")}
            actionLabel={canCreate ? ta("new_order") : undefined}
            onAction={canCreate ? () => navigate("/agency/orders/new") : undefined}
          />
        </div>
      ) : (
        <div className="glass-table-wrapper overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                {[
                  "col_date",
                  "col_client",
                  "col_order",
                  "col_first_document",
                  "col_recurring",
                  "col_documents",
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
              {orders.map((order) => {
                const recurring = order.lines.filter((l) => l.billing === "recurring").length;
                const canActivate = canCreate && order.status === "quoted";
                const canCancel = canUpdate && order.status !== "cancelled";
                const canRemove = canDelete && order.status !== "active";
                return (
                  <TableRow key={order.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDate(order.created_at.slice(0, 10))}
                    </TableCell>
                    <TableCell className="font-medium">
                      <Link to={`/customers/${order.customer_id}`} className="hover:underline">
                        {order.customer_name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <div>{order.title}</div>
                      <div className="text-xs text-muted-foreground">
                        {ta("lines_count", { count: order.lines.length })}
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {formatCurrency(order.initial_total, order.currency)}
                    </TableCell>
                    <TableCell className="text-sm">
                      {recurring > 0 ? (
                        <>
                          <div className="whitespace-nowrap tabular-nums">
                            {ta("monthly_equivalent", {
                              amount: formatCurrency(order.monthly_recurring, order.currency),
                            })}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {ta("recurring_count", { count: recurring })}
                            {order.subscription_count > 0 &&
                              ` · ${ta("subscriptions_started", { count: order.subscription_count })}`}
                          </div>
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="space-y-0.5 text-sm">
                      <DocLink
                        ta={ta}
                        kind="quote"
                        id={order.quote_id}
                        number={order.quote_number}
                        status={order.quote_status}
                      />
                      <DocLink
                        ta={ta}
                        kind="invoice"
                        id={order.invoice_id}
                        number={order.invoice_number}
                        status={order.invoice_status}
                      />
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className={STATUS_BADGE[order.status]}>
                        {ta(`order_status_${order.status}`)}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      {canActivate && (
                        <Button size="sm" variant="outline" onClick={() => setActivating(order)}>
                          <CirclePlay className="mr-1 h-3.5 w-3.5" />
                          {ta("activate")}
                        </Button>
                      )}
                      {(canCancel || canRemove) && (
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={<Button variant="ghost" size="icon-sm" />}
                            aria-label={ta("more_actions")}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {canCancel && (
                              <DropdownMenuItem onClick={() => setCancelling(order)}>
                                <XCircle className="mr-2 h-4 w-4" />
                                {ta("cancel_order")}
                              </DropdownMenuItem>
                            )}
                            {canRemove && (
                              <DropdownMenuItem
                                variant="destructive"
                                onClick={() => setDeleting(order)}
                              >
                                <Trash2 className="mr-2 h-4 w-4" />
                                {ta("delete")}
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <ActivateDialog
        order={activating}
        ta={ta}
        onOpenChange={(o) => !o && setActivating(null)}
        onDone={() => {
          setActivating(null);
          load();
        }}
      />
      <ConfirmDialog
        open={cancelling !== null}
        onOpenChange={(o) => !o && setCancelling(null)}
        title={ta("cancel_order_title")}
        description={
          cancelling?.status === "active" ? ta("cancel_active_order_desc") : ta("cancel_order_desc")
        }
        variant="destructive"
        loading={busy}
        onConfirm={async () => {
          if (cancelling)
            await act(() => agencyApi.cancelOrder(cancelling.id), ta("order_cancelled"));
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={ta("delete_order_title")}
        description={ta("delete_order_desc")}
        variant="destructive"
        loading={busy}
        onConfirm={async () => {
          if (deleting) await act(() => agencyApi.deleteOrder(deleting.id), ta("order_deleted"));
        }}
      />
    </div>
  );
}

function DocLink({
  ta,
  kind,
  id,
  number,
  status,
}: {
  ta: AgencyT;
  kind: "quote" | "invoice";
  id: string | null;
  number: string | null;
  status: string | null;
}) {
  const { t } = useTranslation();
  if (!id || !number) return null;
  const label = `${ta(kind === "quote" ? "doc_quote" : "doc_invoice")} ${number}`;
  const statusText =
    status === "deleted"
      ? ta("doc_deleted")
      : status
        ? t(`${kind === "quote" ? "quotes" : "invoices"}.status_${status}`)
        : null;
  return (
    <div className="flex items-center gap-1.5 whitespace-nowrap">
      {status === "deleted" ? (
        <span className="text-muted-foreground line-through">{label}</span>
      ) : (
        <Link
          to={`/${kind === "quote" ? "quotes" : "invoices"}/${id}`}
          className="text-primary hover:underline"
        >
          {label}
        </Link>
      )}
      {statusText && <span className="text-xs text-muted-foreground">({statusText})</span>}
    </div>
  );
}

function ActivateDialog({
  order,
  ta,
  onOpenChange,
  onDone,
}: {
  order: Order | null;
  ta: AgencyT;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [startDate, setStartDate] = useState(() => isoInDays(0));
  const [createInvoice, setCreateInvoice] = useState(true);
  const [saving, setSaving] = useState(false);

  const converted = order?.quote_status === "converted";
  const quoteGone = !order?.quote_id || order?.quote_status === "deleted";

  useEffect(() => {
    if (!order) return;
    setStartDate(isoInDays(0));
    setCreateInvoice(!quoteGone);
  }, [order, quoteGone]);

  if (!order) return null;
  const invoiced = converted || (!quoteGone && createInvoice);
  const recurring = order.lines.filter((l) => l.billing === "recurring");

  const activate = async () => {
    setSaving(true);
    try {
      const result = await agencyApi.activateOrder(order.id, {
        start_date: startDate,
        create_invoice: invoiced,
      });
      toast.success(ta("order_activated", { count: result.subscription_count }));
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{ta("activate_title", { title: order.title })}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          {converted ? (
            <p className="text-muted-foreground">
              {ta("activate_converted", { number: order.quote_number ?? "" })}
            </p>
          ) : quoteGone ? (
            <p className="text-amber-600 dark:text-amber-400">{ta("activate_quote_deleted")}</p>
          ) : (
            <label className="flex gap-2">
              <input
                type="checkbox"
                className="mt-0.5 accent-primary"
                checked={createInvoice}
                onChange={(e) => setCreateInvoice(e.target.checked)}
              />
              <span>
                {ta("activate_convert", { number: order.quote_number ?? "" })}
                <span className="block text-xs text-muted-foreground">
                  {ta("activate_convert_hint")}
                </span>
              </span>
            </label>
          )}

          <FormField label={ta("service_start")}>
            <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </FormField>

          {recurring.length > 0 ? (
            <div className="space-y-1.5">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {ta("activate_services")}
              </div>
              <ul className="divide-y rounded-md border">
                {recurring.map((l, i) => (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: order lines have no ids
                    key={i}
                    className="flex items-center justify-between gap-3 px-3 py-2"
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{l.name}</span>
                      {l.reference && (
                        <span className="block truncate text-xs text-muted-foreground">
                          {l.reference}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-right text-xs text-muted-foreground">
                      {l.free_months > 0 && (
                        <span className="block">{freeLabel(ta, l.free_months)}</span>
                      )}
                      {ta("first_renewal", {
                        date: formatDate(firstRenewalDate(l, startDate, invoiced)),
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-muted-foreground">{ta("activate_no_recurring")}</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {ta("cancel")}
          </Button>
          <Button onClick={activate} disabled={saving || !startDate}>
            {saving ? ta("saving") : ta("activate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

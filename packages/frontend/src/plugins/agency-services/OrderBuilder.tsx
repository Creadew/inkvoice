// Order builder: pick a client, one or more packages (their included add-ons
// come along), suggested add-ons, services and custom lines, then create a
// quotation (activated later, once accepted) or an invoice (services start
// at once). The summary shows what the first document bills and what recurs.

import { ArrowLeft, Check, Plus, ShoppingBag, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/api/client";
import { CurrencyCombobox } from "@/components/shared/CurrencyCombobox";
import { CustomerCombobox } from "@/components/shared/CustomerCombobox";
import { ExchangeRateField } from "@/components/shared/ExchangeRateField";
import { FormField } from "@/components/shared/FormField";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Textarea } from "@/components/ui/textarea";
import { cn, formatCurrency } from "@/lib/utils";
import { agencyApi, type CatalogItem, type IntervalUnit } from "./api";
import {
  type AgencyT,
  freeLabel,
  intervalLabel,
  isoInDays,
  priceLabel,
  useAgencyT,
  useBaseCurrency,
} from "./format";
import {
  billsNow,
  customLine,
  type DraftLine,
  lineFromItem,
  orderTotals,
  packageBlock,
  removeLine,
  toPayload,
} from "./lines";

interface CustomerOption {
  id: string;
  name: string;
  email: string | null;
  currency: string | null;
}

export default function OrderBuilder() {
  const ta = useAgencyT();
  const navigate = useNavigate();
  const baseCurrency = useBaseCurrency();

  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [currency, setCurrency] = useState(baseCurrency);
  const [exchangeRate, setExchangeRate] = useState(1);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [notes, setNotes] = useState("");
  const [mode, setMode] = useState<"quote" | "invoice">("quote");
  const [startDate, setStartDate] = useState(() => isoInDays(0));
  const [validUntil, setValidUntil] = useState(() => isoInDays(30));
  const [search, setSearch] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api
      .listCustomers({ limit: "1000" })
      .then((r) => setCustomers((r.data.items ?? []) as CustomerOption[]))
      .catch(() => setCustomers([]));
    agencyApi
      .listItems()
      .then(setCatalog)
      .catch((e) => toast.error((e as Error).message));
  }, []);

  const selectCustomer = (id: string) => {
    setCustomerId(id);
    setCurrency(customers.find((c) => c.id === id)?.currency || baseCurrency);
    setExchangeRate(1);
  };

  const packages = useMemo(() => catalog.filter((i) => i.kind === "package"), [catalog]);
  const selectedPackages = useMemo(
    () => new Set(lines.filter((l) => l.kind === "package").map((l) => l.item_id)),
    [lines],
  );

  const togglePackage = (pkg: CatalogItem) => {
    const existing = lines.find((l) => l.kind === "package" && l.item_id === pkg.id);
    setLines((ls) =>
      existing ? removeLine(ls, existing.key) : [...ls, ...packageBlock(pkg, catalog)],
    );
  };
  const addItem = (item: CatalogItem) => setLines((ls) => [...ls, lineFromItem(item)]);
  const update = (key: string, patch: Partial<DraftLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const picker = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matches = (i: CatalogItem) => !q || i.name.toLowerCase().includes(q);
    const suggestedIds = new Set<string>();
    for (const pkg of packages) {
      if (!selectedPackages.has(pkg.id)) continue;
      for (const a of pkg.addons) if (a.mode === "optional") suggestedIds.add(a.addon_id);
    }
    const added = new Set(lines.map((l) => l.item_id));
    const suggested = catalog.filter(
      (i) => suggestedIds.has(i.id) && !added.has(i.id) && matches(i),
    );
    return {
      suggested,
      addons: catalog.filter((i) => i.kind === "addon" && !suggested.includes(i) && matches(i)),
      services: catalog.filter((i) => i.kind === "service" && matches(i)),
    };
  }, [catalog, packages, selectedPackages, lines, search]);

  const totals = orderTotals(lines);
  const recurringLines = lines.filter((l) => l.billing === "recurring");
  const foreign = currency.toUpperCase() !== baseCurrency.toUpperCase();
  const money = (n: number) => formatCurrency(n, currency);

  const submit = async () => {
    if (!customerId) return toast.error(ta("error_no_customer"));
    if (lines.length === 0) return toast.error(ta("error_no_lines"));
    if (lines.some((l) => !l.name.trim())) return toast.error(ta("error_line_name"));
    setSubmitting(true);
    try {
      const order = await agencyApi.createOrder({
        customer_id: customerId,
        currency,
        notes: notes.trim() || null,
        mode,
        lines: lines.map(toPayload),
        ...(mode === "invoice"
          ? { start_date: startDate, ...(foreign ? { exchange_rate: exchangeRate } : {}) }
          : { valid_until: validUntil || null }),
      });
      if (order.quote_id) {
        toast.success(ta("quote_created", { number: order.quote_number ?? "" }));
        navigate(`/quotes/${order.quote_id}`);
      } else if (order.invoice_id) {
        toast.success(ta("invoice_created", { number: order.invoice_number ?? "" }));
        navigate(`/invoices/${order.invoice_id}`);
      } else {
        toast.success(ta("order_started"));
        navigate("/agency/subscriptions");
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          aria-label={ta("back")}
          onClick={() => navigate("/agency/orders")}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <ShoppingBag className="h-6 w-6 text-primary" />
            {ta("builder_title")}
          </h1>
          <p className="text-sm text-muted-foreground">{ta("builder_subtitle")}</p>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-5">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">{ta("step_client")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label={ta("customer")} required>
                  <CustomerCombobox
                    customers={customers}
                    value={customerId}
                    onChange={selectCustomer}
                  />
                </FormField>
                <FormField label={ta("currency")}>
                  <CurrencyCombobox value={currency} onChange={setCurrency} />
                </FormField>
              </div>
              {foreign && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  {ta("foreign_currency_note", { base: baseCurrency, currency })}
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">{ta("step_packages")}</CardTitle>
            </CardHeader>
            <CardContent>
              {packages.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {ta("no_packages_hint")}{" "}
                  <Link to="/agency/catalog/packages" className="text-primary hover:underline">
                    {ta("open_catalog")}
                  </Link>
                </p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {packages.map((pkg) => {
                    const selected = selectedPackages.has(pkg.id);
                    return (
                      <button
                        key={pkg.id}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => togglePackage(pkg)}
                        className={cn(
                          "relative rounded-lg border p-3 text-left transition-colors hover:bg-accent",
                          selected && "border-primary bg-primary/5 ring-1 ring-primary",
                        )}
                      >
                        {selected && (
                          <Check className="absolute right-2 top-2 h-4 w-4 text-primary" />
                        )}
                        <div className="pr-5 text-sm font-medium">{pkg.name}</div>
                        <div className="text-xs font-semibold tabular-nums text-muted-foreground">
                          {priceLabel(ta, pkg, baseCurrency)}
                        </div>
                        {pkg.features.length > 0 && (
                          <ul className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
                            {pkg.features.slice(0, 3).map((f) => (
                              <li key={f} className="truncate">
                                · {f}
                              </li>
                            ))}
                          </ul>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <CardTitle className="text-sm">{ta("step_extras")}</CardTitle>
              <Input
                className="h-7 w-44"
                placeholder={ta("search_catalog")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </CardHeader>
            <CardContent className="space-y-4">
              <PickerGroup
                title={ta("suggested_addons")}
                items={picker.suggested}
                currency={baseCurrency}
                ta={ta}
                onAdd={addItem}
                highlight
              />
              <PickerGroup
                title={ta("tab_addons")}
                items={picker.addons}
                currency={baseCurrency}
                ta={ta}
                onAdd={addItem}
              />
              <PickerGroup
                title={ta("tab_services")}
                items={picker.services}
                currency={baseCurrency}
                ta={ta}
                onAdd={addItem}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <CardTitle className="text-sm">{ta("step_lines")}</CardTitle>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setLines((ls) => [...ls, customLine()])}
              >
                <Plus className="mr-1 h-3.5 w-3.5" />
                {ta("add_custom_line")}
              </Button>
            </CardHeader>
            <CardContent className="space-y-3">
              {lines.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  {ta("no_lines_hint")}
                </p>
              ) : (
                lines.map((line) => (
                  <LineEditor
                    key={line.key}
                    line={line}
                    parentName={lines.find((l) => l.key === line.parentKey)?.name ?? ""}
                    currency={currency}
                    ta={ta}
                    onChange={(patch) => update(line.key, patch)}
                    onRemove={() => setLines((ls) => removeLine(ls, line.key))}
                  />
                ))
              )}
            </CardContent>
          </Card>
        </div>

        <div className="lg:sticky lg:top-4 lg:self-start">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">{ta("summary")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <div className="text-xs text-muted-foreground">{ta("due_now")}</div>
                <div className="text-2xl font-semibold tabular-nums">{money(totals.dueNow)}</div>
                <div className="text-xs text-muted-foreground">{ta("before_tax")}</div>
              </div>

              {recurringLines.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-xs text-muted-foreground">{ta("recurring_charges")}</div>
                  <ul className="space-y-1 text-sm">
                    {recurringLines.map((l) => (
                      <li key={l.key} className="flex justify-between gap-2">
                        <span className="min-w-0 truncate">
                          {l.name || ta("untitled_line")}
                          {l.free_months > 0 && (
                            <span className="text-xs text-muted-foreground">
                              {" "}
                              · {freeLabel(ta, l.free_months)}
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 text-right tabular-nums">
                          {money(l.quantity * l.unit_price)}
                          <span className="block text-xs text-muted-foreground">
                            {intervalLabel(ta, l.interval_unit ?? "month", l.interval_count)}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className="border-t pt-1.5 text-xs text-muted-foreground">
                    {ta("monthly_equivalent", { amount: money(totals.monthly) })}
                  </div>
                </div>
              )}

              <fieldset className="space-y-2">
                <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {ta("create_as")}
                </legend>
                {(["quote", "invoice"] as const).map((m) => (
                  <label
                    key={m}
                    className={cn(
                      "flex cursor-pointer gap-2 rounded-md border p-2 text-sm",
                      mode === m && "border-primary bg-primary/5",
                    )}
                  >
                    <input
                      type="radio"
                      name="agency-mode"
                      className="mt-0.5 accent-primary"
                      checked={mode === m}
                      onChange={() => setMode(m)}
                    />
                    <span>
                      <span className="font-medium">{ta(`mode_${m}`)}</span>
                      <span className="block text-xs text-muted-foreground">
                        {ta(`mode_${m}_hint`)}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>

              {mode === "quote" ? (
                <FormField label={ta("valid_until")}>
                  <Input
                    type="date"
                    value={validUntil}
                    onChange={(e) => setValidUntil(e.target.value)}
                  />
                </FormField>
              ) : (
                <>
                  <FormField label={ta("service_start")} hint={ta("service_start_hint")}>
                    <Input
                      type="date"
                      value={startDate}
                      onChange={(e) => setStartDate(e.target.value)}
                    />
                  </FormField>
                  <ExchangeRateField
                    fromCurrency={currency}
                    baseCurrency={baseCurrency}
                    rate={exchangeRate}
                    onChange={setExchangeRate}
                    amount={totals.dueNow}
                  />
                </>
              )}

              <FormField label={ta("notes")} hint={ta("notes_hint")}>
                <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
              </FormField>

              <Button className="w-full" onClick={submit} disabled={submitting}>
                {submitting
                  ? ta("creating")
                  : mode === "quote"
                    ? ta("create_quote")
                    : ta("create_invoice")}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function PickerGroup({
  title,
  items,
  currency,
  ta,
  onAdd,
  highlight,
}: {
  title: string;
  items: CatalogItem[];
  currency: string;
  ta: AgencyT;
  onAdd: (item: CatalogItem) => void;
  highlight?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <div
        className={cn("text-xs font-medium", highlight ? "text-primary" : "text-muted-foreground")}
      >
        {title}
      </div>
      <div className="divide-y rounded-md border">
        {items.map((item) => (
          <div key={item.id} className="flex items-center gap-3 px-3 py-1.5">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">{item.name}</div>
              <div className="text-xs text-muted-foreground">{priceLabel(ta, item, currency)}</div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              aria-label={ta("add_named", { name: item.name })}
              onClick={() => onAdd(item)}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              {ta("add")}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function LineEditor({
  line,
  parentName,
  currency,
  ta,
  onChange,
  onRemove,
}: {
  line: DraftLine;
  parentName: string;
  currency: string;
  ta: AgencyT;
  onChange: (patch: Partial<DraftLine>) => void;
  onRemove: () => void;
}) {
  const recurring = line.billing === "recurring";
  const printed = billsNow(line);
  const amount = formatCurrency(line.quantity * line.unit_price, currency);

  const setBilling = (billing: DraftLine["billing"]) =>
    onChange(
      billing === "recurring"
        ? { billing, interval_unit: "month", interval_count: 1 }
        : { billing, interval_unit: null, interval_count: 1, setup_fee: 0, free_months: 0 },
    );

  return (
    <div className={cn("space-y-2 rounded-lg border p-3", line.parentKey && "ml-4 border-dashed")}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="secondary">{ta(`kind_${line.kind}`)}</Badge>
        {line.included && (
          <Badge variant="outline">{ta("included_with", { name: parentName })}</Badge>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          aria-label={ta("remove_line")}
          title={ta("remove_line")}
          onClick={onRemove}
        >
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </div>

      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_5rem_9rem]">
        <Input
          aria-label={ta("line_name")}
          placeholder={ta("line_name")}
          value={line.name}
          maxLength={200}
          onChange={(e) => onChange({ name: e.target.value })}
        />
        <NumberInput
          aria-label={ta("quantity")}
          value={line.quantity}
          onValueChange={(v) => onChange({ quantity: v > 0 ? v : 1 })}
        />
        {line.included && !recurring ? (
          <div className="flex items-center text-sm text-muted-foreground">{ta("included")}</div>
        ) : (
          <NumberInput
            aria-label={recurring ? ta("field_price_period") : ta("unit_price")}
            value={line.unit_price}
            decimals={2}
            allowNegative={line.kind === "custom"}
            onValueChange={(v) => onChange({ unit_price: v })}
          />
        )}
      </div>

      {printed ? (
        <Textarea
          rows={2}
          aria-label={ta("line_description")}
          placeholder={ta("line_description")}
          value={line.description}
          onChange={(e) => onChange({ description: e.target.value })}
        />
      ) : (
        <p className="text-xs text-muted-foreground">
          {line.included && !recurring ? ta("listed_on_package") : ta("billed_after_free")}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        {line.kind === "custom" && (
          <select
            className="form-select h-7 w-auto"
            aria-label={ta("billing")}
            value={line.billing}
            onChange={(e) => setBilling(e.target.value as DraftLine["billing"])}
          >
            <option value="one_time">{ta("billing_one_time")}</option>
            <option value="recurring">{ta("billing_recurring")}</option>
          </select>
        )}
        {recurring ? (
          <>
            <span className="flex items-center gap-1.5">
              {ta("field_every")}
              <NumberInput
                className="h-7 w-12"
                aria-label={ta("interval_count")}
                value={line.interval_count}
                integer
                min={1}
                max={120}
                onValueChange={(v) => onChange({ interval_count: Math.max(1, v) })}
              />
              <select
                className="form-select h-7 w-auto"
                aria-label={ta("interval_unit")}
                value={line.interval_unit ?? "month"}
                onChange={(e) => onChange({ interval_unit: e.target.value as IntervalUnit })}
              >
                <option value="month">{ta("unit_months")}</option>
                <option value="year">{ta("unit_years")}</option>
              </select>
            </span>
            <span className="flex items-center gap-1.5">
              {ta("field_setup_fee")}
              <NumberInput
                className="h-7 w-24"
                aria-label={ta("field_setup_fee")}
                value={line.setup_fee}
                decimals={2}
                onValueChange={(v) => onChange({ setup_fee: v })}
              />
            </span>
            <span className="flex items-center gap-1.5">
              <NumberInput
                className="h-7 w-12"
                aria-label={ta("free_months_label")}
                value={line.free_months}
                integer
                max={120}
                onValueChange={(v) => onChange({ free_months: v })}
              />
              {ta("free_months_label")}
            </span>
            <Input
              className="h-7 w-48"
              aria-label={ta("reference")}
              placeholder={ta("reference_placeholder")}
              value={line.reference ?? ""}
              maxLength={200}
              onChange={(e) => onChange({ reference: e.target.value || null })}
            />
          </>
        ) : (
          <span className="flex items-center gap-1.5">
            {ta("field_unit")}
            <Input
              className="h-7 w-24"
              aria-label={ta("field_unit")}
              value={line.unit}
              maxLength={40}
              onChange={(e) => onChange({ unit: e.target.value })}
            />
          </span>
        )}
        <span className="ml-auto font-medium tabular-nums text-foreground">
          {line.included && !recurring
            ? ta("included")
            : recurring
              ? `${amount} ${intervalLabel(ta, line.interval_unit ?? "month", line.interval_count)}`
              : amount}
        </span>
      </div>
    </div>
  );
}

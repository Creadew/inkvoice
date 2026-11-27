// Create or edit a client subscription directly, e.g. to bring existing
// clients' domains, hosting and retainers over with their real renewal dates.
// Picking a catalog item fills in its name, price and interval.

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CurrencyCombobox } from "@/components/shared/CurrencyCombobox";
import { CustomerCombobox } from "@/components/shared/CustomerCombobox";
import { FormField } from "@/components/shared/FormField";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Textarea } from "@/components/ui/textarea";
import {
  agencyApi,
  CATEGORIES,
  type CatalogItem,
  type Category,
  type IntervalUnit,
  type Subscription,
} from "./api";
import { daysUntil, isoInDays, useAgencyT, useBaseCurrency } from "./format";
import type { TaxOption } from "./ItemDialog";

export interface CustomerOption {
  id: string;
  name: string;
  email: string | null;
  currency: string | null;
}

export function SubscriptionDialog({
  open,
  subscription,
  customers,
  catalog,
  taxes,
  leadDays,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  subscription: Subscription | null;
  customers: CustomerOption[];
  catalog: CatalogItem[];
  taxes: TaxOption[];
  leadDays: number;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const ta = useAgencyT();
  const baseCurrency = useBaseCurrency();
  const [customerId, setCustomerId] = useState("");
  const [itemId, setItemId] = useState("");
  const [name, setName] = useState("");
  const [reference, setReference] = useState("");
  const [category, setCategory] = useState<Category>("hosting");
  const [price, setPrice] = useState(0);
  const [quantity, setQuantity] = useState(1);
  const [currency, setCurrency] = useState(baseCurrency);
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>("year");
  const [intervalCount, setIntervalCount] = useState(1);
  const [startDate, setStartDate] = useState("");
  const [nextDate, setNextDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [taxId, setTaxId] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const recurringItems = useMemo(
    () => catalog.filter((i) => i.billing === "recurring" && i.is_active),
    [catalog],
  );

  useEffect(() => {
    if (!open) return;
    const s = subscription;
    setCustomerId(s?.customer_id ?? "");
    setItemId(s?.item_id ?? "");
    setName(s?.name ?? "");
    setReference(s?.reference ?? "");
    setCategory(s?.category ?? "hosting");
    setPrice(s?.price ?? 0);
    setQuantity(s?.quantity ?? 1);
    setCurrency(s?.currency ?? baseCurrency);
    setIntervalUnit(s?.interval_unit ?? "year");
    setIntervalCount(s?.interval_count ?? 1);
    setStartDate(s?.start_date ?? isoInDays(0));
    setNextDate(s?.next_billing_date ?? isoInDays(0));
    setEndDate(s?.end_date ?? "");
    setTaxId(s?.tax_id ?? "");
    setNotes(s?.notes ?? "");
  }, [open, subscription, baseCurrency]);

  const pickItem = (id: string) => {
    setItemId(id);
    const item = catalog.find((i) => i.id === id);
    if (!item) return;
    setName(item.name);
    setCategory(item.category);
    setPrice(item.price);
    setIntervalUnit(item.interval_unit ?? "month");
    setIntervalCount(item.interval_count);
    setTaxId(item.tax_id ?? "");
  };

  const pickCustomer = (id: string) => {
    setCustomerId(id);
    setCurrency(customers.find((c) => c.id === id)?.currency || baseCurrency);
  };

  const past = nextDate !== "" && daysUntil(nextDate) < 0;
  const valid = customerId && name.trim() && nextDate && startDate;

  const save = async () => {
    if (!valid) return;
    setSaving(true);
    const fields = {
      item_id: itemId || null,
      name: name.trim(),
      reference: reference.trim() || null,
      category,
      price,
      quantity,
      currency,
      tax_id: taxId || null,
      interval_unit: intervalUnit,
      interval_count: intervalCount,
      start_date: startDate,
      next_billing_date: nextDate,
      end_date: endDate || null,
      notes: notes.trim() || null,
    };
    try {
      if (subscription) await agencyApi.updateSubscription(subscription.id, fields);
      else await agencyApi.createSubscription({ customer_id: customerId, ...fields });
      toast.success(ta("subscription_saved"));
      onOpenChange(false);
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {subscription ? ta("edit_subscription") : ta("new_subscription")}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={ta("customer")} required>
              {subscription ? (
                <Input value={subscription.customer_name} disabled />
              ) : (
                <CustomerCombobox
                  customers={customers}
                  value={customerId}
                  onChange={pickCustomer}
                />
              )}
            </FormField>
            <FormField label={ta("from_catalog")} hint={ta("from_catalog_hint")}>
              <select
                className="form-select"
                value={itemId}
                onChange={(e) => pickItem(e.target.value)}
              >
                <option value="">{ta("custom_service")}</option>
                {recurringItems.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </FormField>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <FormField label={ta("field_name")} required className="sm:col-span-2">
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
            </FormField>
            <FormField label={ta("field_category")}>
              <select
                className="form-select"
                value={category}
                onChange={(e) => setCategory(e.target.value as Category)}
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {ta(`category_${c}`)}
                  </option>
                ))}
              </select>
            </FormField>
          </div>

          <FormField label={ta("reference")} hint={ta("reference_hint")}>
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder={ta("reference_placeholder")}
              maxLength={200}
            />
          </FormField>

          <div className="grid gap-4 sm:grid-cols-4">
            <FormField label={ta("field_price_period")} required>
              <NumberInput value={price} decimals={2} onValueChange={setPrice} />
            </FormField>
            <FormField label={ta("quantity")}>
              <NumberInput value={quantity} onValueChange={(v) => setQuantity(v > 0 ? v : 1)} />
            </FormField>
            <FormField label={ta("field_every")} className="sm:col-span-2">
              <div className="flex gap-2">
                <NumberInput
                  className="w-16"
                  value={intervalCount}
                  min={1}
                  max={120}
                  integer
                  onValueChange={(v) => setIntervalCount(Math.max(1, v))}
                />
                <select
                  className="form-select"
                  value={intervalUnit}
                  onChange={(e) => setIntervalUnit(e.target.value as IntervalUnit)}
                >
                  <option value="month">{ta("unit_months")}</option>
                  <option value="year">{ta("unit_years")}</option>
                </select>
              </div>
            </FormField>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <FormField label={ta("start_date")}>
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </FormField>
            <FormField
              label={ta("next_renewal")}
              required
              hint={ta("next_renewal_hint", { days: leadDays })}
            >
              <Input type="date" value={nextDate} onChange={(e) => setNextDate(e.target.value)} />
            </FormField>
            <FormField label={ta("end_date")} hint={ta("end_date_hint")}>
              <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </FormField>
          </div>
          {past && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {ta("past_renewal_warning")}
            </p>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={ta("currency")}>
              <CurrencyCombobox value={currency} onChange={setCurrency} />
            </FormField>
            {taxes.length > 0 && (
              <FormField label={ta("field_tax")}>
                <select
                  className="form-select"
                  value={taxId}
                  onChange={(e) => setTaxId(e.target.value)}
                >
                  <option value="">{ta("no_tax")}</option>
                  {taxes.map((tx) => (
                    <option key={tx.id} value={tx.id}>
                      {tx.name} ({tx.rate}%)
                    </option>
                  ))}
                </select>
              </FormField>
            )}
          </div>

          <FormField label={ta("internal_notes")}>
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </FormField>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {ta("cancel")}
          </Button>
          <Button onClick={save} disabled={saving || !valid}>
            {saving ? ta("saving") : ta("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

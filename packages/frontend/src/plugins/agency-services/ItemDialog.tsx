// Create or edit a catalog item. Features are typed one per line. A package
// also chooses which add-ons it offers: optional, or included (a recurring
// included add-on carries a free period, after which it is billed).

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
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
  type Billing,
  CATEGORIES,
  type CatalogItem,
  type Category,
  type IntervalUnit,
  type ItemKind,
  type PairingMode,
} from "./api";
import { priceLabel, useAgencyT } from "./format";

export interface TaxOption {
  id: string;
  name: string;
  rate: number;
}

type PairChoice = { mode: "none" | PairingMode; free_months: number };

const UNIT_SUGGESTIONS = ["piece", "page", "post", "screen", "hour", "day", "lump_sum"];
const DEFAULT_FREE_MONTHS = 12;

export function ItemDialog({
  open,
  kind,
  item,
  addons,
  taxes,
  currency,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  kind: ItemKind;
  item: CatalogItem | null;
  /** Every add-on in the catalog, for a package's pairings. */
  addons: CatalogItem[];
  taxes: TaxOption[];
  currency: string;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const ta = useAgencyT();
  const [name, setName] = useState("");
  const [category, setCategory] = useState<Category>("web_design");
  const [description, setDescription] = useState("");
  const [featuresText, setFeaturesText] = useState("");
  const [billing, setBilling] = useState<Billing>("one_time");
  const [price, setPrice] = useState(0);
  const [setupFee, setSetupFee] = useState(0);
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>("month");
  const [intervalCount, setIntervalCount] = useState(1);
  const [unit, setUnit] = useState("piece");
  const [taxId, setTaxId] = useState("");
  const [pairings, setPairings] = useState<Record<string, PairChoice>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(item?.name ?? "");
    setCategory(item?.category ?? "web_design");
    setDescription(item?.description ?? "");
    setFeaturesText((item?.features ?? []).join("\n"));
    setBilling(item?.billing ?? "one_time");
    setPrice(item?.price ?? 0);
    setSetupFee(item?.setup_fee ?? 0);
    setIntervalUnit(item?.interval_unit ?? (kind === "addon" ? "year" : "month"));
    setIntervalCount(item?.interval_count ?? 1);
    setUnit(item && item.billing === "one_time" ? item.unit : "piece");
    setTaxId(item?.tax_id ?? "");
    setPairings(
      Object.fromEntries(
        (item?.addons ?? []).map((a) => [a.addon_id, { mode: a.mode, free_months: a.free_months }]),
      ),
    );
  }, [open, item, kind]);

  // Archived add-ons stay listed while paired, so saving never drops them silently.
  const pairable = useMemo(
    () => addons.filter((a) => a.is_active || pairings[a.id]?.mode),
    [addons, pairings],
  );

  const setPair = (addon: CatalogItem, mode: PairChoice["mode"]) =>
    setPairings((p) => ({
      ...p,
      [addon.id]: {
        mode,
        free_months:
          mode === "included" && addon.billing === "recurring"
            ? (p[addon.id]?.free_months ?? DEFAULT_FREE_MONTHS) || DEFAULT_FREE_MONTHS
            : 0,
      },
    }));

  const recurring = billing === "recurring";

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const fields = {
        name: name.trim(),
        category,
        description: description.trim() || null,
        features: featuresText
          .split("\n")
          .map((f) => f.trim())
          .filter(Boolean),
        billing,
        price,
        setup_fee: recurring ? setupFee : 0,
        interval_unit: recurring ? intervalUnit : null,
        interval_count: recurring ? intervalCount : 1,
        unit: unit.trim() || "piece",
        tax_id: taxId || null,
      };
      const saved = item
        ? await agencyApi.updateItem(item.id, fields)
        : await agencyApi.createItem({ kind, ...fields });
      if (kind === "package") {
        await agencyApi.setAddons(
          saved.id,
          Object.entries(pairings)
            .filter(([, p]) => p.mode !== "none")
            .map(([addon_id, p]) => ({
              addon_id,
              mode: p.mode as PairingMode,
              free_months: p.free_months,
            })),
        );
      }
      toast.success(ta("item_saved"));
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
          <DialogTitle>{ta(item ? `edit_${kind}` : `new_${kind}`)}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
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

          <FormField label={ta("field_features")} hint={ta("field_features_hint")}>
            <Textarea
              rows={kind === "package" ? 6 : 3}
              value={featuresText}
              onChange={(e) => setFeaturesText(e.target.value)}
              placeholder={ta(`features_placeholder_${kind}`)}
            />
          </FormField>

          <FormField label={ta("field_description")} hint={ta("field_description_hint")}>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
            />
          </FormField>

          <div className="space-y-3 rounded-lg border p-3">
            <div className="flex flex-wrap gap-4 text-sm">
              {(["one_time", "recurring"] as const).map((b) => (
                <label key={b} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="agency-billing"
                    checked={billing === b}
                    onChange={() => setBilling(b)}
                    className="accent-primary"
                  />
                  {ta(`billing_${b}`)}
                </label>
              ))}
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <FormField label={recurring ? ta("field_price_period") : ta("field_price")}>
                <NumberInput value={price} decimals={2} onValueChange={setPrice} />
              </FormField>
              {recurring ? (
                <>
                  <FormField label={ta("field_every")}>
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
                  <FormField label={ta("field_setup_fee")} hint={ta("field_setup_fee_hint")}>
                    <NumberInput value={setupFee} decimals={2} onValueChange={setSetupFee} />
                  </FormField>
                </>
              ) : (
                <FormField label={ta("field_unit")} hint={ta("field_unit_hint")}>
                  <Input
                    list="agency-units"
                    value={unit}
                    onChange={(e) => setUnit(e.target.value)}
                    maxLength={40}
                  />
                </FormField>
              )}
            </div>
            <datalist id="agency-units">
              {UNIT_SUGGESTIONS.map((u) => (
                <option key={u} value={u} />
              ))}
            </datalist>
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

          {kind === "package" && (
            <div className="space-y-2">
              <div>
                <h3 className="text-sm font-medium">{ta("pairing_title")}</h3>
                <p className="text-xs text-muted-foreground">{ta("pairing_hint")}</p>
              </div>
              {pairable.length === 0 ? (
                <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                  {ta("pairing_empty")}
                </p>
              ) : (
                <div className="divide-y rounded-md border">
                  {pairable.map((addon) => {
                    const choice = pairings[addon.id] ?? { mode: "none", free_months: 0 };
                    const freeEditable =
                      choice.mode === "included" && addon.billing === "recurring";
                    return (
                      <div key={addon.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm">{addon.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {priceLabel(ta, addon, currency)}
                          </div>
                        </div>
                        <select
                          className="form-select w-36"
                          aria-label={ta("pairing_mode_label", { name: addon.name })}
                          value={choice.mode}
                          onChange={(e) => setPair(addon, e.target.value as PairChoice["mode"])}
                        >
                          <option value="none">{ta("pairing_none")}</option>
                          <option value="optional">{ta("pairing_optional")}</option>
                          <option value="included">{ta("pairing_included")}</option>
                        </select>
                        {freeEditable && (
                          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <NumberInput
                              className="w-16"
                              aria-label={`${addon.name}: ${ta("free_months_label")}`}
                              value={choice.free_months}
                              integer
                              max={120}
                              onValueChange={(v) =>
                                setPairings((p) => ({
                                  ...p,
                                  [addon.id]: { mode: "included", free_months: v },
                                }))
                              }
                            />
                            {ta("free_months_label")}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {ta("cancel")}
          </Button>
          <Button onClick={save} disabled={saving || !name.trim()}>
            {saving ? ta("saving") : ta("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

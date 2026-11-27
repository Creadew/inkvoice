// Service catalog: packages, add-ons and standalone services in three tabs,
// grouped by category. Packages show their feature list and the add-ons they
// include or offer; add-ons show the packages that offer them.

import {
  Archive,
  ArchiveRestore,
  Check,
  Copy,
  Layers,
  Pencil,
  Plus,
  ShoppingBag,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/api/client";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { EmptyState } from "@/components/shared/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCan } from "@/hooks/use-can";
import { cn } from "@/lib/utils";
import { agencyApi, CATEGORIES, type CatalogItem, type ItemKind } from "./api";
import { type AgencyT, freeLabel, priceLabel, useAgencyT, useBaseCurrency } from "./format";
import { ItemDialog, type TaxOption } from "./ItemDialog";

const TABS: { kind: ItemKind; segment: string }[] = [
  { kind: "package", segment: "packages" },
  { kind: "addon", segment: "addons" },
  { kind: "service", segment: "services" },
];

const MAX_FEATURES_SHOWN = 6;

export default function CatalogPage() {
  const ta = useAgencyT();
  const navigate = useNavigate();
  const { tab } = useParams<{ tab: string }>();
  const active = TABS.find((x) => x.segment === tab) ?? TABS[0];
  const currency = useBaseCurrency();
  const can = useCan();
  const canCreate = can("products", "create");
  const canEdit = can("products", "update");
  const canDelete = can("products", "delete");
  const canSell = can("invoices", "create");

  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [taxes, setTaxes] = useState<TaxOption[]>([]);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<{ item: CatalogItem | null } | null>(null);
  const [deleting, setDeleting] = useState<CatalogItem | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems(await agencyApi.listItems(true));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
    api
      .listTaxDefinitions()
      .then((r) =>
        setTaxes(
          ((r.data ?? []) as (TaxOption & { is_active?: number })[]).filter(
            (tx) => tx.is_active !== 0,
          ),
        ),
      )
      .catch(() => setTaxes([]));
  }, [load]);

  const counts = useMemo(() => {
    const c: Record<ItemKind, number> = { package: 0, addon: 0, service: 0 };
    for (const i of items) if (i.is_active) c[i.kind] += 1;
    return c;
  }, [items]);

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const addons = useMemo(() => items.filter((i) => i.kind === "addon"), [items]);

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const visible = items.filter(
      (i) =>
        i.kind === active.kind &&
        (showArchived || i.is_active) &&
        (category === "all" || i.category === category) &&
        (!q ||
          i.name.toLowerCase().includes(q) ||
          i.features.some((f) => f.toLowerCase().includes(q))),
    );
    return CATEGORIES.map((c) => ({
      category: c,
      items: visible.filter((i) => i.category === c),
    })).filter((g) => g.items.length > 0);
  }, [items, active.kind, showArchived, category, search]);

  const run = async (fn: () => Promise<unknown>, message: string) => {
    try {
      await fn();
      toast.success(message);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const loadExamples = async () => {
    setBusy(true);
    await run(() => agencyApi.loadExamples(), ta("examples_loaded"));
    setBusy(false);
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    await run(() => agencyApi.deleteItem(deleting.id), ta("item_deleted"));
    setBusy(false);
    setDeleting(null);
  };

  const catalogEmpty = loaded && items.length === 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Layers className="h-6 w-6 text-primary" />
            {ta("catalog_title")}
          </h1>
          <p className="text-sm text-muted-foreground">{ta("catalog_subtitle")}</p>
        </div>
        <div className="flex gap-2">
          {canSell && !catalogEmpty && (
            <Button variant="outline" onClick={() => navigate("/agency/orders/new")}>
              <ShoppingBag className="mr-2 h-4 w-4" />
              {ta("new_order")}
            </Button>
          )}
          {canCreate && (
            <Button onClick={() => setEditing({ item: null })}>
              <Plus className="mr-2 h-4 w-4" />
              {ta(`new_${active.kind}`)}
            </Button>
          )}
        </div>
      </div>

      <Tabs value={active.segment} onValueChange={(v) => navigate(`/agency/catalog/${v}`)}>
        <TabsList>
          {TABS.map((x) => (
            <TabsTrigger key={x.segment} value={x.segment}>
              {ta(`tab_${x.segment}`)}
              <span className="ml-1 text-muted-foreground tabular-nums">{counts[x.kind]}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <p className="text-sm text-muted-foreground">{ta(`tab_${active.segment}_hint`)}</p>

      {catalogEmpty ? (
        <Card>
          <EmptyState
            icon={Sparkles}
            title={ta("catalog_empty_title")}
            description={ta("catalog_empty_desc")}
            actionLabel={canCreate ? ta("load_examples") : undefined}
            onAction={canCreate && !busy ? loadExamples : undefined}
          />
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="w-full sm:w-64"
              placeholder={ta("search_catalog")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              className="form-select w-auto"
              value={category}
              aria-label={ta("field_category")}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="all">{ta("all_categories")}</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {ta(`category_${c}`)}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                className="accent-primary"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
              />
              {ta("show_archived")}
            </label>
          </div>

          {loaded && groups.length === 0 && (
            <Card>
              <EmptyState
                icon={Layers}
                title={ta(`empty_${active.kind}`)}
                actionLabel={canCreate ? ta(`new_${active.kind}`) : undefined}
                onAction={canCreate ? () => setEditing({ item: null }) : undefined}
              />
            </Card>
          )}

          {groups.map((g) => (
            <section key={g.category} className="space-y-2">
              <h2 className="font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                {ta(`category_${g.category}`)}
              </h2>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {g.items.map((item) => (
                  <ItemCard
                    key={item.id}
                    item={item}
                    byId={byId}
                    currency={currency}
                    ta={ta}
                    actions={
                      <>
                        {canEdit && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title={ta("edit")}
                            aria-label={ta("edit")}
                            onClick={() => setEditing({ item })}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                        )}
                        {canCreate && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title={ta("duplicate")}
                            aria-label={ta("duplicate")}
                            onClick={() =>
                              run(() => agencyApi.duplicateItem(item.id), ta("item_duplicated"))
                            }
                          >
                            <Copy className="h-4 w-4" />
                          </Button>
                        )}
                        {canEdit && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title={item.is_active ? ta("archive") : ta("restore")}
                            aria-label={item.is_active ? ta("archive") : ta("restore")}
                            onClick={() =>
                              run(
                                () => agencyApi.updateItem(item.id, { is_active: !item.is_active }),
                                item.is_active ? ta("item_archived") : ta("item_restored"),
                              )
                            }
                          >
                            {item.is_active ? (
                              <Archive className="h-4 w-4" />
                            ) : (
                              <ArchiveRestore className="h-4 w-4" />
                            )}
                          </Button>
                        )}
                        {canDelete && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title={ta("delete")}
                            aria-label={ta("delete")}
                            onClick={() => setDeleting(item)}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                      </>
                    }
                  />
                ))}
              </div>
            </section>
          ))}
        </>
      )}

      <ItemDialog
        open={editing !== null}
        kind={editing?.item?.kind ?? active.kind}
        item={editing?.item ?? null}
        addons={addons}
        taxes={taxes}
        currency={currency}
        onOpenChange={(o) => !o && setEditing(null)}
        onSaved={load}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={ta("delete_item_title", { name: deleting?.name ?? "" })}
        description={ta("delete_item_desc")}
        variant="destructive"
        onConfirm={remove}
        loading={busy}
      />
    </div>
  );
}

function ItemCard({
  item,
  byId,
  currency,
  ta,
  actions,
}: {
  item: CatalogItem;
  byId: Map<string, CatalogItem>;
  currency: string;
  ta: AgencyT;
  actions: React.ReactNode;
}) {
  const included = item.addons.filter((a) => a.mode === "included");
  const optional = item.addons.filter((a) => a.mode === "optional");
  const extraFeatures = item.features.length - MAX_FEATURES_SHOWN;

  return (
    <Card className={cn("gap-3", !item.is_active && "opacity-60")}>
      <CardHeader className="gap-1.5">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-base leading-tight">{item.name}</CardTitle>
          <div className="-mr-2 -mt-1 flex shrink-0">{actions}</div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={item.billing === "recurring" ? "default" : "secondary"}>
            {ta(`billing_${item.billing}`)}
          </Badge>
          {!item.is_active && <Badge variant="outline">{ta("archived")}</Badge>}
        </div>
        <div className="text-sm font-semibold tabular-nums">{priceLabel(ta, item, currency)}</div>
      </CardHeader>
      <CardContent className="space-y-3">
        {item.description && <p className="text-sm text-muted-foreground">{item.description}</p>}
        {item.features.length > 0 && (
          <ul className="space-y-1 text-sm">
            {item.features.slice(0, MAX_FEATURES_SHOWN).map((f) => (
              <li key={f} className="flex gap-2">
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                <span>{f}</span>
              </li>
            ))}
            {extraFeatures > 0 && (
              <li className="pl-5 text-xs text-muted-foreground">
                {ta("more_features", { count: extraFeatures })}
              </li>
            )}
          </ul>
        )}
        {included.length > 0 && (
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground">{ta("includes")}</div>
            <div className="flex flex-wrap gap-1.5">
              {included.map((a) => {
                const addon = byId.get(a.addon_id);
                if (!addon) return null;
                return (
                  <Badge key={a.addon_id} variant="outline" className="h-auto whitespace-normal">
                    {addon.name}
                    {a.free_months > 0 && ` · ${freeLabel(ta, a.free_months)}`}
                  </Badge>
                );
              })}
            </div>
          </div>
        )}
        {optional.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {ta("optional_addons_count", { count: optional.length })}:{" "}
            {optional
              .map((a) => byId.get(a.addon_id)?.name)
              .filter(Boolean)
              .join(", ")}
          </p>
        )}
        {item.kind === "addon" && (
          <p className="text-xs text-muted-foreground">
            {item.packages.length > 0
              ? ta("offered_with", {
                  names: item.packages
                    .map((p) => (p.mode === "included" ? `${p.name} (${ta("included")})` : p.name))
                    .join(", "),
                })
              : ta("not_paired")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

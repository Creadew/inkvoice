// Settings panel in the plugin's detail view (/settings/plugins/agency-services):
// when renewal invoices are created, whether they are sent automatically,
// and whether one client's renewals share an invoice.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { FormField } from "@/components/shared/FormField";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NumberInput } from "@/components/ui/number-input";
import { useCan } from "@/hooks/use-can";
import { type AgencyConfig, agencyApi } from "./api";
import { useAgencyT } from "./format";

export function AgencySettings() {
  const ta = useAgencyT();
  const canEdit = useCan()("settings", "update");
  const [config, setConfig] = useState<AgencyConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    agencyApi
      .getConfig()
      .then(setConfig)
      .catch((e) => setError((e as Error).message));
  }, []);

  if (error) return <p className="text-sm text-muted-foreground">{error}</p>;
  if (!config) return null;

  const save = async () => {
    setSaving(true);
    try {
      setConfig(await agencyApi.updateConfig(config));
      toast.success(ta("settings_saved"));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{ta("settings_title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <FormField label={ta("lead_days")} hint={ta("lead_days_hint")}>
          <NumberInput
            className="w-24"
            value={config.lead_days}
            integer
            max={90}
            disabled={!canEdit}
            onValueChange={(v) => setConfig({ ...config, lead_days: Math.min(90, v) })}
          />
        </FormField>

        <fieldset className="space-y-2" disabled={!canEdit}>
          <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {ta("renewal_invoices")}
          </legend>
          {([false, true] as const).map((auto) => (
            <label key={String(auto)} className="flex gap-2 text-sm">
              <input
                type="radio"
                name="agency-auto-send"
                className="mt-0.5 accent-primary"
                checked={config.auto_send === auto}
                onChange={() => setConfig({ ...config, auto_send: auto })}
              />
              <span>
                {ta(auto ? "auto_send_on" : "auto_send_off")}
                <span className="block text-xs text-muted-foreground">
                  {ta(auto ? "auto_send_on_hint" : "auto_send_off_hint")}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        <label className="flex gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 accent-primary"
            checked={config.bundle}
            disabled={!canEdit}
            onChange={(e) => setConfig({ ...config, bundle: e.target.checked })}
          />
          <span>
            {ta("bundle")}
            <span className="block text-xs text-muted-foreground">{ta("bundle_hint")}</span>
          </span>
        </label>

        <p className="text-xs text-muted-foreground">
          {ta("settings_reminders_note")}{" "}
          <Link to="/settings/reminders" className="text-primary hover:underline">
            {ta("settings_reminders_link")}
          </Link>
        </p>

        {canEdit && (
          <Button onClick={save} disabled={saving}>
            {saving ? ta("saving") : ta("save")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

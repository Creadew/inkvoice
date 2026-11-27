// text.lk SMS settings, rendered inside the plugin's detail view at
// /settings/plugins/textlk-sms: connection, automatic-message toggles,
// message templates, and a test send.

import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { canUser } from "@/hooks/use-can";
import { useTranslation } from "@/i18n";
import { useAuthStore } from "@/stores/auth.store";
import {
  SMS_EVENTS,
  SMS_TEMPLATE_KEYS,
  type SmsConfig,
  type SmsTemplateKey,
  smsApi,
  smsSegments,
} from "./api";

function hintFor(key: SmsTemplateKey): "variables_invoice" | "variables_recurring" {
  return key === "recurring_upcoming" ? "variables_recurring" : "variables_invoice";
}

export function SmsSettings() {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const canEdit = canUser(user, "settings", "update");
  const [config, setConfig] = useState<SmsConfig | null>(null);
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    smsApi
      .getConfig()
      .then((r) => setConfig(r.data))
      .catch((e) => toast.error((e as Error).message));
  }, []);

  if (!config) return null;

  const save = async () => {
    setSaving(true);
    try {
      const res = await smsApi.updateConfig({
        ...(token ? { api_token: token } : {}),
        sender_id: config.sender_id,
        events: config.events,
        recurring_reminder_days: config.recurring_reminder_days,
        templates: config.templates,
      });
      setConfig(res.data);
      setToken("");
      toast.success(t("textlk_sms.saved"));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const res = await smsApi.sendTest(testTo);
      if (res.data?.status === "sent") toast.success(t("textlk_sms.test_sent"));
      else toast.error(t("textlk_sms.test_failed", { error: res.data?.error ?? "" }));
    } catch (e) {
      toast.error(t("textlk_sms.test_failed", { error: (e as Error).message }));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <h3 className="text-sm font-medium">{t("textlk_sms.connection")}</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="textlk-token">{t("textlk_sms.api_token")}</Label>
            <Input
              id="textlk-token"
              type="password"
              autoComplete="off"
              value={token}
              disabled={!canEdit}
              placeholder={t("textlk_sms.api_token_placeholder")}
              onChange={(e) => setToken(e.target.value)}
            />
            {config.api_token_set && (
              <p className="text-xs text-muted-foreground">
                {t("textlk_sms.api_token_saved", { hint: config.api_token_hint ?? "" })}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="textlk-sender">{t("textlk_sms.sender_id")}</Label>
            <Input
              id="textlk-sender"
              maxLength={15}
              value={config.sender_id}
              disabled={!canEdit}
              onChange={(e) => setConfig({ ...config, sender_id: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">{t("textlk_sms.sender_id_hint")}</p>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <h3 className="text-sm font-medium">{t("textlk_sms.automatic")}</h3>
        {!config.public_base_url_set && (
          <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
            {t("textlk_sms.no_base_url")}
          </p>
        )}
        <div className="divide-y rounded-md border">
          {SMS_EVENTS.map((evt) => (
            <div key={evt} className="flex items-start justify-between gap-4 p-3">
              <div className="space-y-0.5">
                <div className="text-sm font-medium">{t(`textlk_sms.evt_${evt}`)}</div>
                <div className="text-xs text-muted-foreground">
                  {t(`textlk_sms.evt_${evt}_desc`, { count: config.active_reminder_rules })}
                </div>
                {evt === "payment_reminders" && (
                  <Link to="/settings/reminders" className="text-xs text-primary hover:underline">
                    {t("textlk_sms.manage_rules")}
                  </Link>
                )}
                {evt === "recurring_upcoming" && config.events.recurring_upcoming && (
                  <div className="flex items-center gap-2 pt-1">
                    <Label htmlFor="textlk-days" className="text-xs">
                      {t("textlk_sms.days_before")}
                    </Label>
                    <Input
                      id="textlk-days"
                      type="number"
                      min={1}
                      max={30}
                      className="h-7 w-20"
                      value={config.recurring_reminder_days}
                      disabled={!canEdit}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          recurring_reminder_days: Math.min(
                            30,
                            Math.max(1, Number(e.target.value) || 1),
                          ),
                        })
                      }
                    />
                  </div>
                )}
              </div>
              <Switch
                checked={config.events[evt]}
                disabled={!canEdit}
                aria-label={t(`textlk_sms.evt_${evt}`)}
                onCheckedChange={(v) =>
                  setConfig({ ...config, events: { ...config.events, [evt]: v } })
                }
              />
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">{t("textlk_sms.templates")}</h3>
          <p className="text-xs text-muted-foreground">{t("textlk_sms.link_note")}</p>
        </div>
        {SMS_TEMPLATE_KEYS.map((key) => {
          const seg = smsSegments(config.templates[key]);
          return (
            <div key={key} className="space-y-1.5">
              <Label htmlFor={`textlk-tpl-${key}`}>{t(`textlk_sms.tpl_${key}`)}</Label>
              <Textarea
                id={`textlk-tpl-${key}`}
                rows={3}
                value={config.templates[key]}
                disabled={!canEdit}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    templates: { ...config.templates, [key]: e.target.value },
                  })
                }
              />
              <p className="text-xs text-muted-foreground">
                {t(`textlk_sms.${hintFor(key)}`)}
                {key === "payment_received" && ` · ${t("textlk_sms.variables_payment")}`}
                {" · "}
                {t("textlk_sms.counter", { chars: seg.chars, parts: seg.parts })}
              </p>
            </div>
          );
        })}
      </section>

      {canEdit && (
        <div className="flex justify-end">
          <Button onClick={save} disabled={saving}>
            {saving ? t("textlk_sms.saving") : t("textlk_sms.save")}
          </Button>
        </div>
      )}

      {canEdit && config.api_token_set && config.sender_id && (
        <section className="space-y-2 border-t pt-6">
          <h3 className="text-sm font-medium">{t("textlk_sms.test_title")}</h3>
          <div className="flex gap-2">
            <Input
              className="max-w-xs"
              placeholder="0771234567"
              aria-label={t("textlk_sms.test_to")}
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
            />
            <Button variant="outline" onClick={sendTest} disabled={testing || !testTo.trim()}>
              {t("textlk_sms.test_send")}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}

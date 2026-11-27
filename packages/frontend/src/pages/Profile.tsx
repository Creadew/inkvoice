import { ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ApiError, api } from "@/api/client";
import { FormField } from "@/components/shared/FormField";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useTranslation } from "@/i18n";
import { formatApiError } from "@/lib/format-api-error";
import { formatDate } from "@/lib/utils";

type MfaStatus = Awaited<ReturnType<typeof api.getMfaStatus>>["data"];

/** The signed-in user's own account settings: their authenticator app. */
export default function Profile() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [removing, setRemoving] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      setStatus((await api.getMfaStatus()).data);
    } catch (err) {
      toast.error(formatApiError(err, t));
    }
  }, [t]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const closeDialog = () => {
    setRemoving(false);
    setPassword("");
    setError("");
  };

  const handleRemove = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) {
      setError(t("validation.required", { field: t("auth.password") }));
      return;
    }
    setError("");
    setLoading(true);
    try {
      await api.removeMfa(password);
      toast.success(t("profile.mfa_removed"));
      closeDialog();
      await fetchStatus();
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "INVALID_PASSWORD"
          ? t("profile.wrong_password")
          : formatApiError(err, t),
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">{t("profile.title")}</h1>

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle className="text-sm">{t("profile.mfa_title")}</CardTitle>
          <p className="text-xs text-muted-foreground mt-1 max-w-md">{t("profile.mfa_info")}</p>
        </CardHeader>
        <CardContent>
          {!status ? (
            <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
          ) : status.enabled ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-background/50 p-3">
              <div className="flex items-start gap-2 min-w-0">
                <ShieldCheck className="h-4 w-4 mt-0.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-medium">{t("profile.mfa_enabled")}</div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    {[
                      status.enabled_at &&
                        t("profile.mfa_enabled_since", { date: formatDate(status.enabled_at) }),
                      t("profile.recovery_codes_left", { count: status.recovery_codes_remaining }),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                  {status.recovery_codes_remaining < 3 && (
                    <div className="text-[11px] text-amber-700 dark:text-amber-400 mt-1 max-w-md">
                      {t("profile.recovery_codes_low")}
                    </div>
                  )}
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={() => setRemoving(true)}>
                {t("profile.mfa_remove")}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t(status.required ? "profile.mfa_off_required" : "profile.mfa_off")}
            </p>
          )}
        </CardContent>
      </Card>

      <Dialog open={removing} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("profile.mfa_remove_title")}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleRemove} className="space-y-4" noValidate>
            <p className="text-sm text-muted-foreground">
              {t(
                status?.required
                  ? "profile.mfa_remove_description_required"
                  : "profile.mfa_remove_description",
              )}
            </p>
            {error && (
              <div className="text-sm text-destructive bg-destructive/10 rounded-lg p-3 animate-slide-down">
                {error}
              </div>
            )}
            <FormField label={t("auth.password")} required>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                aria-invalid={!!error}
                autoFocus
              />
            </FormField>
            <div className="flex gap-2 justify-end">
              <Button type="button" variant="outline" onClick={closeDialog}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" variant="destructive" disabled={loading}>
                {t("profile.mfa_remove")}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

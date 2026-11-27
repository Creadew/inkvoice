import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "@/api/client";
import { FormField } from "@/components/shared/FormField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTranslation } from "@/i18n";
import { formatApiError } from "@/lib/format-api-error";
import { type MfaChallenge, useAuthStore } from "@/stores/auth.store";

interface Props {
  challenge: MfaChallenge;
  /** Back to the password form, with an error to show there if any. */
  onCancel: (error?: string) => void;
  /** Setup just finished: show these, then call the store's finishSignIn. */
  onRecoveryCodes: (codes: string[]) => void;
}

/**
 * Second sign-in step: on first sign-in shows a QR code to add Inkvoice to an
 * authenticator app; every time, asks for the app's 6-digit code, or one of
 * the recovery codes when the app isn't at hand.
 */
export function MfaStep({ challenge, onCancel, onRecoveryCodes }: Props) {
  const { t } = useTranslation();
  const verifyMfa = useAuthStore((s) => s.verifyMfa);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [setup, setSetup] = useState<{ secret: string; qr_code: string } | null>(null);
  const [recoveryMode, setRecoveryMode] = useState(false);

  // Each setup call issues a new secret, so call it exactly once (StrictMode
  // runs effects twice in development).
  const setupRequested = useRef(false);
  useEffect(() => {
    if (challenge.step !== "setup" || setupRequested.current) return;
    setupRequested.current = true;
    api
      .mfaSetup(challenge.token)
      .then((res) => setSetup(res.data))
      .catch((err: unknown) => onCancel(errorMessage(err)));
  });

  function errorMessage(err: unknown): string {
    if (err instanceof ApiError) {
      if (err.code === "INVALID_MFA_CODE") return t("auth.mfa_invalid_code");
      if (err.code === "INVALID_RECOVERY_CODE") return t("auth.recovery_code_invalid");
      if (err.code === "MFA_LOCKED") return t("auth.mfa_locked");
      if (err.code === "MFA_CHALLENGE_EXPIRED") return t("auth.mfa_expired");
    }
    return formatApiError(err, t);
  }

  const toggleRecoveryMode = () => {
    setRecoveryMode(!recoveryMode);
    setCode("");
    setError("");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = code.trim();
    if (recoveryMode ? !value : value.length !== 6) {
      setError(t(recoveryMode ? "auth.recovery_code_required" : "auth.mfa_code_length"));
      return;
    }
    setError("");
    setLoading(true);
    try {
      const recoveryCodes = await verifyMfa(
        challenge.token,
        recoveryMode ? { recovery_code: value } : { code: value },
      );
      // Otherwise signed in: the store holds the user and the login page redirects.
      if (recoveryCodes) onRecoveryCodes(recoveryCodes);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.code === "MFA_CHALLENGE_EXPIRED") {
        onCancel(errorMessage(err));
        return;
      }
      setError(errorMessage(err));
      setCode("");
    } finally {
      setLoading(false);
    }
  };

  if (challenge.step === "setup" && !setup) {
    return <p className="text-center text-sm text-muted-foreground">{t("common.loading")}</p>;
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      {setup && (
        <div className="space-y-3 text-center">
          <p className="text-sm text-muted-foreground">{t("auth.mfa_setup_scan")}</p>
          <img
            src={setup.qr_code}
            alt={t("auth.mfa_qr_alt")}
            className="mx-auto h-48 w-48 rounded-lg border bg-white p-1"
          />
          <div className="text-xs text-muted-foreground">
            <p>{t("auth.mfa_manual_key")}</p>
            <p className="mt-1 select-all break-all font-mono text-sm text-foreground">
              {setup.secret.match(/.{1,4}/g)?.join(" ")}
            </p>
          </div>
        </div>
      )}
      {recoveryMode && (
        <p className="text-center text-sm text-muted-foreground">{t("auth.recovery_code_hint")}</p>
      )}
      {error && (
        <div className="text-sm text-destructive bg-destructive/10 rounded-lg p-3 animate-slide-down">
          {error}
        </div>
      )}
      <FormField label={t(recoveryMode ? "auth.recovery_code" : "auth.mfa_code")} required>
        {recoveryMode ? (
          <Input
            key="recovery"
            value={code}
            onChange={(e) => setCode(e.target.value.slice(0, 64))}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="xxxxx-xxxxx"
            className="text-center font-mono tracking-wider"
            aria-invalid={!!error}
            autoFocus
          />
        ) : (
          <Input
            key="code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            className="text-center font-mono tracking-widest"
            aria-invalid={!!error}
            autoFocus
          />
        )}
      </FormField>
      <Button type="submit" className="w-full" disabled={loading}>
        {loading ? t("auth.mfa_verifying") : t("auth.mfa_verify")}
      </Button>
      {challenge.step === "verify" && (
        <Button type="button" variant="link" className="w-full" onClick={toggleRecoveryMode}>
          {t(recoveryMode ? "auth.use_authenticator_code" : "auth.use_recovery_code")}
        </Button>
      )}
      <Button type="button" variant="ghost" className="w-full" onClick={() => onCancel()}>
        {t("auth.back_to_login")}
      </Button>
    </form>
  );
}

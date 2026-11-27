import crypto from "node:crypto";
import { sign, verify } from "hono/jwt";
import { getDb } from "../database/connection";
import { getEnv } from "../utils/env";
import { qrToDataUri } from "../utils/qr-code";
import { generateTotpSecret, otpauthUri, verifyTotp } from "../utils/totp";

/**
 * Authenticator-app (TOTP) second factor for password sign-ins.
 *
 * A correct password yields a short-lived challenge token instead of a
 * session. The challenge is redeemed with a code (POST /auth/mfa/verify); a
 * user without an authenticator first fetches a QR code (POST /auth/mfa/setup)
 * and the first good code enables it and issues one-time recovery codes for
 * signing in without the app.
 */

const CHALLENGE_TTL_SECONDS = 300;
const ISSUER = "Inkvoice";
const RECOVERY_CODE_COUNT = 10;
// No 0/1/i/l/o, so a code survives being written down or read aloud.
const RECOVERY_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

export type MfaStep = "setup" | "verify";

interface TotpRow {
  username: string;
  totp_secret: string | null;
  totp_enabled_at: string | null;
  totp_last_step: number | null;
}

function totpRow(userId: string): TotpRow | null {
  return getDb()
    .query(
      "SELECT username, totp_secret, totp_enabled_at, totp_last_step FROM users WHERE id = ? AND is_active = 1",
    )
    .get(userId) as TotpRow | null;
}

/** What a password sign-in still needs before a session is issued, if anything. */
export function mfaStepFor(userId: string): MfaStep | null {
  if (totpRow(userId)?.totp_enabled_at) return "verify";
  return getEnv().MFA_REQUIRED ? "setup" : null;
}

// Signed with a key derived from JWT_SECRET, so a challenge token can never
// verify as a session token (and vice versa).
function challengeKey(): string {
  return `${getEnv().JWT_SECRET}:mfa-challenge`;
}

export function signMfaChallenge(userId: string, tenantId?: string): Promise<string> {
  return sign(
    {
      sub: userId,
      tenant_id: tenantId,
      purpose: "mfa",
      exp: Math.floor(Date.now() / 1000) + CHALLENGE_TTL_SECONDS,
    },
    challengeKey(),
    "HS256",
  );
}

/** The user id a challenge was issued for, or null if invalid/expired/wrong tenant. */
export async function verifyMfaChallenge(token: string, tenantId?: string): Promise<string | null> {
  try {
    const payload = await verify(token, challengeKey(), "HS256");
    if (payload.purpose !== "mfa" || typeof payload.sub !== "string") return null;
    if ((payload.tenant_id ?? undefined) !== tenantId) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

/**
 * Starts (or restarts) enrollment with a fresh secret. Returns null when the
 * user already has an authenticator: replacing it needs an admin reset.
 */
export function beginEnrollment(
  userId: string,
): { secret: string; otpauth_uri: string; qr_code: string } | null {
  const row = totpRow(userId);
  if (!row || row.totp_enabled_at) return null;

  const secret = generateTotpSecret();
  getDb().run(
    "UPDATE users SET totp_secret = ?, totp_last_step = NULL WHERE id = ? AND totp_enabled_at IS NULL",
    [secret, userId],
  );
  const uri = otpauthUri(secret, row.username, ISSUER);
  return { secret, otpauth_uri: uri, qr_code: qrToDataUri(uri) };
}

// Failed codes per user. Keyed by user rather than IP so re-entering the
// password (which clears the IP login limiter) can't reset the count.
const failures = new Map<string, { count: number; resetAt: number }>();

function isLocked(userId: string): boolean {
  const env = getEnv();
  if (!env.RATE_LIMIT_ENABLED) return false;
  const entry = failures.get(userId);
  if (!entry) return false;
  if (entry.resetAt <= Date.now()) {
    failures.delete(userId);
    return false;
  }
  return entry.count >= env.RATE_LIMIT_MAX_ATTEMPTS;
}

function recordFailure(userId: string): void {
  const now = Date.now();
  const entry = failures.get(userId);
  if (entry && entry.resetAt > now) entry.count++;
  else failures.set(userId, { count: 1, resetAt: now + getEnv().RATE_LIMIT_WINDOW * 1000 });
}

type MfaFailure = { ok: false; reason: "invalid" | "locked" | "not_setup" };

/** `recoveryCodes` is set when this code just finished setup: shown once, stored hashed. */
export type VerifyResult = { ok: true; recoveryCodes: string[] | null } | MfaFailure;

/**
 * Checks a code against the user's authenticator, enabling a pending one on
 * its first good code. Each code is accepted once.
 */
export function verifyMfaCode(userId: string, code: string): VerifyResult {
  const row = totpRow(userId);
  if (!row?.totp_secret) return { ok: false, reason: "not_setup" };
  if (isLocked(userId)) return { ok: false, reason: "locked" };

  const step = verifyTotp(row.totp_secret, code, row.totp_last_step);
  const db = getDb();
  const accepted =
    step !== null &&
    db.transaction(() => {
      // The guarded UPDATE makes acceptance atomic: two concurrent requests
      // with the same code can't both succeed.
      const changed =
        db.run(
          `UPDATE users SET totp_last_step = ?, totp_enabled_at = COALESCE(totp_enabled_at, datetime('now'))
           WHERE id = ? AND totp_secret = ? AND (totp_last_step IS NULL OR totp_last_step < ?)`,
          [step, userId, row.totp_secret, step],
        ).changes === 1;
      if (!changed) return null;
      return { recoveryCodes: row.totp_enabled_at ? null : replaceRecoveryCodes(userId) };
    })();

  if (!accepted) {
    recordFailure(userId);
    return { ok: false, reason: "invalid" };
  }
  failures.delete(userId);
  return { ok: true, recoveryCodes: accepted.recoveryCodes };
}

function hashRecoveryCode(code: string): string {
  const normalized = code.toLowerCase().replace(/[\s-]/g, "");
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function generateRecoveryCode(): string {
  let code = "";
  for (let i = 0; i < 10; i++) {
    code += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
  }
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** Issues a fresh set of recovery codes, voiding any old ones. Run inside a transaction. */
function replaceRecoveryCodes(userId: string): string[] {
  const db = getDb();
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  db.run("DELETE FROM user_recovery_codes WHERE user_id = ?", [userId]);
  const insert = db.prepare("INSERT INTO user_recovery_codes (user_id, code_hash) VALUES (?, ?)");
  for (const code of codes) insert.run(userId, hashRecoveryCode(code));
  return codes;
}

/**
 * Signs in with an unused recovery code instead of an authenticator code,
 * spending it. Shares the failure limit with authenticator codes.
 */
export function redeemRecoveryCode(userId: string, code: string): { ok: true } | MfaFailure {
  if (!totpRow(userId)?.totp_enabled_at) return { ok: false, reason: "not_setup" };
  if (isLocked(userId)) return { ok: false, reason: "locked" };

  const used =
    getDb().run(
      "UPDATE user_recovery_codes SET used_at = datetime('now') WHERE user_id = ? AND code_hash = ? AND used_at IS NULL",
      [userId, hashRecoveryCode(code)],
    ).changes > 0;
  if (!used) {
    recordFailure(userId);
    return { ok: false, reason: "invalid" };
  }
  failures.delete(userId);
  return { ok: true };
}

/** The user's authenticator, as the profile page shows it. */
export function getMfaStatus(userId: string) {
  const row = totpRow(userId);
  const unused = getDb()
    .query("SELECT COUNT(*) AS n FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL")
    .get(userId) as { n: number };
  return {
    enabled: !!row?.totp_enabled_at,
    enabled_at: row?.totp_enabled_at ?? null,
    required: getEnv().MFA_REQUIRED,
    recovery_codes_remaining: unused.n,
  };
}

/**
 * Removes the user's authenticator and recovery codes; they set up a new one
 * on next sign-in.
 */
export function resetMfa(userId: string): boolean {
  failures.delete(userId);
  const db = getDb();
  return db.transaction(() => {
    db.run("DELETE FROM user_recovery_codes WHERE user_id = ?", [userId]);
    return (
      db.run(
        "UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE id = ?",
        [userId],
      ).changes === 1
    );
  })();
}

/** Test-only — clears failure counters. */
export function resetMfaFailuresForTesting(): void {
  failures.clear();
}

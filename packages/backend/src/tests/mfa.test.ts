import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import type { Hono } from "hono";
import { createApp } from "../app";
import { closeDatabase, getDb, initDatabase } from "../database/connection";
import { runMigrations } from "../database/migrations";
import { seed } from "../database/seed";
import { resetRateLimitsForTesting } from "../middleware/rate-limiter";
import { createToken } from "../services/api-token.service";
import { getMfaStatus, resetMfaFailuresForTesting } from "../services/mfa.service";
import { createUser, getUser, listUsers } from "../services/user.service";
import { resetEnvCache } from "../utils/env";
import { signToken } from "../utils/jwt";
import { currentStep, totpCode } from "../utils/totp";

const TEST_DB = "./data/test-mfa.db";
const ADMIN_PASS = "mfatestpass1234";
let app: Hono;
let userSeq = 0;

function post(path: string, body: unknown, bearer?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  return app.request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function json(res: Response) {
  return (await res.json()) as any;
}

async function passwordStep(username: string, password: string) {
  const res = await post("/api/v1/auth/login", { username, password });
  expect(res.status).toBe(200);
  return (await json(res)).data as { mfa_required?: string; mfa_token?: string; token?: string };
}

async function newUser() {
  userSeq++;
  const username = `mfa-user-${userSeq}`;
  const password = "member-password-123";
  const user = (await createUser({ username, password, role: "Viewer" })) as unknown as {
    id: string;
  };
  return { id: user.id, username, password };
}

/** Signs in for the first time and enrolls: the secret, recovery codes and session. */
async function enroll(username: string, password: string) {
  const challenge = await passwordStep(username, password);
  expect(challenge.mfa_required).toBe("setup");
  const setup = await json(
    await post("/api/v1/auth/mfa/setup", { mfa_token: challenge.mfa_token }),
  );
  const secret = setup.data.secret as string;
  const res = await post("/api/v1/auth/mfa/verify", {
    mfa_token: challenge.mfa_token,
    code: totpCode(secret, currentStep() - 1),
  });
  expect(res.status).toBe(200);
  const data = (await json(res)).data;
  return { secret, recoveryCodes: data.recovery_codes as string[], token: data.token as string };
}

function get(path: string, bearer: string) {
  return app.request(`http://localhost${path}`, { headers: { Authorization: `Bearer ${bearer}` } });
}

beforeAll(async () => {
  process.env.DATABASE_PATH = TEST_DB;
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASS = ADMIN_PASS;
  process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-chars-long";
  process.env.RATE_LIMIT_ENABLED = "false";
  process.env.MFA_REQUIRED = "true";
  resetEnvCache();

  initDatabase();
  runMigrations();
  await seed();
  app = createApp();
});

beforeEach(() => {
  resetMfaFailuresForTesting();
  resetRateLimitsForTesting();
});

afterAll(() => {
  // bun runs every test file in one process: don't leak the flag.
  process.env.MFA_REQUIRED = "false";
  process.env.RATE_LIMIT_ENABLED = "false";
  resetEnvCache();
  closeDatabase();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB}${suffix}`);
    } catch {}
  }
});

describe("authenticator sign-in", () => {
  test("first sign-in: password gives only a setup challenge, no session", async () => {
    const res = await post("/api/v1/auth/login", { username: "admin", password: ADMIN_PASS });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    const data = (await json(res)).data;
    expect(data.mfa_required).toBe("setup");
    expect(data.token).toBeUndefined();

    // The challenge is not a session token.
    const me = await app.request("http://localhost/api/v1/auth/me", {
      headers: { Authorization: `Bearer ${data.mfa_token}` },
    });
    expect(me.status).toBe(401);
  });

  test("setup returns a QR code; first good code enables it and opens a session", async () => {
    const user = await newUser();
    const challenge = await passwordStep(user.username, user.password);
    const setup = await json(
      await post("/api/v1/auth/mfa/setup", { mfa_token: challenge.mfa_token }),
    );
    expect(setup.data.qr_code).toStartWith("data:image/svg+xml;base64,");
    expect(setup.data.otpauth_uri).toContain(`secret=${setup.data.secret}`);

    const bad = await post("/api/v1/auth/mfa/verify", {
      mfa_token: challenge.mfa_token,
      code: "000000",
    });
    expect(bad.status).toBe(401);

    const res = await post("/api/v1/auth/mfa/verify", {
      mfa_token: challenge.mfa_token,
      code: totpCode(setup.data.secret, currentStep()),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("session=");
    const body = await json(res);
    expect(body.data.user.username).toBe(user.username);

    const me = await app.request("http://localhost/api/v1/auth/me", {
      headers: { Authorization: `Bearer ${body.data.token}` },
    });
    expect(me.status).toBe(200);
  });

  test("later sign-ins ask for a code and can't set up a new authenticator", async () => {
    const user = await newUser();
    const { secret } = await enroll(user.username, user.password);

    const challenge = await passwordStep(user.username, user.password);
    expect(challenge.mfa_required).toBe("verify");

    const setup = await post("/api/v1/auth/mfa/setup", { mfa_token: challenge.mfa_token });
    expect(setup.status).toBe(409);

    const code = totpCode(secret, currentStep());
    const ok = await post("/api/v1/auth/mfa/verify", { mfa_token: challenge.mfa_token, code });
    expect(ok.status).toBe(200);
    expect((await json(ok)).data.recovery_codes).toBeUndefined();

    // The same code can't be used twice.
    const again = await passwordStep(user.username, user.password);
    const replay = await post("/api/v1/auth/mfa/verify", { mfa_token: again.mfa_token, code });
    expect(replay.status).toBe(401);
  });

  test("a wrong password never reaches the authenticator step", async () => {
    const res = await post("/api/v1/auth/login", { username: "admin", password: "wrong" });
    expect(res.status).toBe(401);
  });

  test("rejects forged, session and garbage challenge tokens", async () => {
    const user = await newUser();
    const sessionJwt = await signToken({ sub: user.id, username: user.username, is_admin: false });
    for (const mfa_token of [sessionJwt, "garbage"]) {
      const res = await post("/api/v1/auth/mfa/setup", { mfa_token });
      expect(res.status).toBe(401);
    }
  });

  test("failed codes lock the user even when the password is re-entered", async () => {
    process.env.RATE_LIMIT_ENABLED = "true";
    resetEnvCache();
    try {
      const user = await newUser();
      const { secret } = await enroll(user.username, user.password);
      for (let i = 0; i < 5; i++) {
        // A fresh password step each time clears the per-IP login limiter.
        const challenge = await passwordStep(user.username, user.password);
        const res = await post("/api/v1/auth/mfa/verify", {
          mfa_token: challenge.mfa_token,
          code: "000000",
        });
        expect(res.status).toBe(401);
      }
      const challenge = await passwordStep(user.username, user.password);
      const res = await post("/api/v1/auth/mfa/verify", {
        mfa_token: challenge.mfa_token,
        code: totpCode(secret, currentStep()),
      });
      expect(res.status).toBe(429);
    } finally {
      process.env.RATE_LIMIT_ENABLED = "false";
      resetEnvCache();
    }
  });

  test("admin reset sends the user back to setup", async () => {
    const user = await newUser();
    await enroll(user.username, user.password);

    const adminChallenge = await passwordStep("admin", ADMIN_PASS);
    const adminSecret = (
      await json(await post("/api/v1/auth/mfa/setup", { mfa_token: adminChallenge.mfa_token }))
    ).data.secret;
    const admin = await json(
      await post("/api/v1/auth/mfa/verify", {
        mfa_token: adminChallenge.mfa_token,
        code: totpCode(adminSecret, currentStep()),
      }),
    );

    const res = await app.request(`http://localhost/api/v1/users/${user.id}/mfa`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${admin.data.token}` },
    });
    expect(res.status).toBe(200);
    expect((await passwordStep(user.username, user.password)).mfa_required).toBe("setup");
    expect(getMfaStatus(user.id).recovery_codes_remaining).toBe(0);
  });

  test("mobile sign-in needs a code once set up, and setup on the web first", async () => {
    const device = { name: "Phone", platform: "ios" };
    const user = await newUser();

    const before = await post("/api/v1/auth/device-sessions", { ...user, device });
    expect(before.status).toBe(403);
    expect((await json(before)).code).toBe("MFA_SETUP_REQUIRED");

    const { secret } = await enroll(user.username, user.password);
    const noCode = await post("/api/v1/auth/device-sessions", { ...user, device });
    expect((await json(noCode)).code).toBe("MFA_CODE_REQUIRED");

    const ok = await post("/api/v1/auth/device-sessions", {
      ...user,
      device,
      totp_code: totpCode(secret, currentStep()),
    });
    expect(ok.status).toBe(201);
  });

  test("the secret never appears in user listings", () => {
    const enrolled = getDb()
      .query("SELECT id, totp_secret FROM users WHERE totp_secret IS NOT NULL LIMIT 1")
      .get() as { id: string; totp_secret: string };
    expect(enrolled.totp_secret).toBeDefined();
    const serialized = JSON.stringify([listUsers(), getUser(enrolled.id)]);
    expect(serialized).not.toContain(enrolled.totp_secret);
    expect(serialized).not.toContain("totp");
  });
});

describe("recovery codes", () => {
  test("setup hands out ten one-time codes, stored only as hashes", async () => {
    const user = await newUser();
    const { recoveryCodes } = await enroll(user.username, user.password);
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    for (const code of recoveryCodes) {
      expect(code).toMatch(/^[2-9a-hjkmnp-z]{5}-[2-9a-hjkmnp-z]{5}$/);
    }
    const stored = JSON.stringify(
      getDb().query("SELECT * FROM user_recovery_codes WHERE user_id = ?").all(user.id),
    );
    for (const code of recoveryCodes) {
      expect(stored).not.toContain(code);
      expect(stored).not.toContain(code.replace("-", ""));
    }
  });

  test("a recovery code signs in once, whatever its case or spacing", async () => {
    const user = await newUser();
    const { recoveryCodes } = await enroll(user.username, user.password);

    const challenge = await passwordStep(user.username, user.password);
    const res = await post("/api/v1/auth/mfa/verify", {
      mfa_token: challenge.mfa_token,
      recovery_code: recoveryCodes[0].toUpperCase().replace("-", " "),
    });
    expect(res.status).toBe(200);
    expect((await json(res)).data.token).toBeDefined();

    const again = await passwordStep(user.username, user.password);
    const reuse = await post("/api/v1/auth/mfa/verify", {
      mfa_token: again.mfa_token,
      recovery_code: recoveryCodes[0],
    });
    expect(reuse.status).toBe(401);
    expect((await json(reuse)).code).toBe("INVALID_RECOVERY_CODE");
    expect(getMfaStatus(user.id).recovery_codes_remaining).toBe(9);
  });

  test("a code or a recovery code is required", async () => {
    const user = await newUser();
    await enroll(user.username, user.password);
    const challenge = await passwordStep(user.username, user.password);
    const res = await post("/api/v1/auth/mfa/verify", { mfa_token: challenge.mfa_token });
    expect(res.status).toBe(400);
  });
});

describe("profile: own authenticator", () => {
  test("status shows the authenticator and unused recovery codes", async () => {
    const user = await newUser();
    const { token } = await enroll(user.username, user.password);
    const status = (await json(await get("/api/v1/auth/mfa", token))).data;
    expect(status).toMatchObject({ enabled: true, required: true, recovery_codes_remaining: 10 });
    expect(Date.now() - Date.parse(status.enabled_at)).toBeLessThan(60_000);
  });

  test("removing it needs the password, then setup starts over", async () => {
    const user = await newUser();
    const { token, recoveryCodes } = await enroll(user.username, user.password);

    const wrong = await post("/api/v1/auth/mfa/remove", { password: "not-the-password" }, token);
    expect(wrong.status).toBe(403);
    expect((await json(wrong)).code).toBe("INVALID_PASSWORD");
    expect(getMfaStatus(user.id).enabled).toBe(true);

    const ok = await post("/api/v1/auth/mfa/remove", { password: user.password }, token);
    expect(ok.status).toBe(200);
    expect((await json(await get("/api/v1/auth/mfa", token))).data).toMatchObject({
      enabled: false,
      recovery_codes_remaining: 0,
    });

    const challenge = await passwordStep(user.username, user.password);
    expect(challenge.mfa_required).toBe("setup");
    const oldCode = await post("/api/v1/auth/mfa/verify", {
      mfa_token: challenge.mfa_token,
      recovery_code: recoveryCodes[1],
    });
    expect(oldCode.status).toBe(400);
  });

  test("a phone session or an API token can't remove it", async () => {
    const user = await newUser();
    const { secret } = await enroll(user.username, user.password);
    const phone = await json(
      await post("/api/v1/auth/device-sessions", {
        username: user.username,
        password: user.password,
        device: { name: "Phone", platform: "ios" },
        totp_code: totpCode(secret, currentStep()),
      }),
    );
    const apiToken = createToken(user.id, "integration", []).token;

    for (const bearer of [phone.data.token as string, apiToken]) {
      const res = await post("/api/v1/auth/mfa/remove", { password: user.password }, bearer);
      expect(res.status).toBe(403);
    }
    expect(getMfaStatus(user.id).enabled).toBe(true);
  });
});

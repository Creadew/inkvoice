import { describe, expect, test } from "bun:test";
import {
  base32Decode,
  base32Encode,
  currentStep,
  generateTotpSecret,
  otpauthUri,
  totpCode,
  verifyTotp,
} from "../utils/totp";

// RFC 6238 Appendix B (SHA-1), last 6 of the 8 published digits.
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));
const RFC_VECTORS: [number, string][] = [
  [59, "287082"],
  [1111111109, "081804"],
  [1111111111, "050471"],
  [1234567890, "005924"],
  [2000000000, "279037"],
];

describe("TOTP", () => {
  test("matches the RFC 6238 test vectors", () => {
    for (const [seconds, code] of RFC_VECTORS) {
      expect(totpCode(RFC_SECRET, currentStep(seconds * 1000))).toBe(code);
    }
  });

  test("base32 round-trips", () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
  });

  test("generated secrets are 160-bit base32", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret).length).toBe(20);
  });

  test("accepts one step of drift either way, not two", () => {
    const now = 1_700_000_000_000;
    const step = currentStep(now);
    for (const offset of [-1, 0, 1]) {
      expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + offset), null, now)).toBe(
        step + offset,
      );
    }
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 2), null, now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 2), null, now)).toBeNull();
  });

  test("refuses steps at or before the last accepted one", () => {
    const now = 1_700_000_000_000;
    const step = currentStep(now);
    const code = totpCode(RFC_SECRET, step);
    expect(verifyTotp(RFC_SECRET, code, step, now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), step, now)).toBe(step + 1);
  });

  test("tolerates spaces, rejects malformed codes", () => {
    const now = 1_700_000_000_000;
    const code = totpCode(RFC_SECRET, currentStep(now));
    expect(
      verifyTotp(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, null, now),
    ).not.toBeNull();
    expect(verifyTotp(RFC_SECRET, "12345", null, now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, "abcdef", null, now)).toBeNull();
  });

  test("otpauth URI carries issuer, account and secret", () => {
    const uri = otpauthUri("ABC", "alice", "Inkvoice");
    expect(uri.startsWith("otpauth://totp/Inkvoice%3Aalice?")).toBe(true);
    const params = new URL(uri).searchParams;
    expect(params.get("secret")).toBe("ABC");
    expect(params.get("issuer")).toBe("Inkvoice");
  });
});

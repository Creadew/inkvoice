import { describe, expect, test } from "bun:test";
import { smsSegments } from "../plugins/textlk-sms/api";

describe("smsSegments", () => {
  test("empty message is zero parts", () => {
    expect(smsSegments("")).toEqual({ chars: 0, parts: 0, unicode: false });
  });

  test("GSM-7: 160 fits one part, 161 splits at 153", () => {
    expect(smsSegments("a".repeat(160)).parts).toBe(1);
    expect(smsSegments("a".repeat(161)).parts).toBe(2);
    expect(smsSegments("a".repeat(306)).parts).toBe(2);
    expect(smsSegments("a".repeat(307)).parts).toBe(3);
  });

  test("extension characters count double", () => {
    expect(smsSegments("€[]").chars).toBe(6);
  });

  test("Sinhala switches to Unicode: 70 per part, 67 when split", () => {
    const s = smsSegments("ස්තූතියි");
    expect(s.unicode).toBe(true);
    expect(s.parts).toBe(1);
    expect(smsSegments("අ".repeat(70)).parts).toBe(1);
    expect(smsSegments("අ".repeat(71)).parts).toBe(2);
  });
});

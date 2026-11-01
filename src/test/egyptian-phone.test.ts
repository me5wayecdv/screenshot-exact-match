import { describe, expect, it } from "vitest";
import { isValidEgyptianMobile, isValidE164, normalizePhoneInput } from "@/lib/whatsapp";

describe("isValidEgyptianMobile", () => {
  it("accepts all Egyptian mobile prefixes in international form", () => {
    expect(isValidEgyptianMobile("+201012345678")).toBe(true);
    expect(isValidEgyptianMobile("+201112345678")).toBe(true);
    expect(isValidEgyptianMobile("+201212345678")).toBe(true);
    expect(isValidEgyptianMobile("+201512345678")).toBe(true);
  });
  it("rejects non-Egyptian and landline-like numbers", () => {
    expect(isValidEgyptianMobile("+201312345678")).toBe(false); // 013 not mobile
    expect(isValidEgyptianMobile("+20221234567")).toBe(false); // landline-ish
    expect(isValidEgyptianMobile("+966501234567")).toBe(false); // Saudi
    expect(isValidEgyptianMobile("+20101234567")).toBe(false); // too short
    expect(isValidEgyptianMobile("+2010123456789")).toBe(false); // too long
    expect(isValidEgyptianMobile("01012345678")).toBe(false); // local form must normalize first
    expect(isValidEgyptianMobile("")).toBe(false);
  });
});

describe("normalizePhoneInput", () => {
  it("normalizes Egyptian local form to +20", () => {
    expect(normalizePhoneInput("01012345678")).toBe("+201012345678");
    expect(normalizePhoneInput("011 1234 5678")).toBe("+201112345678");
    expect(normalizePhoneInput("015-1234-5678")).toBe("+201512345678");
  });
  it("adds a missing + for 20-prefixed input", () => {
    expect(normalizePhoneInput("201012345678")).toBe("+201012345678");
  });
  it("keeps already-international input and strips separators", () => {
    expect(normalizePhoneInput("+20 101 234 5678")).toBe("+201012345678");
  });
  it("does not invent +20 for non-Egyptian input", () => {
    expect(normalizePhoneInput("+966501234567")).toBe("+966501234567");
    expect(normalizePhoneInput("01312345678")).toBe("01312345678");
  });
});

describe("isValidE164 (unchanged legacy helper)", () => {
  it("still validates generic E.164", () => {
    expect(isValidE164("+201012345678")).toBe(true);
    expect(isValidE164("+966501234567")).toBe(true);
    expect(isValidE164("abc")).toBe(false);
  });
});

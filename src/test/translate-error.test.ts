import { describe, expect, it } from "vitest";

import { translateError } from "@/lib/i18n";

/**
 * Live bug (2026-11-04): a publish showed the success toast and, right under
 * it, the raw Postgres text of a duplicate-key failure. `translateError` used
 * to fall back to `error.message` whenever it did not recognise the error,
 * which is exactly the string nobody outside the database should ever read.
 */
describe("translateError", () => {
  const duplicateKey = {
    code: "23505",
    details: null,
    hint: null,
    message: 'duplicate key value violates unique constraint "assessment_assignments_pkey"',
  };

  it("never shows raw database text for an unmapped PostgREST error", () => {
    const shown = translateError(duplicateKey, "ar");
    expect(shown).not.toContain("duplicate key");
    expect(shown).not.toContain("constraint");
    expect(shown).toBe("حدث خطأ. حاول مرة أخرى.");
  });

  it("never shows raw database text in English either", () => {
    const shown = translateError(duplicateKey, "en");
    expect(shown).not.toContain("duplicate key");
    expect(shown).toBe("Something went wrong. Please try again.");
  });

  it("still translates errors the app raises on purpose", () => {
    expect(translateError({ code: "P0001", message: "no_questions" }, "ar")).toBe(
      "أضف سؤالاً واحداً على الأقل قبل النشر.",
    );
  });

  it("still passes through an application message with no database shape", () => {
    expect(translateError(new Error("الملف أكبر من الحد المسموح"), "ar")).toBe(
      "الملف أكبر من الحد المسموح",
    );
  });

  it("recognises a database error by its SQLSTATE code alone", () => {
    expect(translateError({ code: "42501", message: "permission denied" }, "ar")).toBe(
      "حدث خطأ. حاول مرة أخرى.",
    );
  });
});

describe("translateError — AuthError codes", () => {
  it("shows Arabic for a wrong password (message is the code, no English text)", async () => {
    const { AuthError } = await import("@/lib/cloudflare-auth");
    expect(translateError(new AuthError("INVALID_CREDENTIALS"), "ar")).toBe(
      "البريد أو كلمة السر مش صح.",
    );
  });

  it("prefers the error code over an English message", () => {
    expect(
      translateError(
        { code: "RATE_LIMITED", message: "Too many login attempts. Try again later." },
        "ar",
      ),
    ).toBe("محاولات كتير في وقت قصير — استنى شوية وحاول تاني.");
  });
});

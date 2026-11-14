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

describe("translateError — server error classes are code-only", () => {
  // Live bug (2026-11-12): the password-reset toast showed the raw
  // English "Email is not configured." — EmailError carried the code
  // in its `code` property and an English sentence in `message`, and
  // the code is lost when the error crosses a server-function call.
  // Every server error class now throws with message === code, and
  // the map covers every code those classes throw.
  it("shows Arabic for EMAIL_NOT_CONFIGURED from a code-only EmailError", async () => {
    const { EmailError } = await import("@/server/d1-email");
    expect(translateError(new EmailError("EMAIL_NOT_CONFIGURED"), "ar")).toBe(
      "إرسال البريد مش مظبوط لسه — كلم المشرف.",
    );
  });

  it("translates a serialized error whose message IS the code (RPC lost the code)", () => {
    expect(translateError(new Error("EMAIL_NOT_CONFIGURED"), "ar")).toBe(
      "إرسال البريد مش مظبوط لسه — كلم المشرف.",
    );
    expect(translateError(new Error("NOT_FOUND"), "ar")).toBe("الحاجة دي مش موجودة.");
    expect(translateError(new Error("INVALID_EMAIL"), "ar")).toBe("البريد ده مش صحيح.");
    expect(translateError(new Error("WEAK_PASSWORD"), "ar")).toBe(
      "كلمة السر ضعيفة — خليها أطول وأقوى.",
    );
    expect(translateError(new Error("SESSION_EXPIRED"), "ar")).toBe("جلستك خلصت — سجّل دخول تاني.");
  });

  it("translates lowercase group codes the same way", async () => {
    const { GroupError } = await import("@/server/d1-groups");
    expect(translateError(new GroupError("not_teacher"), "ar")).toBe("ده إجراء للمعلم فقط.");
    expect(translateError(new Error("invalid_code"), "ar")).toBe("كود المجموعة ده مش صحيح.");
  });
});

describe("translateError — CQ-F1: every thrown code has an Arabic sentence", () => {
  // Recomputed from current code (Deep Audit Phase 3, CQ-F1): every code
  // thrown as Error(message === code), returned as { ok: false, code }, or
  // produced by the dynamic `TAKE_${gate.reason}` throw, that was missing
  // from errorMap. PUBLISH_NO_STUDENTS is deliberately NOT here: the publish
  // handler intercepts it first (assessments.$id.tsx:129).
  const EXPECTED: Record<string, { ar: string; en: string }> = {
    PUBLISH_NO_QUESTIONS: {
      ar: "مفيش أسئلة في الاختبار — أضف سؤال واحد على الأقل قبل النشر.",
      en: "Add at least one question before publishing.",
    },
    PUBLISH_INCOMPLETE: {
      ar: "بعض الأسئلة لسه ناقصة — كمّلها قبل النشر.",
      en: "Some questions are still incomplete — finish them before publishing.",
    },
    INVALID_TITLE: {
      ar: "عنوان الاختبار مش صحيح — اكتب عنوان واضح.",
      en: "That assessment title isn't valid — write a clear title.",
    },
    INVALID_MARKS: {
      ar: "درجة السؤال لازم تكون أكبر من صفر.",
      en: "A question's marks must be greater than zero.",
    },
    INVALID_QUESTION: {
      ar: "السؤال ده مش صحيح — راجع بياناته.",
      en: "That question isn't valid — check its details.",
    },
    INVALID_TRANSITION: {
      ar: "مينفعش تغيّر حالة الاختبار بالشكل ده.",
      en: "You can't change the assessment status like that.",
    },
    SCORE_OUT_OF_RANGE: {
      ar: "الدرجة اللي دخلتها خارج النطاق المسموح.",
      en: "That score is outside the allowed range.",
    },
    NOT_FULLY_GRADED: {
      ar: "لازم تخلّص تصحيح كل الأسئلة قبل النشر.",
      en: "All questions must be graded before release.",
    },
    NOT_APPROVED: {
      ar: "التسليم ده لسه متوافقش عليه.",
      en: "That submission hasn't been approved yet.",
    },
    NOT_READY_FOR_REVIEW: {
      ar: "التسليم ده لسه مش جاهز للمراجعة.",
      en: "That submission isn't ready for review yet.",
    },
    FEEDBACK_TOO_LONG: {
      ar: "الملاحظات طويلة أوي — اختصرها شوية.",
      en: "That feedback is too long — shorten it a little.",
    },
    TAKE_NOT_FOUND: { ar: "الاختبار ده مش موجود.", en: "That assessment was not found." },
    TAKE_NOT_PUBLISHED: {
      ar: "الاختبار ده لسه متنشرش.",
      en: "That assessment hasn't been published yet.",
    },
    TAKE_NOT_STARTED: {
      ar: "الاختبار لسه مبدأش — استنى لمعاد البدء.",
      en: "The assessment hasn't started yet — wait for the start time.",
    },
    TAKE_WINDOW_CLOSED: { ar: "معاد الاختبار خلص.", en: "The assessment window has closed." },
    TAKE_NO_ATTEMPTS_LEFT: {
      ar: "خلّصت كل محاولاتك في الاختبار ده.",
      en: "You've used all your attempts for this assessment.",
    },
    TAKE_FLUSH_NO_ROW: {
      ar: "حصلت مشكلة في حفظ إجابتك — حاول تاني.",
      en: "There was a problem saving your answer — try again.",
    },
    TAKE_QUEUE_TIMEOUT: {
      ar: "الحفظ اتأخر أوي — استنى شوية وحاول تاني.",
      en: "Saving took too long — wait a little and try again.",
    },
    INVALID_EVENT: { ar: "الحدث ده مش صالح.", en: "That event isn't valid." },
    INVALID_CODE: { ar: "الكود ده مش صحيح.", en: "That code isn't valid." },
    INVALID_NAME: {
      ar: "الاسم ده مش صحيح — اكتب اسم واضح.",
      en: "That name isn't valid — write a clear name.",
    },
    NAME_REQUIRED: {
      ar: "لازم تكتب اسمك الأول قبل ما تنضم.",
      en: "You need to add your name before joining.",
    },
    HAS_SUBMISSIONS: {
      ar: "في تسليمات للاختبار ده بالفعل.",
      en: "Submissions for this assessment already exist.",
    },
    DB_ERROR: {
      ar: "حصلت مشكلة في حفظ البيانات — حاول تاني بعد شوية.",
      en: "There was a problem saving the data — try again in a little while.",
    },
    AI_PARSE_FAILED: {
      ar: "الذكاء الاصطناعي رجّع نتيجة مش مفهومة — حاول تاني.",
      en: "The AI returned a result that couldn't be understood — try again.",
    },
    VALIDATION: {
      ar: "البيانات مش مكتملة أو مش صحيحة — راجعها وحاول تاني.",
      en: "The data is incomplete or invalid — check it and try again.",
    },
    AI_NOT_CONFIGURED: {
      ar: "الذكاء الاصطناعي مش مظبوط لسه — كلم المشرف.",
      en: "AI isn't set up yet — contact the administrator.",
    },
    AI_AUTH: {
      ar: "مفتاح الذكاء الاصطناعي مش صالح — كلم المشرف.",
      en: "The AI key isn't valid — contact the administrator.",
    },
    AI_BAD_REQUEST: {
      ar: "الطلب اللي اتبعت للذكاء الاصطناعي مش صالح — حاول تاني.",
      en: "The request sent to the AI wasn't valid — try again.",
    },
    AI_RATE_LIMIT: {
      ar: "وصلت لحد استخدام الذكاء الاصطناعي — استنى شوية وحاول تاني.",
      en: "You've reached the AI usage limit — wait a little and try again.",
    },
    AI_UPSTREAM: {
      ar: "خدمة الذكاء الاصطناعي مش متاحة دلوقتي — حاول تاني بعد شوية.",
      en: "The AI service isn't available right now — try again in a little while.",
    },
    AI_TIMEOUT: {
      ar: "طلب الذكاء الاصطناعي خد وقت أطول من اللازم — حاول تاني.",
      en: "The AI request took too long — try again.",
    },
    AI_EMPTY_REPLY: {
      ar: "الذكاء الاصطناعي مرجّعش نتيجة — حاول تاني.",
      en: "The AI didn't return a result — try again.",
    },
    AI_ERROR: {
      ar: "الذكاء الاصطناعي رجّع نتيجة مش صالحة — حاول تاني.",
      en: "The AI returned an unusable result — try again.",
    },
    NOT_TEACHER: { ar: "الإجراء ده للمعلم بس.", en: "Only a teacher can do this." },
    UNAUTHORIZED: {
      ar: "مش مسموح لك تعمل ده — سجّل دخول بالحساب الصح.",
      en: "You're not allowed to do that — sign in with the right account.",
    },
    TUTOR_NOT_CONFIGURED: {
      ar: "المساعد الدراسي مش مظبوط لسه — كلم المشرف.",
      en: "The study tutor isn't set up yet — contact the administrator.",
    },
    TUTOR_UPSTREAM: {
      ar: "خدمة المساعد الدراسي مش متاحة دلوقتي — حاول تاني بعد شوية.",
      en: "The tutor service isn't available right now — try again in a little while.",
    },
    TUTOR_TIMEOUT: {
      ar: "طلب المساعد الدراسي خد وقت أطول من اللازم — حاول تاني.",
      en: "The tutor request took too long — try again.",
    },
    TUTOR_RATE_LIMIT: {
      ar: "وصلت لحد استخدام المساعد الدراسي — استنى شوية وحاول تاني.",
      en: "You've reached the tutor usage limit — wait a little and try again.",
    },
    TUTOR_PARSE_FAILED: {
      ar: "المساعد الدراسي رجّع نتيجة مش مفهومة — حاول تاني.",
      en: "The tutor returned a result that couldn't be understood — try again.",
    },
    VISION_NOT_CONFIGURED: {
      ar: "قراءة الصور مش مظبوطة لسه — كلم المشرف.",
      en: "Image reading isn't set up yet — contact the administrator.",
    },
    VISION_UPSTREAM: {
      ar: "خدمة قراءة الصور مش متاحة دلوقتي — حاول تاني بعد شوية.",
      en: "The image reading service isn't available right now — try again in a little while.",
    },
    VISION_TIMEOUT: {
      ar: "قراءة الصورة خدت وقت أطول من اللازم — حاول تاني.",
      en: "Reading the image took too long — try again.",
    },
    VISION_RATE_LIMIT: {
      ar: "وصلت لحد قراءة الصور — استنى شوية وحاول تاني.",
      en: "You've reached the image reading limit — wait a little and try again.",
    },
    VISION_PARSE_FAILED: {
      ar: "مقدرناش نقرا الصورة دي — جرّب صورة أوضح.",
      en: "We couldn't read that image — try a clearer one.",
    },
    VISION_UNSUPPORTED: { ar: "نوع الصورة ده مش مدعوم.", en: "That image type isn't supported." },
    TAKE_NOT_ASSIGNED: {
      ar: "الاختبار ده مش مسند ليك.",
      en: "This assessment isn't assigned to you.",
    },
    TAKE_NOT_GROUP_MEMBER: {
      ar: "لازم تكون عضو في مجموعة الاختبار ده عشان تدخله.",
      en: "You need to be a member of this assessment's group to take it.",
    },
    TAKE_SESSION_ERROR: {
      ar: "حصلت مشكلة في جلسة الاختبار — حاول تاني.",
      en: "There was a problem with the exam session — try again.",
    },
  };

  it.each(Object.entries(EXPECTED))(
    "translates %s to an Arabic sentence, not the raw code",
    (code, expected) => {
      expect(translateError({ code, message: code }, "ar")).toBe(expected.ar);
      expect(translateError({ code, message: code }, "en")).toBe(expected.en);
    },
  );

  it.each(Object.entries(EXPECTED))(
    "translates %s from a serialized Error whose message IS the code",
    (code, expected) => {
      expect(translateError(new Error(code), "ar")).toBe(expected.ar);
    },
  );

  it("no thrown code renders verbatim in either language", () => {
    for (const code of Object.keys(EXPECTED)) {
      const ar = translateError(new Error(code), "ar");
      const en = translateError(new Error(code), "en");
      expect(ar).not.toBe(code);
      expect(ar).not.toContain(code);
      expect(en).not.toBe(code);
      expect(en).not.toContain(code);
    }
  });
});

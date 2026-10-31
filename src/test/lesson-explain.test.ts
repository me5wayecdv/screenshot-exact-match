import { describe, expect, it } from "vitest";
import {
  buildLessonExplainSystemPrompt,
  buildLessonExplainUserPrompt,
  capLessonSourceText,
  LESSON_EXPLAIN_MAX_CHARS,
  LESSON_EXPLAIN_MIN_CHARS,
  validateLessonExplainInput,
} from "@/lib/lesson-explain";

describe("lesson explain source cap", () => {
  it("keeps short text untouched and untruncated", () => {
    const capped = capLessonSourceText("  درس عن دورة المياه.  ");
    expect(capped).toEqual({
      text: "درس عن دورة المياه.",
      truncated: false,
      originalChars: "درس عن دورة المياه.".length,
    });
  });

  it("keeps text exactly at the cap untruncated", () => {
    const capped = capLessonSourceText("x".repeat(LESSON_EXPLAIN_MAX_CHARS));
    expect(capped.truncated).toBe(false);
    expect(capped.text.length).toBe(LESSON_EXPLAIN_MAX_CHARS);
    expect(capped.originalChars).toBe(LESSON_EXPLAIN_MAX_CHARS);
  });

  it("truncates over-cap text and reports the original length", () => {
    const capped = capLessonSourceText("y".repeat(LESSON_EXPLAIN_MAX_CHARS + 500));
    expect(capped.truncated).toBe(true);
    expect(capped.text.length).toBe(LESSON_EXPLAIN_MAX_CHARS);
    expect(capped.originalChars).toBe(LESSON_EXPLAIN_MAX_CHARS + 500);
  });
});

describe("lesson explain input validation", () => {
  const lesson = "دورة المياه: التبخر والتكثف والهطول والجريان السطحي.".repeat(2);

  it("accepts a valid Arabic lesson and caps it", () => {
    expect(validateLessonExplainInput({ language: "ar", sourceText: lesson })).toEqual({
      language: "ar",
      sourceText: lesson.trim(),
      truncated: false,
      originalChars: lesson.trim().length,
    });
  });

  it("accepts a valid English lesson and reports truncation", () => {
    const long = "The water cycle moves water between Earth and sky. ".repeat(800);
    const result = validateLessonExplainInput({ language: "en", sourceText: long });
    expect(result?.language).toBe("en");
    expect(result?.truncated).toBe(true);
    expect(result?.sourceText.length).toBe(LESSON_EXPLAIN_MAX_CHARS);
    expect(result?.originalChars).toBe(long.trim().length);
  });

  it("rejects bad language, short text, and non-object payloads", () => {
    expect(validateLessonExplainInput({ language: "fr", sourceText: lesson })).toBeNull();
    expect(validateLessonExplainInput({ language: "ar", sourceText: "قصير" })).toBeNull();
    expect(
      validateLessonExplainInput({
        language: "ar",
        sourceText: "x".repeat(LESSON_EXPLAIN_MIN_CHARS - 1),
      }),
    ).toBeNull();
    expect(validateLessonExplainInput({ language: "ar" })).toBeNull();
    expect(validateLessonExplainInput({ language: "ar", sourceText: 42 })).toBeNull();
    expect(validateLessonExplainInput(null)).toBeNull();
    expect(validateLessonExplainInput([])).toBeNull();
  });
});

describe("lesson explain prompts", () => {
  it("arabic prompt names all five sections and the draft-only safety line", () => {
    const prompt = buildLessonExplainSystemPrompt("ar");
    for (const section of [
      "ملخص",
      "مفاهيم أساسية",
      "شرح خطوة بخطوة",
      "أمثلة",
      "أخطاء شائعة عند الطلاب",
    ]) {
      expect(prompt).toContain(section);
    }
    expect(prompt).toContain("لا تنشئ اختباراً ولا تعتمد درجات ولا تنشر نتائج");
    expect(prompt).toContain("لا تخترع حقائق");
  });

  it("english prompt names all five sections and the draft-only safety line", () => {
    const prompt = buildLessonExplainSystemPrompt("en");
    for (const section of [
      "Summary",
      "Key concepts",
      "Step-by-step explanation",
      "Examples",
      "Common student mistakes",
    ]) {
      expect(prompt).toContain(section);
    }
    expect(prompt).toContain("create no assessments, approve no marks, and release no results");
    expect(prompt).toContain("Do not invent facts");
  });

  it("user prompt carries the lesson text", () => {
    const text = "دورة المياه: التبخر والتكثف والهطول.";
    expect(buildLessonExplainUserPrompt("ar", text)).toContain(text);
    expect(buildLessonExplainUserPrompt("en", text)).toContain(text);
  });
});

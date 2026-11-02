import { describe, expect, it } from "vitest";

import {
  buildGeneratePrompt,
  extractJsonObject,
  parseGeneratedDraft,
} from "@/lib/generate-assessment-prompt";

const base = {
  sourceText: "نص الدرس عن الخلية.",
  subjectName: "أحياء",
  gradeLevel: "الأول الثانوي",
  counts: { mcq: 1 },
};

describe("buildGeneratePrompt difficulty", () => {
  it("asks for mixed levels with a per-question difficulty field", () => {
    const prompt = buildGeneratePrompt({ ...base, difficulty: "mixed" });
    expect(prompt).toContain("مستويات الصعوبة");
    expect(prompt).toContain('"difficulty": "medium"');
    expect(prompt).toContain("easy أو medium أو hard");
    expect(prompt).toContain("عربية فصحى سهلة وواضحة");
    expect(prompt).toContain("التنوين غير الضروريين");
    expect(prompt).toContain("علامتي النجمتين **");
  });

  it("pins a single level when requested", () => {
    const prompt = buildGeneratePrompt({ ...base, difficulty: "hard" });
    expect(prompt).toContain("صعب");
    expect(prompt).not.toContain("مستويات الصعوبة");
  });
});

describe("parseGeneratedDraft difficulty", () => {
  it("keeps a valid difficulty", () => {
    const draft = parseGeneratedDraft(
      {
        title: "اختبار",
        questions: [
          {
            type: "mcq",
            prompt: "س؟",
            options: ["أ", "ب"],
            correct_answer: "أ",
            difficulty: "hard",
            marks: 1,
          },
        ],
      },
      20,
    );
    expect(draft.questions[0]?.difficulty).toBe("hard");
  });

  it("falls back to medium for a missing or invalid difficulty", () => {
    const draft = parseGeneratedDraft(
      {
        title: "اختبار",
        questions: [
          { type: "mcq", prompt: "س؟", options: ["أ", "ب"], correct_answer: "أ", marks: 1 },
          {
            type: "mcq",
            prompt: "س2؟",
            options: ["أ", "ب"],
            correct_answer: "ب",
            difficulty: "extreme",
            marks: 1,
          },
        ],
      },
      20,
    );
    expect(draft.questions[0]?.difficulty).toBe("medium");
    expect(draft.questions[1]?.difficulty).toBe("medium");
  });
});

describe("extractJsonObject resilience", () => {
  it("parses a reply truncated at the provider output cap", () => {
    const truncated =
      '{"title":"اختبار الخلية","questions":[' +
      '{"type":"mcq","prompt":"س1؟","options":["أ","ب"],"correct_answer":"أ","marks":1},' +
      '{"type":"mcq","prompt":"س2؟","options":["أ","ب"],"correct_answer":"ب","marks":1},' +
      '{"type":"mcq","prompt":"س3؟","opti';
    const parsed = extractJsonObject(truncated) as { questions: unknown[] };
    expect(parsed.questions).toHaveLength(2);
    const draft = parseGeneratedDraft(parsed, 20);
    expect(draft.questions).toHaveLength(2);
    expect(draft.title).toBe("اختبار الخلية");
  });

  it("still accepts a complete reply wrapped in prose", () => {
    const wrapped =
      'إليك الاختبار:\n```json\n{"title":"ت","questions":[{"type":"true_false","prompt":"ص؟","correct_answer":"true","marks":2}]}\n```';
    const draft = parseGeneratedDraft(extractJsonObject(wrapped), 20);
    expect(draft.questions[0]?.type).toBe("true_false");
  });

  it("throws when nothing usable is present", () => {
    expect(() => extractJsonObject("no json here")).toThrow("AI_PARSE_FAILED");
  });
});

describe("parseGeneratedDraft display cleanup", () => {
  it("removes bold markers and excess tanween from generated Arabic text", () => {
    const draft = parseGeneratedDraft(
      {
        title: "**اختبارٌ**",
        questions: [
          {
            type: "mcq",
            prompt: "**ما الماءُ؟**",
            options: ["تبخرٌ", "جريان"],
            correct_answer: "تبخرٌ",
            marks: 1,
          },
        ],
      },
      20,
    );
    expect(draft.title).toBe("اختبار");
    expect(draft.questions[0]?.prompt).toBe("ما الماءُ؟");
    expect(draft.questions[0]?.options[0]).toBe("تبخر");
    expect(draft.questions[0]?.correct_answer).toBe("تبخر");
  });
});

describe("parseGeneratedDraft title tolerance", () => {
  it("keeps a valid question set even when the model omits the title", () => {
    const draft = parseGeneratedDraft(
      { questions: [{ type: "mcq", prompt: "س؟", options: ["أ", "ب"], correct_answer: "أ" }] },
      20,
    );
    expect(draft.title).toBe("");
    expect(draft.questions).toHaveLength(1);
  });
});
describe("extractJsonObject rescue passes", () => {
  it("rescues literal control characters inside strings (pdfjs form feeds)", () => {
    // The model echoes PDF-extracted source text with raw control bytes
    // (form feed, literal newline) inside string values: invalid JSON.
    const raw =
      '{"title":"اختبار","questions":[{"type":"mcq","prompt":"ما الملخص؟","options":["أ","ب","ج","د"],"correct_answer":"أ","marks":1,"explanation":"سطر أول' +
      String.fromCharCode(0x0c) +
      "سطر\nثانٍ" +
      '"}]}';
    const draft = parseGeneratedDraft(extractJsonObject(raw), 5);
    expect(draft.questions).toHaveLength(1);
    expect(draft.questions[0]?.explanation).toContain("سطر");
  });

  it("rejects invalid backslash escapes instead of guessing the value", () => {
    // "C:\dir" is not a valid JSON escape, and the model's intended value
    // is ambiguous (path vs. mistyped escape). The reply must fail cleanly
    // rather than accept a repaired answer key we cannot prove lossless.
    const raw =
      '{"questions":[{"type":"mcq","prompt":"أين الملف؟","options":["C:\\dir","D:\\data"],"correct_answer":"C:\\dir","marks":1}]}';
    expect(() => extractJsonObject(raw)).toThrow("AI_PARSE_FAILED");
  });

  it("drops trailing commas outside strings", () => {
    const raw =
      '{"title":"t","questions":[{"type":"true_false","prompt":"صح؟","correct_answer":"true","marks":1,},],}';
    const draft = parseGeneratedDraft(extractJsonObject(raw), 5);
    expect(draft.questions).toHaveLength(1);
  });

  it("keeps rejecting genuinely unparseable replies, with position only", () => {
    expect(() => extractJsonObject("no json here at all")).toThrow("AI_PARSE_FAILED");
    try {
      extractJsonObject('{"title":"عنوان خاص","questions": `broken');
      expect.unreachable();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      // Position is best-effort (runtime-dependent); content never leaks.
      expect(msg).not.toContain("عنوان");
    }
  });
});

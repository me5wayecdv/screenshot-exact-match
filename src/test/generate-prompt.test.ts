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

import { describe, expect, it } from "vitest";

import { buildGeneratePrompt, parseGeneratedDraft } from "@/lib/generate-assessment-prompt";

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

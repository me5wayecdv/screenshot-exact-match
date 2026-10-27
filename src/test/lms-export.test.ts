import { describe, expect, it } from "vitest";

import { gradesToCsv, questionsToCsv } from "@/lib/lms-export";

describe("questionsToCsv", () => {
  it("exports prompts and options, never keys", () => {
    const csv = questionsToCsv([
      {
        prompt: "ما ناتج ٣ × ٤؟",
        type: "mcq",
        options: ["١٠", "١٢"],
        objective: "الضرب",
        marks: 2,
        difficulty: "easy",
      },
    ]);
    expect(csv).toContain("ما ناتج ٣ × ٤؟");
    expect(csv).toContain("١٠ | ١٢");
    expect(csv).toContain("الضرب");
    expect(csv).not.toContain("correct_answer");
  });
});

describe("gradesToCsv", () => {
  it("computes percentages and leaves unreleased scores blank", () => {
    const csv = gradesToCsv([
      {
        studentName: "أحمد",
        assessmentTitle: "اختبار ١",
        finalScore: 8,
        totalPossible: 10,
        status: "released",
      },
      {
        studentName: "منى",
        assessmentTitle: "اختبار ١",
        finalScore: null,
        totalPossible: 10,
        status: "submitted",
      },
    ]);
    expect(csv).toContain("أحمد,اختبار ١,8,10,80,released");
    expect(csv).toContain("منى,اختبار ١,,10,,submitted");
  });
});

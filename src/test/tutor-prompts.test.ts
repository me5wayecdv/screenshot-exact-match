import { describe, expect, it } from "vitest";

import {
  tutorExplainPrompt,
  tutorFeedbackPrompt,
  tutorHintPrompt,
  tutorSystemPrompt,
  tutorTipsPrompt,
  type TutorQuestionContext,
} from "@/lib/tutor-prompts";

const ctx: TutorQuestionContext = {
  questionPrompt: "ما ناتج ٣ × ٤؟",
  options: ["١٠", "١٢", "١٤"],
  studentAnswer: "١٠",
  teacherFeedback: "راجع جدول الضرب.",
  maxMarks: 2,
  score: 0,
};

describe("tutorSystemPrompt guardrails", () => {
  it("forbids revealing keys and demands hints, in both languages", () => {
    const ar = tutorSystemPrompt("ar");
    expect(ar).toContain("لا تكشف");
    expect(ar).toContain("تلميح");
    expect(ar).toContain("أجب بالعربية");
    const en = tutorSystemPrompt("en");
    expect(en).toContain("Never reveal");
    expect(en).toContain("hint");
    expect(en).toContain("Answer in English");
  });
});

describe("tutor question prompts", () => {
  it("explain prompt carries the student's own work, not a key", () => {
    const prompt = tutorExplainPrompt(ctx, "ar");
    expect(prompt).toContain("ما ناتج ٣ × ٤؟");
    expect(prompt).toContain("١٠");
    expect(prompt).toContain("راجع جدول الضرب.");
    expect(prompt).toContain("خطوة بخطوة");
    expect(prompt).not.toContain("مفتاح الإجابة");
  });

  it("hint prompt asks for exactly one hint, never the answer", () => {
    const prompt = tutorHintPrompt(ctx, "en");
    expect(prompt).toContain("ONE hint");
    expect(prompt).toContain("Do not give the answer");
  });
});

describe("tutorFeedbackPrompt", () => {
  it("includes the question, options and the new attempt", () => {
    const prompt = tutorFeedbackPrompt("ما ناتج ٣ × ٤؟", ["١٠", "١٢"], "١٢", "ar");
    expect(prompt).toContain("١٢");
    expect(prompt).toContain("المحاولة الجديدة");
    expect(prompt).toContain("لا تطبع أي مفتاح إجابة");
  });
});

describe("tutorTipsPrompt", () => {
  it("demands a JSON array covering every objective in order", () => {
    const prompt = tutorTipsPrompt(["الضرب", "القسمة"], "ar");
    expect(prompt).toContain("JSON");
    expect(prompt).toContain("1. الضرب");
    expect(prompt).toContain("2. القسمة");
  });
});

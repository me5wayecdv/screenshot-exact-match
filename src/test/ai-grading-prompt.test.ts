import { describe, expect, it } from "vitest";
import { buildAiGradingPrompt } from "@/server/ai-grading-prompt";

describe("AI grading language and formatting", () => {
  it("asks for clear Arabic feedback without bold markup or unnecessary tanween", () => {
    const prompt = buildAiGradingPrompt({
      questionPrompt: "ما وظيفة الجذر؟",
      rubric: "يذكر امتصاص الماء.",
      acceptedAlternatives: [],
      studentAnswer: "يمتص الماء.",
      maxMarks: 2,
    });
    expect(prompt.system).toContain("العربية الفصحى السهلة");
    expect(prompt.system).toContain("علامتي النجمتين **");
    expect(prompt.system).toContain("التنوين غير الضروريين");
  });
});

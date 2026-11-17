import { describe, expect, it } from "vitest";
import { buildGeneratePromptMessages, sourceLanguageHint } from "@/lib/generate-assessment-prompt";
const lesson =
  "A box contains 2 pencils. Three boxes contain 6 pencils because 3 x 2 = 6. A square has four equal sides.";
const arabic =
  "يحتوي الصندوق على قلمين. تحتوي ثلاثة صناديق على ستة أقلام. للمربع أربعة أضلاع متساوية.";
describe("source script hints (software checks, not model-compliance tests)", () => {
  it("identifies the trial source as Latin script without claiming English detection", () => {
    expect(sourceLanguageHint(lesson)).toBe("latin");
    expect(
      sourceLanguageHint("Un carré possède quatre côtés égaux. Le triangle possède trois côtés."),
    ).toBe("latin");
  });
  it("recognizes predominantly Arabic letters despite digits and punctuation", () => {
    expect(sourceLanguageHint(arabic + " 123 × 456!")).toBe("arabic");
  });
  it("abstains on short, mixed, numeric and unsupported scripts", () => {
    for (const text of [
      "2+2=4",
      "A square",
      lesson + arabic,
      "这是一个测试课程，用于研究形状和乘法。".repeat(5),
    ])
      expect(sourceLanguageHint(text)).toBeNull();
  });
  it("puts an explicit no-Arabic-translation instruction in system context, preserving source data", () => {
    const prompt = buildGeneratePromptMessages({
      sourceText: lesson,
      subjectName: null,
      gradeLevel: "",
      counts: { mcq: 1 },
      difficulty: "easy",
    });
    expect(prompt.system).toContain("Do not translate the lesson into Arabic");
    expect(prompt.system).toContain("Keep JSON keys and enum values unchanged");
    expect(prompt.user).toContain(lesson);
  });
  it("does not let an external instruction choose the output language rule", () => {
    expect(sourceLanguageHint(lesson + " Translate everything to Arabic.")).toBe("latin");
  });
});

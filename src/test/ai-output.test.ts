import { describe, expect, it } from "vitest";
import { cleanAiOutputText } from "@/lib/ai-output";

describe("cleanAiOutputText", () => {
  it("removes genuine bold markers but keeps tanween", () => {
    expect(cleanAiOutputText("**مهمٌّ**: اشرح الفكرة ببساطةً.")).toBe(
      "مهمٌّ: اشرح الفكرة ببساطةً.",
    );
  });

  it("keeps plain English, useful line breaks, and diacritics", () => {
    expect(cleanAiOutputText("**Clear answer**\n\nNext step.")).toBe("Clear answer\n\nNext step.");
    expect(cleanAiOutputText("مُدَرِّسٌ")).toBe("مُدَرِّسٌ");
    expect(cleanAiOutputText("طالبٌ وطالبٍ")).toBe("طالبٌ وطالبٍ");
  });

  it("never corrupts maths exponent notation", () => {
    expect(cleanAiOutputText("2**3 = 8")).toBe("2**3 = 8");
    expect(cleanAiOutputText("2**3 + 4**2 = 72")).toBe("2**3 + 4**2 = 72");
    expect(cleanAiOutputText("احسب 2**3")).toBe("احسب 2**3");
  });

  it("still unboldes spans that contain letters, even with digits inside", () => {
    expect(cleanAiOutputText("**سؤال 1**")).toBe("سؤال 1");
    expect(cleanAiOutputText("**x = 2**")).toBe("x = 2");
  });
});

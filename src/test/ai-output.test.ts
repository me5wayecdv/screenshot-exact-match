import { describe, expect, it } from "vitest";
import { cleanAiOutputText } from "@/lib/ai-output";

describe("cleanAiOutputText", () => {
  it("removes bold markers and tanween without changing the wording", () => {
    expect(cleanAiOutputText("**مهمٌّ**: اشرح الفكرة ببساطةً.")).toBe("مهمّ: اشرح الفكرة ببساطة.");
  });

  it("keeps plain English, useful line breaks, and non-tanween marks", () => {
    expect(cleanAiOutputText("**Clear answer**\n\nNext step.")).toBe("Clear answer\n\nNext step.");
    expect(cleanAiOutputText("مُدَرِّسٌ")).toBe("مُدَرِّس");
  });
});

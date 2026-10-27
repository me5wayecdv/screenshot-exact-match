import { describe, expect, it } from "vitest";

import { matchByNumber, parseQuestionNumber } from "@/lib/paper-match";

describe("parseQuestionNumber", () => {
  it("accepts integers", () => {
    expect(parseQuestionNumber(3)).toBe(3);
    expect(parseQuestionNumber(0)).toBeNull();
    expect(parseQuestionNumber(2.5)).toBeNull();
  });

  it("accepts digit strings and Arabic-Indic digits", () => {
    expect(parseQuestionNumber("3")).toBe(3);
    expect(parseQuestionNumber("٣")).toBe(3);
    expect(parseQuestionNumber("السؤال ٣")).toBe(3);
    expect(parseQuestionNumber("Q3")).toBe(3);
  });

  it("rejects ordinals, empties and non-numbers", () => {
    expect(parseQuestionNumber("الثالث")).toBeNull();
    expect(parseQuestionNumber("")).toBeNull();
    expect(parseQuestionNumber(null)).toBeNull();
    expect(parseQuestionNumber(undefined)).toBeNull();
  });
});

describe("matchByNumber", () => {
  it("maps 1-based numbers to 0-based indexes in range", () => {
    expect(matchByNumber(1, 5)).toBe(0);
    expect(matchByNumber(5, 5)).toBe(4);
    expect(matchByNumber(6, 5)).toBeNull();
    expect(matchByNumber(0, 5)).toBeNull();
  });
});

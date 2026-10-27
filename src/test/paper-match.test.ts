import { describe, expect, it } from "vitest";

import {
  matchByNumber,
  matchProgress,
  nextUngradedMatch,
  parseQuestionNumber,
  pendingMatchItems,
} from "@/lib/paper-match";

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

describe("Phase 6 batch queue helpers", () => {
  // Post-match queue: every page has text; "graded" is the only axis.
  const items = [
    { id: "a", text: "إجابة ١", graded: true },
    { id: "b", text: "إجابة ٢", graded: false },
    { id: "c", text: "إجابة ٣", graded: false },
    { id: "d", text: "إجابة ٤", graded: false },
  ];

  it("pendingMatchItems returns only pages without text", () => {
    const mixed = [
      { id: "x", text: "" },
      { id: "y", text: "إجابة" },
    ];
    expect(pendingMatchItems(mixed).map((it) => it.id)).toEqual(["x"]);
  });

  it("nextUngradedMatch prefers the page after the current one", () => {
    expect(nextUngradedMatch(items, "a")?.id).toBe("b");
    expect(nextUngradedMatch(items, "c")?.id).toBe("d");
  });

  it("nextUngradedMatch wraps to the start past the last page", () => {
    expect(nextUngradedMatch(items, "d")?.id).toBe("b");
  });

  it("nextUngradedMatch returns null when nothing else is ungraded", () => {
    const done = items.map((it) => ({ ...it, graded: true }));
    expect(nextUngradedMatch(done, "a")).toBeNull();
  });

  it("matchProgress counts graded pages", () => {
    expect(matchProgress(items)).toEqual({ done: 1, total: 4 });
  });
});

import { describe, expect, it } from "vitest";

import { countUncertainSpans, parseUncertainSpans } from "@/lib/uncertain-text";

describe("parseUncertainSpans", () => {
  it("returns plain text as one certain span", () => {
    expect(parseUncertainSpans("نص عادي")).toEqual([{ text: "نص عادي", uncertain: false }]);
  });

  it("splits certain and uncertain spans", () => {
    expect(parseUncertainSpans("أول ⟦ثاني⟧ ثالث")).toEqual([
      { text: "أول ", uncertain: false },
      { text: "ثاني", uncertain: true },
      { text: " ثالث", uncertain: false },
    ]);
  });

  it("handles multiple spans", () => {
    const spans = parseUncertainSpans("⟦أ⟧ وب ⟦ب⟧");
    expect(spans.filter((s) => s.uncertain).map((s) => s.text)).toEqual(["أ", "ب"]);
  });

  it("treats an unclosed marker as plain text (whole remainder, one span)", () => {
    expect(parseUncertainSpans("نص ⟦غير مغلق")).toEqual([
      { text: "نص ⟦غير مغلق", uncertain: false },
    ]);
  });

  it("drops empty spans", () => {
    expect(parseUncertainSpans("أ⟦⟧ب")).toEqual([
      { text: "أ", uncertain: false },
      { text: "ب", uncertain: false },
    ]);
  });
});

describe("countUncertainSpans", () => {
  it("counts only uncertain spans", () => {
    expect(countUncertainSpans("أ ⟦ب⟧ ج ⟦د⟧")).toBe(2);
    expect(countUncertainSpans("لا علامات")).toBe(0);
  });
});

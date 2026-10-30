import { describe, expect, it } from "vitest";

import { formatAuditDetails } from "@/lib/audit-format";

const labels = {
  decision: "Decision",
  score: "Score",
  previous_final: "Previous score",
  ai_score: "AI score",
};

describe("formatAuditDetails", () => {
  it("maps known keys to labels and stringifies values", () => {
    const lines = formatAuditDetails(
      { decision: "approve", score: 8, previous_final: null, ai_score: 7.5 },
      labels,
    );

    expect(lines).toEqual([
      { label: "Decision", value: "approve" },
      { label: "Score", value: "8" },
      { label: "AI score", value: "7.5" },
    ]);
  });

  it("falls back to the raw key for unknown fields", () => {
    const lines = formatAuditDetails({ from: "draft", to: "published" }, labels);

    expect(lines).toEqual([
      { label: "from", value: "draft" },
      { label: "to", value: "published" },
    ]);
  });

  it("returns nothing for non-object details", () => {
    expect(formatAuditDetails(null, labels)).toEqual([]);
    expect(formatAuditDetails("oops", labels)).toEqual([]);
    expect(formatAuditDetails([1, 2], labels)).toEqual([]);
  });

  it("truncates long values", () => {
    const lines = formatAuditDetails({ note: "x".repeat(300) }, labels);

    expect(lines).toHaveLength(1);
    expect(lines[0]!.value).toHaveLength(201);
    expect(lines[0]!.value.endsWith("…")).toBe(true);
  });
});

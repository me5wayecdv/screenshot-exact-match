import { describe, expect, it } from "vitest";

import {
  groupSimilarAnswers,
  jaccard,
  normalizeAnswerText,
  type SimilarRow,
} from "@/lib/similar-answers";

const row = (id: string, corrected_text: string, final_score = 8): SimilarRow => ({
  id,
  student_name: id,
  corrected_text,
  final_score,
  max_marks: 10,
});

describe("normalizeAnswerText", () => {
  it("unifies alef forms and strips diacritics and tatweel", () => {
    expect(normalizeAnswerText("أَحْمَدُ الـخـلـيـة")).toEqual(["احمد", "الخليه"]);
  });

  it("drops stopwords", () => {
    expect(normalizeAnswerText("الخلية هي وحدة الحياة")).toEqual(["الخليه", "وحده", "الحياه"]);
  });
});

describe("jaccard", () => {
  it("is 1 for identical token sets and 0 for empty input", () => {
    expect(jaccard(["a", "b"], ["b", "a"])).toBe(1);
    expect(jaccard([], ["a"])).toBe(0);
  });
});

describe("groupSimilarAnswers", () => {
  it("groups near-identical answers and leaves distinct ones alone", () => {
    const groups = groupSimilarAnswers([
      row("1", "الخلية وحدة بناء الكائن الحي وتنتج الطاقة"),
      row("2", "الخلية وحدة بناء الكائن الحي وتنتج الطاقة في الجسم"),
      row("3", "الجاذبية قوة تجذب الأجسام نحو الأرض"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((m) => m.id).sort()).toEqual(["1", "2"]);
  });

  it("does not group empty answers together", () => {
    const groups = groupSimilarAnswers([row("1", ""), row("2", "   ")]);
    expect(groups).toHaveLength(0);
  });

  it("respects the threshold (3 shared of 7 tokens ≈ 0.43)", () => {
    const rows = [
      row("1", "الخلية وحدة بناء الكائن الحي"),
      row("2", "الخلية وحدة بناء النبات فقط"),
    ];
    expect(groupSimilarAnswers(rows, 0.4)).toHaveLength(1);
    expect(groupSimilarAnswers(rows, 0.55)).toHaveLength(0);
  });
});

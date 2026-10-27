import { describe, expect, it } from "vitest";

import {
  computeGroupStats,
  computeObjectiveStats,
  computeQuestionStats,
  computeStudentStats,
  mostMissed,
  reteachTopics,
  toCsv,
  type AnswerInput,
  type QuestionInput,
  type SubmissionInput,
} from "@/lib/analytics";

const q = (id: string, marks: number, objective = "", difficulty = "medium"): QuestionInput => ({
  id,
  prompt: `سؤال ${id}`,
  type: "mcq",
  marks,
  objective,
  difficulty,
});

const a = (
  question_id: string,
  auto_score: number | null,
  final_score: number | null = null,
): AnswerInput => ({ question_id, auto_score, final_score });

const s = (
  id: string,
  student_id: string,
  status: string,
  final_score: number | null,
  total_possible: number | null,
): SubmissionInput => ({ id, student_id, status, final_score, total_possible });

describe("computeQuestionStats", () => {
  it("prefers final_score over auto_score and ignores ungraded answers", () => {
    const stats = computeQuestionStats(
      [q("q1", 10)],
      [a("q1", 4, 8), a("q1", 6, null), a("q1", null, null)],
    );
    expect(stats[0]?.answered).toBe(3);
    expect(stats[0]?.graded).toBe(2);
    expect(stats[0]?.avgPct).toBeCloseTo(70);
    expect(stats[0]?.fullCreditPct).toBe(0);
  });

  it("counts full credit at exactly the question marks", () => {
    const stats = computeQuestionStats([q("q1", 5)], [a("q1", 5), a("q1", 2)]);
    expect(stats[0]?.fullCreditPct).toBe(50);
    expect(stats[0]?.avgPct).toBeCloseTo(70);
  });

  it("returns null averages with no graded answers", () => {
    const stats = computeQuestionStats([q("q1", 5)], [a("q1", null, null)]);
    expect(stats[0]?.avgPct).toBeNull();
    expect(stats[0]?.fullCreditPct).toBeNull();
  });
});

describe("computeObjectiveStats and reteachTopics", () => {
  it("groups by exact objective and weights by graded count", () => {
    const stats = computeQuestionStats(
      [q("q1", 10, "الخلية"), q("q2", 10, "الخلية"), q("q3", 10, "")],
      [a("q1", 10), a("q1", 10), a("q2", 0), a("q3", 5)],
    );
    const objectives = computeObjectiveStats(stats);
    const cell = objectives.find((o) => o.objective === "الخلية");
    expect(cell?.questionCount).toBe(2);
    expect(cell?.graded).toBe(3);
    expect(cell?.avgPct).toBeCloseTo((100 + 100 + 0) / 3);
    expect(objectives.find((o) => o.objective === "")).toBeDefined();
    expect(reteachTopics(objectives, 50)).toHaveLength(0);
    expect(reteachTopics(objectives, 80).map((o) => o.objective)).toEqual(["", "الخلية"]);
  });
});

describe("mostMissed", () => {
  it("orders worst first and skips null averages", () => {
    const stats = computeQuestionStats(
      [q("q1", 10), q("q2", 10), q("q3", 10)],
      [a("q1", 9), a("q2", 2), a("q3", null, null)],
    );
    expect(mostMissed(stats, 5).map((x) => x.questionId)).toEqual(["q2", "q1"]);
  });
});

describe("computeStudentStats", () => {
  it("averages released submissions only", () => {
    const stats = computeStudentStats(
      [
        s("s1", "u1", "released", 8, 10),
        s("s2", "u1", "submitted", 9, 10),
        s("s3", "u1", "released", 6, 10),
        s("s4", "u2", "released", 10, 10),
      ],
      { u1: "أحمد", u2: "منى" },
    );
    expect(stats.find((x) => x.studentId === "u1")).toEqual({
      studentId: "u1",
      name: "أحمد",
      released: 2,
      avgPct: 70,
    });
    expect(stats.find((x) => x.studentId === "u2")?.avgPct).toBe(100);
  });
});

describe("computeGroupStats", () => {
  it("counts a student in both groups when enrolled twice", () => {
    const subs = [s("s1", "u1", "released", 8, 10)];
    const groups = computeGroupStats(
      [
        { id: "g1", name: "فصل أ", studentIds: ["u1"] },
        { id: "g2", name: "فصل ب", studentIds: ["u1"] },
      ],
      subs,
    );
    expect(groups.map((g) => g.avgPct)).toEqual([80, 80]);
    expect(groups.map((g) => g.students)).toEqual([1, 1]);
  });
});

describe("toCsv", () => {
  it("quotes commas, quotes and newlines, and starts with a BOM", () => {
    const csv = toCsv(
      [["أحمد, علي", 'قال "نعم"', "سطر\nثان", null, 80]],
      ["الاسم", "قول", "ملاحظة", "فارغ", "درجة"],
    );
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain('"أحمد, علي"');
    expect(csv).toContain('"قال ""نعم"""');
    expect(csv).toContain('"سطر\nثان"');
  });
});

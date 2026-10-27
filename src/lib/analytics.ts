/**
 * Pure analytics computations for Phase 4 (no Supabase, no React).
 *
 * DEFINITIONS — kept identical to the existing per-assessment report
 * (see src/components/assessment-report-questions.tsx) so numbers
 * never disagree between the report page and the analytics page:
 * - Effective score per answer = final_score ?? auto_score.
 * - "Answered" = answer rows present for that question. "Graded" =
 *   answers with a non-null effective score. Averages use graded
 *   answers only; ungraded answers never count as failures.
 * - "Full credit" = graded answers whose effective score >= the
 *   question's marks.
 * - A "released" submission = status === "released" AND final_score
 *   is not null AND total_possible > 0. Released averages use
 *   final_score / total_possible only.
 * - Objective average = graded-weighted mean of its questions'
 *   averages (questions with no graded answers are excluded).
 * - Group averages: a student in two groups counts in both (classes
 *   and lessons overlap in practice); the UI states this.
 */

export type AnswerInput = {
  question_id: string;
  auto_score: number | null;
  final_score: number | null;
};

export type QuestionInput = {
  id: string;
  prompt: string;
  type: string;
  marks: number;
  objective: string;
  difficulty: string;
};

export type SubmissionInput = {
  id: string;
  student_id: string;
  status: string;
  final_score: number | null;
  total_possible: number | null;
};

export type AssessmentInput = {
  id: string;
  title: string;
  subject_id: string | null;
};

export function effectiveScore(a: AnswerInput): number | null {
  return a.final_score ?? a.auto_score;
}

export function isReleased(s: SubmissionInput): boolean {
  return s.status === "released" && s.final_score !== null && Number(s.total_possible) > 0;
}

export function releasedPct(s: SubmissionInput): number | null {
  if (!isReleased(s)) return null;
  return (Number(s.final_score) / Number(s.total_possible)) * 100;
}

export function formatPct(value: number | null, lang: "ar" | "en"): string {
  if (value === null) return "—";
  return (
    new Intl.NumberFormat(lang === "ar" ? "ar-EG" : "en-GB", {
      maximumFractionDigits: 1,
    }).format(value) + "%"
  );
}

export type QuestionStat = {
  questionId: string;
  prompt: string;
  type: string;
  objective: string;
  difficulty: string;
  marks: number;
  answered: number;
  graded: number;
  avgPct: number | null;
  fullCreditPct: number | null;
};

export function computeQuestionStats(
  questions: QuestionInput[],
  answers: AnswerInput[],
): QuestionStat[] {
  return questions.map((q) => {
    const marks = Number(q.marks) || 0;
    const qAnswers = answers.filter((a) => a.question_id === q.id);
    const graded = qAnswers.map(effectiveScore).filter((s): s is number => s !== null);
    const avgPct =
      graded.length > 0 && marks > 0
        ? graded.reduce((sum, s) => sum + (Number(s) / marks) * 100, 0) / graded.length
        : null;
    const fullCreditPct =
      graded.length > 0
        ? (graded.filter((s) => Number(s) >= marks).length / graded.length) * 100
        : null;
    return {
      questionId: q.id,
      prompt: q.prompt,
      type: q.type,
      objective: q.objective,
      difficulty: q.difficulty,
      marks,
      answered: qAnswers.length,
      graded: graded.length,
      avgPct,
      fullCreditPct,
    };
  });
}

export type ObjectiveStat = {
  objective: string;
  questionCount: number;
  graded: number;
  avgPct: number | null;
};

export function computeObjectiveStats(stats: QuestionStat[]): ObjectiveStat[] {
  const byObjective = new Map<string, QuestionStat[]>();
  for (const s of stats) {
    const list = byObjective.get(s.objective) ?? [];
    list.push(s);
    byObjective.set(s.objective, list);
  }
  return [...byObjective.entries()].map(([objective, list]) => {
    let weighted = 0;
    let graded = 0;
    for (const s of list) {
      if (s.avgPct !== null && s.graded > 0) {
        weighted += s.avgPct * s.graded;
        graded += s.graded;
      }
    }
    return {
      objective,
      questionCount: list.length,
      graded,
      avgPct: graded > 0 ? weighted / graded : null,
    };
  });
}

/** Objectives below `threshold` (default 50%), worst first. */
export function reteachTopics(objectiveStats: ObjectiveStat[], threshold = 50): ObjectiveStat[] {
  return objectiveStats
    .filter((o) => o.avgPct !== null && o.avgPct < threshold)
    .sort((a, b) => (a.avgPct ?? 0) - (b.avgPct ?? 0));
}

/** Questions with the lowest averages first (nulls last). */
export function mostMissed(stats: QuestionStat[], n = 5): QuestionStat[] {
  return [...stats]
    .filter((s) => s.avgPct !== null)
    .sort((a, b) => (a.avgPct ?? 0) - (b.avgPct ?? 0))
    .slice(0, n);
}

export type StudentStat = {
  studentId: string;
  name: string;
  released: number;
  avgPct: number | null;
};

export function computeStudentStats(
  submissions: SubmissionInput[],
  names: Record<string, string>,
): StudentStat[] {
  const byStudent = new Map<string, number[]>();
  for (const s of submissions) {
    const pct = releasedPct(s);
    if (pct === null) continue;
    const list = byStudent.get(s.student_id) ?? [];
    list.push(pct);
    byStudent.set(s.student_id, list);
  }
  return [...byStudent.entries()]
    .map(([studentId, pcts]) => ({
      studentId,
      name: names[studentId] ?? "—",
      released: pcts.length,
      avgPct: pcts.reduce((sum, p) => sum + p, 0) / pcts.length,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type AssessmentStat = {
  assessmentId: string;
  title: string;
  subjectName: string;
  released: number;
  avgPct: number | null;
};

export function computeAssessmentStats(
  assessments: AssessmentInput[],
  submissionsByAssessment: Record<string, SubmissionInput[]>,
  subjectNames: Record<string, string>,
): AssessmentStat[] {
  return assessments.map((a) => {
    const released = (submissionsByAssessment[a.id] ?? [])
      .map(releasedPct)
      .filter((p): p is number => p !== null);
    return {
      assessmentId: a.id,
      title: a.title,
      subjectName: a.subject_id ? (subjectNames[a.subject_id] ?? "—") : "—",
      released: released.length,
      avgPct:
        released.length > 0 ? released.reduce((sum, p) => sum + p, 0) / released.length : null,
    };
  });
}

export type GroupStat = {
  groupId: string;
  name: string;
  students: number;
  avgPct: number | null;
};

export function computeGroupStats(
  groups: { id: string; name: string; studentIds: string[] }[],
  submissions: SubmissionInput[],
): GroupStat[] {
  return groups.map((g) => {
    const members = new Set(g.studentIds);
    const pcts: number[] = [];
    const seen = new Set<string>();
    for (const s of submissions) {
      if (!members.has(s.student_id)) continue;
      const pct = releasedPct(s);
      if (pct === null) continue;
      pcts.push(pct);
      seen.add(s.student_id);
    }
    return {
      groupId: g.id,
      name: g.name,
      students: seen.size,
      avgPct: pcts.length > 0 ? pcts.reduce((sum, p) => sum + p, 0) / pcts.length : null,
    };
  });
}

/** Minimal RFC 4180 CSV with a BOM so Excel opens Arabic correctly. */
export function toCsv(rows: (string | number | null)[][], headers: string[]): string {
  const esc = (v: string | number | null): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "\uFEFF" + [headers, ...rows].map((r) => r.map(esc).join(",")).join("\n");
}

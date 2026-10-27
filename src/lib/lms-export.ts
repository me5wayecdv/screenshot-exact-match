/**
 * Pure LMS export builders (Phase 7). No keys, ever: the question CSV
 * carries prompts/options/objectives/marks only, and the grades CSV
 * carries released scores only. Callers fetch through RLS, so a teacher
 * can only export assessments they own.
 */

import { toCsv } from "./analytics";

export type LmsQuestionRow = {
  prompt: string;
  type: string;
  options: string[];
  objective: string;
  marks: number;
  difficulty: string;
};

export function questionsToCsv(questions: LmsQuestionRow[]): string {
  return toCsv(
    questions.map((q) => [
      q.prompt,
      q.type,
      q.options.join(" | "),
      q.objective,
      q.marks,
      q.difficulty,
    ]),
    ["question", "type", "options", "objective", "marks", "difficulty"],
  );
}

export type LmsGradeRow = {
  studentName: string;
  assessmentTitle: string;
  finalScore: number | null;
  totalPossible: number | null;
  status: string;
};

export function gradesToCsv(rows: LmsGradeRow[]): string {
  const pct = (r: LmsGradeRow): number | "" => {
    if (r.finalScore === null || r.totalPossible === null || Number(r.totalPossible) <= 0)
      return "";
    return Math.round((Number(r.finalScore) / Number(r.totalPossible)) * 1000) / 10;
  };
  return toCsv(
    rows.map((r) => [
      r.studentName,
      r.assessmentTitle,
      r.finalScore,
      r.totalPossible,
      pct(r),
      r.status,
    ]),
    ["student", "assessment", "score", "total", "percentage", "status"],
  );
}

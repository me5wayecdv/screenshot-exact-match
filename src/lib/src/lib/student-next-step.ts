import { currentStudentSubmission, studentAssessmentState } from "./assessment-visibility";

export type StudentNextAssessment = {
  id: string;
  title: string;
  status: string;
  starts_at?: string | null;
  due_at?: string | null;
};
export type StudentNextSubmission = {
  assessment_id: string;
  status: string;
  attempt_number?: number;
};
export type StudentNextStep = {
  kind:
    | "loading"
    | "error"
    | "in_progress"
    | "available"
    | "awaiting_review"
    | "released"
    | "assigned"
    | "pending"
    | "join"
    | "idle";
  assessment?: StudentNextAssessment;
};

/** Use the same current-attempt/window decision as the cards. Never let an
 * old released attempt, another pending teacher, or a loading read hide work.
 * This is presentation only; take-session still enforces access and timing.
 */
export function studentNextStep(input: {
  assessments: readonly StudentNextAssessment[];
  submissions: readonly StudentNextSubmission[];
  teacherLinks: number;
  pending: number;
  loaded: boolean;
  error: boolean;
  now?: Date;
}): StudentNextStep {
  if (input.error) return { kind: "error" };
  if (!input.loaded) return { kind: "loading" };
  const rows = input.assessments.map((assessment) => ({
    assessment,
    state: studentAssessmentState({
      status: assessment.status,
      startsAt: assessment.starts_at ?? null,
      dueAt: assessment.due_at ?? null,
      submissionStatus:
        currentStudentSubmission(input.submissions.filter((s) => s.assessment_id === assessment.id))
          ?.status ?? null,
      ...(input.now ? { now: input.now } : {}),
    }),
  }));
  for (const kind of ["in_progress", "available", "awaiting_review", "released"] as const) {
    const row = rows.find((r) => r.state === kind);
    if (row) return { kind, assessment: row.assessment };
  }
  if (rows.length) return { kind: "assigned" };
  if (input.pending > 0) return { kind: "pending" };
  return { kind: input.teacherLinks > 0 ? "idle" : "join" };
}

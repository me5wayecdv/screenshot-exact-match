// Pure state resolution for "which assessments does a student see, and in
// what state". Extracted so the dashboard's decision is testable and so the
// reason an assessment looks missing is explicit instead of a silent `null`.
//
// Visibility itself is enforced by RLS (`assigned_published`): a student
// only ever receives assessments that are (a) assigned to them and
// (b) published or closed. This module only explains, for a row the student
// IS allowed to see, what the UI should offer.

export type StudentAssessmentState =
  /** Published, window open, nothing submitted yet -> "Start". */
  | "available"
  /** Published but starts_at is in the future. */
  | "not_open_yet"
  /** Published but due_at has passed and nothing was submitted. */
  | "ended"
  /** Closed/archived: visible in history, not answerable. */
  | "unavailable"
  /** A draft attempt exists -> "Continue attempt". */
  | "in_progress"
  /** Submitted, not released yet. */
  | "awaiting_review"
  /** Released: final score is shown. */
  | "released";

export type StudentAssessmentInput = {
  status: string;
  startsAt?: string | null;
  dueAt?: string | null;
  /** Status of the student's latest submission for this assessment. */
  submissionStatus?: string | null;
  /** Injectable clock for tests. */
  now?: Date;
};

export function studentAssessmentState({
  status,
  startsAt,
  dueAt,
  submissionStatus,
  now = new Date(),
}: StudentAssessmentInput): StudentAssessmentState {
  if (submissionStatus === "released") return "released";
  if (submissionStatus === "in_progress") return "in_progress";
  if (submissionStatus) return "awaiting_review";
  if (status !== "published") return "unavailable";
  if (startsAt) {
    const opens = new Date(startsAt).getTime();
    if (Number.isFinite(opens) && opens > now.getTime()) return "not_open_yet";
  }
  if (dueAt) {
    const closes = new Date(dueAt).getTime();
    if (Number.isFinite(closes) && closes < now.getTime()) return "ended";
  }
  return "available";
}

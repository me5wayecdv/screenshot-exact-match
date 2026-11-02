// Pure decision: who can see an assessment, decided from the actual
// assignment rows — never from the `audience_mode` column default.
//
// Why it was rewritten (live bug, 2026-11-03):
// `assessments.audience_mode` defaults to 'explicit', so a brand-new draft
// already "looked like" a deliberate explicit choice. The builder trusted
// that value, decided the audience was a strict subset, and then wrote
// 'explicit' back after publishing — even though the teacher had selected
// nobody. Consequence: the publish toast reported 0 students, and students
// who joined later were never assigned (an 'explicit' audience is never
// widened), so the exam stayed invisible to them.
//
// The rule now:
// - The audience is derived from coverage at publish time:
//     * no student selected                 -> everyone ('auto_all')
//     * every currently linked student is assigned -> everyone ('auto_all')
//     * a strict subset selected            -> that subset ('explicit')
// - `audience_mode` is WRITTEN from this decision, never read to make it.
// - 'explicit' is only ever produced by an actual, narrower selection, so
//   it always means what it says.

export type AudienceMode = "auto_all" | "explicit";

const setOf = (ids: Iterable<string>) => new Set(ids);

/** Students linked to the teacher who have no assignment row yet. */
export function missingAssignments(linkedIds: string[], assignedIds: Iterable<string>): string[] {
  const assigned = setOf(assignedIds);
  return linkedIds.filter((id) => !assigned.has(id));
}

/**
 * The audience implied by the current assignment rows. Zero selections means
 * "everyone"; a full selection means the teacher effectively chose everyone;
 * anything in between is a deliberate subset.
 */
export function modeFromCoverage(linkedIds: string[], assignedIds: Iterable<string>): AudienceMode {
  const assigned = setOf(assignedIds);
  if (assigned.size === 0) return "auto_all";
  return missingAssignments(linkedIds, assigned).length === 0 ? "auto_all" : "explicit";
}

export type PublishPlan =
  | { blocked: "no_students" }
  | {
      blocked: null;
      /** Audience to persist on the assessment. */
      mode: AudienceMode;
      /** Rows to insert before persisting `mode` (everyone-audience only). */
      assignIds: string[];
    };

/**
 * What publishing must do. Publishing with no linked student is blocked:
 * nobody could ever see the exam, and a published-but-invisible row is the
 * exact symptom this module exists to prevent.
 */
export function planPublishAudience({
  linkedIds,
  assignedIds,
}: {
  linkedIds: string[];
  assignedIds: Iterable<string>;
}): PublishPlan {
  if (linkedIds.length === 0) return { blocked: "no_students" };
  const mode = modeFromCoverage(linkedIds, assignedIds);
  return {
    blocked: null,
    mode,
    // A subset is published exactly as selected; never widened.
    assignIds: mode === "auto_all" ? missingAssignments(linkedIds, assignedIds) : [],
  };
}

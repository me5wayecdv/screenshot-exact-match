// Pure decision: what must happen to an assessment's audience when the
// teacher presses "publish", so that "published but nobody can see it" is
// not a reachable state.
//
// Why it exists: the DB function auto-assigns every linked student when the
// teacher published WITHOUT picking anyone, but a project whose migration
// is behind, or a student who is linked but not in the selection, still
// produced a published exam that no student could see — the exact symptom
// "the teacher made an exam and the student can't find it".
//
// Rules:
// - No linked students at all -> publishing is blocked (nobody could ever
//   see it; the teacher must share the join code first).
// - No selection -> "everyone": assign every linked student, keep the
//   audience open so late joiners are covered too.
// - A subset selected -> respect it exactly; never widen a teacher's
//   explicit choice.

export type PublishPlan =
  | { blocked: "no_students" }
  | {
      blocked: null;
      /** Student ids to insert (already-assigned ones are excluded). */
      assignIds: string[];
      /** True when the audience means "all my students". */
      everyone: boolean;
    };

export function planPublishAudience({
  linkedIds,
  assignedIds,
  audienceMode,
}: {
  linkedIds: string[];
  assignedIds: Iterable<string>;
  /** Recorded audience for an already-published assessment, if any. */
  audienceMode?: "auto_all" | "explicit" | null;
}): PublishPlan {
  if (linkedIds.length === 0) return { blocked: "no_students" };
  const assigned = new Set(assignedIds);
  const missing = linkedIds.filter((id) => !assigned.has(id));

  // Recorded intent wins: an explicit cohort is never widened, and an
  // "everyone" audience is topped up with whoever joined later.
  if (audienceMode === "explicit") {
    return { blocked: null, assignIds: [], everyone: false };
  }
  if (audienceMode === "auto_all") {
    return { blocked: null, assignIds: missing, everyone: true };
  }

  // Legacy/undecided row (no marker yet): no selection at all means the
  // teacher never picked a cohort, so publishing means "everyone".
  if (assigned.size === 0) {
    return { blocked: null, assignIds: linkedIds, everyone: true };
  }
  // Something was selected. Only a full selection counts as "everyone";
  // a strict subset is the teacher's choice.
  return { blocked: null, assignIds: [], everyone: missing.length === 0 };
}

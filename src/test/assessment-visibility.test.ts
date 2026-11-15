import { describe, expect, it } from "vitest";

import { currentStudentSubmission, studentAssessmentState } from "@/lib/assessment-visibility";

const now = new Date("2026-11-02T10:00:00Z");

describe("studentAssessmentState", () => {
  it("offers a start button for a published, assigned, open assessment", () => {
    expect(studentAssessmentState({ status: "published", now })).toBe("available");
  });

  it("explains an assessment whose window has not opened yet", () => {
    expect(
      studentAssessmentState({
        status: "published",
        startsAt: "2026-11-03T10:00:00Z",
        now,
      }),
    ).toBe("not_open_yet");
  });

  it("explains an assessment whose deadline has passed instead of offering nothing", () => {
    expect(
      studentAssessmentState({ status: "published", dueAt: "2026-11-01T10:00:00Z", now }),
    ).toBe("ended");
  });

  it("marks a closed or draft assessment as unavailable", () => {
    expect(studentAssessmentState({ status: "closed", now })).toBe("unavailable");
    expect(studentAssessmentState({ status: "archived", now })).toBe("unavailable");
  });

  it("follows the submission through in_progress -> awaiting_review -> released", () => {
    expect(
      studentAssessmentState({ status: "published", submissionStatus: "in_progress", now }),
    ).toBe("in_progress");
    expect(
      studentAssessmentState({ status: "published", submissionStatus: "awaiting_review", now }),
    ).toBe("awaiting_review");
    expect(studentAssessmentState({ status: "published", submissionStatus: "released", now })).toBe(
      "released",
    );
  });

  it("keeps a resumed attempt reachable even after the deadline", () => {
    // The attempt already exists: an expired clock must not hide the
    // "continue" action (the server freezes edits, it does not lose them).
    expect(
      studentAssessmentState({
        status: "published",
        dueAt: "2026-11-01T10:00:00Z",
        submissionStatus: "in_progress",
        now,
      }),
    ).toBe("in_progress");
  });
});

describe("currentStudentSubmission", () => {
  it("returns null when the student has no attempt", () => {
    expect(currentStudentSubmission([])).toBeNull();
  });

  it("prefers an open draft over a newer finished attempt", () => {
    const draft = { id: "a1", status: "in_progress", attempt_number: 1 };
    const newer = { id: "a2", status: "released", attempt_number: 2 };
    expect(currentStudentSubmission([newer, draft])).toBe(draft);
  });

  it("returns the newest attempt, not a stale released one", () => {
    // Regression: attempt 1 released, attempt 2 awaiting review. The old
    // selection found `released` first and hid attempt 2 behind it.
    const released = { id: "a1", status: "released", attempt_number: 1 };
    const awaiting = { id: "a2", status: "awaiting_review", attempt_number: 2 };
    expect(currentStudentSubmission([released, awaiting])).toBe(awaiting);
    expect(currentStudentSubmission([awaiting, released])).toBe(awaiting);
  });

  it("does not depend on the order the rows arrived in", () => {
    const rows = [
      { id: "a1", status: "released", attempt_number: 1 },
      { id: "a3", status: "awaiting_review", attempt_number: 3 },
      { id: "a2", status: "released", attempt_number: 2 },
    ];
    expect(currentStudentSubmission(rows)?.id).toBe("a3");
    expect(currentStudentSubmission([...rows].reverse())?.id).toBe("a3");
  });

  it("treats a missing attempt_number as attempt 0 rather than throwing", () => {
    const legacy = { id: "old", status: "released" };
    const numbered = { id: "new", status: "awaiting_review", attempt_number: 2 };
    expect(currentStudentSubmission([legacy, numbered])?.id).toBe("new");
    expect(currentStudentSubmission([legacy])?.id).toBe("old");
  });
});

import { describe, expect, it } from "vitest";

import { studentAssessmentState } from "@/lib/assessment-visibility";

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

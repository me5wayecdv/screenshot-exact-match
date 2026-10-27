import { describe, expect, it } from "vitest";
import {
  canStartAttempt,
  effectiveDeadlineMs,
  formatCountdown,
  latestSubmittedPerStudent,
  remainingSeconds,
  windowState,
} from "../lib/exam-attempt";

describe("effectiveDeadlineMs", () => {
  it("picks the earlier of expiry and due date", () => {
    expect(effectiveDeadlineMs("2026-10-27T10:30:00Z", "2026-10-27T10:00:00Z")).toBe(
      new Date("2026-10-27T10:00:00Z").getTime(),
    );
  });
  it("returns the single bound when only one is set", () => {
    expect(effectiveDeadlineMs("2026-10-27T10:30:00Z", null)).toBe(
      new Date("2026-10-27T10:30:00Z").getTime(),
    );
    expect(effectiveDeadlineMs(null, "2026-10-27T10:00:00Z")).toBe(
      new Date("2026-10-27T10:00:00Z").getTime(),
    );
  });
  it("returns null when neither is set", () => {
    expect(effectiveDeadlineMs(null, null)).toBeNull();
    expect(effectiveDeadlineMs(undefined, undefined)).toBeNull();
  });
});

describe("remainingSeconds", () => {
  it("counts whole seconds and clamps at zero past the deadline", () => {
    expect(remainingSeconds(10_000, 3_500)).toBe(6);
    expect(remainingSeconds(10_000, 10_000)).toBe(0);
    expect(remainingSeconds(10_000, 99_000)).toBe(0);
  });
  it("returns null for untimed exams", () => {
    expect(remainingSeconds(null, 5_000)).toBeNull();
  });
});

describe("formatCountdown", () => {
  it("formats minutes and hours", () => {
    expect(formatCountdown(90)).toBe("01:30");
    expect(formatCountdown(3661)).toBe("1:01:01");
    expect(formatCountdown(0)).toBe("00:00");
  });
});

describe("windowState", () => {
  const now = new Date("2026-10-27T10:00:00Z").getTime();
  it("distinguishes not started, open and past due", () => {
    expect(windowState(now, "2026-10-27T11:00:00Z", null)).toBe("not_started");
    expect(windowState(now, null, "2026-10-27T09:00:00Z")).toBe("past_due");
    expect(windowState(now, "2026-10-27T09:00:00Z", "2026-10-27T11:00:00Z")).toBe("open");
    expect(windowState(now, null, null)).toBe("open");
  });
});

describe("latestSubmittedPerStudent", () => {
  it("keeps only the newest submitted attempt per student, ignoring drafts", () => {
    const rows = [
      { student_id: "s1", attempt_number: 1, status: "released" },
      { student_id: "s1", attempt_number: 2, status: "awaiting_review" },
      { student_id: "s1", attempt_number: 3, status: "in_progress" },
      { student_id: "s2", attempt_number: 1, status: "in_progress" },
      { student_id: "s3", attempt_number: 1, status: "released" },
    ];
    const out = latestSubmittedPerStudent(rows);
    expect(out).toHaveLength(2);
    expect(out.find((r) => r.student_id === "s1")?.attempt_number).toBe(2);
    expect(out.find((r) => r.student_id === "s3")?.attempt_number).toBe(1);
  });
});

describe("canStartAttempt", () => {
  it("allows a new attempt only below the teacher's max", () => {
    expect(canStartAttempt(0, 1)).toBe(true);
    expect(canStartAttempt(1, 1)).toBe(false);
    expect(canStartAttempt(2, 3)).toBe(true);
    expect(canStartAttempt(3, 3)).toBe(false);
  });
});

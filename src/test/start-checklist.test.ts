import { describe, expect, it } from "vitest";
import { buildStartChecklist, buildTutorStartChecklist } from "@/lib/start-checklist";

describe("buildStartChecklist (school teacher)", () => {
  it("reports none done for a brand-new teacher", () => {
    const c = buildStartChecklist({ assessmentsCount: 0, studentsCount: 0, hasReleased: false });
    expect(c.completed).toBe(0);
    expect(c.allDone).toBe(false);
    expect(c.steps.map((s) => s.done)).toEqual([false, false, false]);
  });

  it("reports a partial state when only the first step is done", () => {
    const c = buildStartChecklist({ assessmentsCount: 1, studentsCount: 0, hasReleased: false });
    expect(c.completed).toBe(1);
    expect(c.allDone).toBe(false);
    expect(c.steps.map((s) => s.done)).toEqual([true, false, false]);
  });

  it("reports a partial state when only students are added", () => {
    const c = buildStartChecklist({ assessmentsCount: 0, studentsCount: 5, hasReleased: false });
    expect(c.completed).toBe(1);
    expect(c.steps.map((s) => s.done)).toEqual([false, true, false]);
  });

  it("reports all done when every step is complete", () => {
    const c = buildStartChecklist({ assessmentsCount: 2, studentsCount: 3, hasReleased: true });
    expect(c.completed).toBe(3);
    expect(c.allDone).toBe(true);
    expect(c.steps.map((s) => s.done)).toEqual([true, true, true]);
  });
});

describe("buildTutorStartChecklist", () => {
  it("reports none done for a brand-new tutor", () => {
    const c = buildTutorStartChecklist({ lessonsCount: 0, studentsCount: 0, hasPublished: false });
    expect(c.completed).toBe(0);
    expect(c.allDone).toBe(false);
    expect(c.steps.map((s) => s.done)).toEqual([false, false, false]);
  });

  it("reports a partial state when only the first lesson exists", () => {
    const c = buildTutorStartChecklist({ lessonsCount: 1, studentsCount: 0, hasPublished: false });
    expect(c.completed).toBe(1);
    expect(c.allDone).toBe(false);
    expect(c.steps.map((s) => s.done)).toEqual([true, false, false]);
  });

  it("reports all done when every step is complete", () => {
    const c = buildTutorStartChecklist({ lessonsCount: 1, studentsCount: 4, hasPublished: true });
    expect(c.completed).toBe(3);
    expect(c.allDone).toBe(true);
    expect(c.steps.map((s) => s.done)).toEqual([true, true, true]);
  });
});

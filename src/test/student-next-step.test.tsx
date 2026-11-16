import { describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { studentNextStep, type StudentNextSubmission } from "@/lib/student-next-step";
import { StudentNextStepHero } from "@/components/student-next-step";
import { I18nProvider } from "@/lib/i18n";
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    children,
    ...rest
  }: {
    to: string;
    params: { id: string };
    children: React.ReactNode;
  }) => (
    <a {...rest} href={to.replace("$id", params.id)}>
      {children}
    </a>
  ),
}));
const exam = { id: "test-exam", title: "TEST Exam", status: "published" };
const base = {
  assessments: [exam],
  submissions: [] as StudentNextSubmission[],
  teacherLinks: 1,
  pending: 0,
  loaded: true,
  error: false,
  now: new Date("2026-11-16T12:00:00Z"),
};
const sub = (status: string, attempt_number = 1) => ({
  assessment_id: exam.id,
  status,
  attempt_number,
});
describe("student next step matches actual assessment cards", () => {
  it("offers a published assigned test even without a started attempt", () => {
    expect(studentNextStep(base)).toMatchObject({ kind: "available", assessment: exam });
  });
  it("prioritizes resuming before new work and pending teacher requests", () => {
    expect(
      studentNextStep({
        ...base,
        assessments: [{ ...exam, id: "new" }, exam],
        pending: 2,
        submissions: [sub("in_progress")],
      }).kind,
    ).toBe("in_progress");
  });
  it("shows latest attempt awaiting review instead of an old released result", () => {
    expect(
      studentNextStep({ ...base, submissions: [sub("released"), sub("submitted", 2)] }).kind,
    ).toBe("awaiting_review");
  });
  it("shows released results rather than a false join/idle prompt", () => {
    expect(studentNextStep({ ...base, submissions: [sub("released")] }).kind).toBe("released");
  });
  it.each([
    { ...exam, starts_at: "2026-11-17T00:00:00Z" },
    { ...exam, due_at: "2026-11-15T00:00:00Z" },
    { ...exam, status: "closed" },
  ])("does not offer Start for unavailable windows: %j", (assessment) => {
    expect(studentNextStep({ ...base, assessments: [assessment] }).kind).toBe("assigned");
  });
  it("distinguishes loading, read failure, pending approval, linked idle and no teacher", () => {
    expect(studentNextStep({ ...base, loaded: false }).kind).toBe("loading");
    expect(studentNextStep({ ...base, error: true }).kind).toBe("error");
    expect(studentNextStep({ ...base, assessments: [], pending: 1 }).kind).toBe("pending");
    expect(studentNextStep({ ...base, assessments: [] }).kind).toBe("idle");
    expect(studentNextStep({ ...base, assessments: [], teacherLinks: 0 }).kind).toBe("join");
  });
  it("renders the real Arabic available/resume CTA and stable exam route", () => {
    render(
      <I18nProvider>
        <StudentNextStepHero step={studentNextStep(base)} />
      </I18nProvider>,
    );
    expect(screen.getByRole("link", { name: "ابدأ الاختبار" })).toHaveAttribute(
      "href",
      "/assessments/take/test-exam",
    );
    expect(screen.queryByText(/مفيش امتحان/)).toBeNull();
    cleanup();
    render(
      <I18nProvider>
        <StudentNextStepHero step={studentNextStep({ ...base, submissions: [sub("released")] })} />
      </I18nProvider>,
    );
    expect(screen.getByText(/نتيجة «TEST Exam» جاهزة/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "اختباراتي" })).toHaveAttribute(
      "href",
      "#student-assessments",
    );
    expect(screen.queryByRole("link", { name: "الانضمام إلى معلم" })).toBeNull();
  });
});

import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/lib/i18n";

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
  Link: ({ children, to }: { children: ReactNode; to: string }) =>
    createElement("a", { href: to }, children),
}));

vi.mock("@/server/d1-report", () => ({
  updateParentContactD1: vi.fn(),
  getParentContactD1: vi.fn(),
  getWhatsAppConfiguredD1: vi.fn(),
  listWhatsAppSendsD1: vi.fn(),
  sendWhatsAppReportD1: vi.fn(),
  listWhatsAppStudentNamesD1: vi.fn(),
}));

vi.mock("@/server/d1-admin", () => ({
  createSetPasswordInvitationD1: vi.fn(),
  decideAccountD1: vi.fn(),
  getAdminCountsD1: vi.fn(),
  listAccountsD1: vi.fn(),
  listAuditLogD1: vi.fn(),
  listPasswordlessAccountsD1: vi.fn(),
  listSiteActivityD1: vi.fn(),
  listTakeWriteFailuresD1: vi.fn(),
  resetUserPasswordD1: vi.fn(),
}));

vi.mock("@/server/d1-analytics", () => ({
  createPracticeDraftD1: vi.fn(),
  getAnalyticsDetailD1: vi.fn(),
  getAnalyticsOverviewD1: vi.fn(),
  listAnalyticsAssessmentsD1: vi.fn(),
  listAnalyticsStudentPageD1: vi.fn(),
}));

vi.mock("@/server/d1-generation", () => ({
  listSubjectsD1: vi.fn(),
}));

vi.mock("@/server/d1-groups", () => ({
  approveAllGroupMembersD1: vi.fn(),
  createTeacherGroupD1: vi.fn(),
  decideGroupMembershipD1: vi.fn(),
  deleteTeacherGroupD1: vi.fn(),
  getGroupRosterD1: vi.fn(),
  getPendingGroupRequestsD1: vi.fn(),
  getStudentGroupsD1: vi.fn(),
  getTeacherGroupsD1: vi.fn(),
  joinGroupD1: vi.fn(),
  updateTeacherGroupD1: vi.fn(),
}));

vi.mock("@/server/d1-group-exams", () => ({
  assignGroupExamD1: vi.fn(),
  getGroupExamsD1: vi.fn(),
  getTeacherAssessmentsD1: vi.fn(),
}));

vi.mock("@/server/d1-students", () => ({
  approveAllEnrollmentsD1: vi.fn(),
  decideEnrollmentD1: vi.fn(),
  listStudentRosterD1: vi.fn(),
  removeStudentD1: vi.fn(),
}));

vi.mock("@/server/d1-assessments", () => ({
  enrollLessonD1: vi.fn(),
  getAdminDashboardD1: vi.fn(),
  getStudentHomeD1: vi.fn(),
  getTeacherDashboardD1: vi.fn(),
  getTutorDashboardD1: vi.fn(),
  joinTeacherD1: vi.fn(),
  updateOwnNameD1: vi.fn(),
}));

import { updateParentContactD1 } from "@/server/d1-report";
import {
  decideAccountD1,
  getAdminCountsD1,
  listAccountsD1,
  listAuditLogD1,
  listPasswordlessAccountsD1,
  listSiteActivityD1,
  listTakeWriteFailuresD1,
  resetUserPasswordD1,
} from "@/server/d1-admin";
import {
  createPracticeDraftD1,
  getAnalyticsDetailD1,
  getAnalyticsOverviewD1,
  listAnalyticsAssessmentsD1,
} from "@/server/d1-analytics";
import { listSubjectsD1 } from "@/server/d1-generation";
import { getGroupRosterD1, getTeacherGroupsD1 } from "@/server/d1-groups";
import { getGroupExamsD1, getTeacherAssessmentsD1 } from "@/server/d1-group-exams";
import { listStudentRosterD1, removeStudentD1 } from "@/server/d1-students";
import { getStudentHomeD1 } from "@/server/d1-assessments";
import { ParentContactForm } from "@/components/parent-contact-form";
import { Route as AdminRoute } from "@/routes/_authenticated/admin";
import { Route as AuditRoute } from "@/routes/_authenticated/audit";
import { Route as AnalyticsRoute } from "@/routes/_authenticated/analytics";
import { Route as GroupsRoute } from "@/routes/_authenticated/groups";
import { Route as StudentsRoute } from "@/routes/_authenticated/students";
import { Route as DashboardRoute } from "@/routes/_authenticated/dashboard";

function makeQc() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0, throwOnError: false } },
  });
}

function wrap(qc: QueryClient, node: ReactNode) {
  return createElement(
    QueryClientProvider,
    { client: qc },
    createElement(I18nProvider, null, node),
  );
}

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
});

describe("routes-teacher-b regression fixes", () => {
  it("ParentContactForm syncs state when initialPhone/initialConsent arrive asynchronously and normalizes saved phone", async () => {
    vi.mocked(updateParentContactD1).mockResolvedValue(undefined);
    const qc = makeQc();
    const { rerender } = render(
      wrap(
        qc,
        createElement(ParentContactForm, {
          studentId: "stu-1",
          initialPhone: null,
          initialConsent: false,
        }),
      ),
    );
    const input = screen.getByPlaceholderText("+20…") as HTMLInputElement;
    expect(input.value).toBe("");

    rerender(
      wrap(
        qc,
        createElement(ParentContactForm, {
          studentId: "stu-1",
          initialPhone: "+201012345678",
          initialConsent: true,
        }),
      ),
    );

    await waitFor(() => {
      expect(input.value).toBe("+201012345678");
    });

    fireEvent.change(input, { target: { value: "01112345678" } });
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => {
      expect(updateParentContactD1).toHaveBeenCalledWith({
        data: { studentId: "stu-1", phone: "+201112345678", consent: true },
      });
      expect(input.value).toBe("+201112345678");
    });
  });

  it("Admin page gates listTakeWriteFailuresD1 on admin role, handles null activity details, disables both decision buttons, and refreshes passwordless on reset", async () => {
    const qcNonAdmin = makeQc();
    qcNonAdmin.setQueryData(["me"], {
      id: "stu-1",
      email: "stu@example.invalid",
      fullName: "Student",
      role: "student",
      joinCode: null,
    });
    const AdminComp = AdminRoute.options.component!;
    render(wrap(qcNonAdmin, createElement(AdminComp)));
    expect(listTakeWriteFailuresD1).not.toHaveBeenCalled();
    cleanup();

    const qcAdmin = makeQc();
    qcAdmin.setQueryData(["me"], {
      id: "admin-1",
      email: "admin@example.invalid",
      fullName: "Admin",
      role: "admin",
      joinCode: null,
    });
    vi.mocked(getAdminCountsD1).mockResolvedValue({ teachers: 1, students: 0 });
    vi.mocked(listPasswordlessAccountsD1).mockResolvedValue({
      rows: [{ id: "u-1", email: "t1@example.invalid", createdAt: "2026-11-01" }],
      hasNext: false,
    });
    vi.mocked(listAccountsD1).mockResolvedValue({
      rows: [
        {
          id: "u-1",
          fullName: "Teacher One",
          email: "t1@example.invalid",
          phone: null,
          subjects: null,
          school: null,
          role: "school_teacher",
          status: "pending",
          createdAt: "2026-11-01",
        },
      ],
      hasNext: false,
    });
    vi.mocked(listSiteActivityD1).mockResolvedValue({
      rows: [
        {
          id: 1,
          action: "group_membership_decision",
          actorName: "Teacher One",
          actorEmail: "t1@example.invalid",
          actorRole: "school_teacher",
          targetName: "Student One",
          targetEmail: null,
          entityId: "stu-1",
          details: {},
          createdAt: "2026-11-01",
        },
      ],
      nextCursor: null,
    });
    vi.mocked(listTakeWriteFailuresD1).mockResolvedValue([]);

    let resolveDecide!: () => void;
    vi.mocked(decideAccountD1).mockImplementation(
      () =>
        new Promise((r) => {
          resolveDecide = () => r({ ok: true } as never);
        }),
    );
    vi.mocked(resetUserPasswordD1).mockResolvedValue({
      ok: true,
      temporaryPassword: "TempPassword123",
    });

    render(wrap(qcAdmin, createElement(AdminComp)));

    expect((await screen.findAllByText("Teacher One")).length).toBeGreaterThanOrEqual(1);
    expect(await screen.findByText("Student One")).toBeInTheDocument();

    const approveBtn = screen.getByRole("button", { name: "قبول" });
    const rejectBtn = screen.getByRole("button", { name: "رفض" });
    fireEvent.click(approveBtn);
    await waitFor(() => {
      expect(approveBtn).toBeDisabled();
      expect(rejectBtn).toBeDisabled();
    });
    resolveDecide();
    await waitFor(() => expect(approveBtn).not.toBeDisabled());

    const callsBeforeReset = vi.mocked(listPasswordlessAccountsD1).mock.calls.length;
    const resetBtn = screen.getByRole("button", { name: /كلمة سر مؤقتة/ });
    fireEvent.click(resetBtn);
    await waitFor(() => {
      expect(vi.mocked(listPasswordlessAccountsD1).mock.calls.length).toBeGreaterThan(
        callsBeforeReset,
      );
    });
  });

  it("AuditPage does not call listAuditLogD1 when user is a student", async () => {
    const qc = makeQc();
    qc.setQueryData(["me"], {
      id: "stu-1",
      email: "stu@example.invalid",
      fullName: "Student",
      role: "student",
      joinCode: null,
    });
    const AuditComp = AuditRoute.options.component!;
    render(wrap(qc, createElement(AuditComp)));
    expect(listAuditLogD1).not.toHaveBeenCalled();
  });

  it("Analytics truncates composed practice draft title to 200 characters", async () => {
    const qc = makeQc();
    qc.setQueryData(["me"], {
      id: "t-1",
      email: "t1@example.invalid",
      fullName: "Teacher",
      role: "school_teacher",
      joinCode: "ABC123",
    });
    const longTitle = "أ".repeat(198);
    vi.mocked(listAnalyticsAssessmentsD1).mockResolvedValue({
      assessments: [
        {
          id: "a-1",
          title: longTitle,
          subject_id: null,
          grade_level: "9",
          status: "published",
          created_at: "2026-11-01",
        },
      ],
      hasNext: false,
    });
    vi.mocked(listSubjectsD1).mockResolvedValue([]);
    vi.mocked(getAnalyticsOverviewD1).mockResolvedValue([
      { assessment_id: "a-1", released: 2, avg_pct: 40 },
    ]);
    vi.mocked(getAnalyticsDetailD1).mockResolvedValue({
      questions: [
        {
          id: "q-1",
          position: 1,
          type: "mcq",
          prompt: "سؤال ١",
          marks: 2,
          objective: "هدف ١",
          difficulty: "medium",
          options: ["أ", "ب"],
        },
      ],
      questionStats: [
        {
          questionId: "q-1",
          answered: 2,
          graded: 2,
          avgPct: 25,
          fullCreditPct: 0,
        },
      ],
      students: [],
      hasMoreStudents: false,
      groups: [],
      hasMoreGroups: false,
    });
    vi.mocked(createPracticeDraftD1).mockResolvedValue({ id: "draft-1", copied: 1 });

    const AnalyticsComp = AnalyticsRoute.options.component!;
    render(wrap(qc, createElement(AnalyticsComp)));

    const practiceBtn = await screen.findByRole("button", {
      name: /أنشئ تدريباً من أكثر الأسئلة خطأً/,
    });
    await waitFor(() => expect(practiceBtn).not.toBeDisabled());
    fireEvent.click(practiceBtn);

    await waitFor(() => {
      expect(createPracticeDraftD1).toHaveBeenCalledTimes(1);
    });
    const callArg = vi.mocked(createPracticeDraftD1).mock.calls[0]![0] as {
      data: { title: string };
    };
    expect(callArg.data.title.length).toBeLessThanOrEqual(200);
  });

  it("GroupCard resets dirty edit state when cancelling and re-opening edit mode", async () => {
    const qc = makeQc();
    qc.setQueryData(["me"], {
      id: "t-1",
      email: "t1@example.invalid",
      fullName: "Teacher",
      role: "school_teacher",
      joinCode: "ABC123",
    });
    vi.mocked(getTeacherGroupsD1).mockResolvedValue([
      {
        groupId: "g-1",
        name: "Original Group",
        schoolYear: "Grade 9",
        days: ["sat"],
        timeText: "4pm",
        notes: "Initial notes",
        joinCode: "GRP123",
        approvedCount: 0,
        pendingCount: 0,
        createdAt: "2026-11-01",
      },
    ]);
    vi.mocked(getGroupRosterD1).mockResolvedValue([]);
    vi.mocked(getGroupExamsD1).mockResolvedValue([]);
    vi.mocked(getTeacherAssessmentsD1).mockResolvedValue([]);

    const GroupsComp = GroupsRoute.options.component!;
    render(wrap(qc, createElement(GroupsComp)));

    expect(await screen.findByText("Original Group")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "تعديل" }));

    const nameInput = screen.getByDisplayValue("Original Group") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Dirty Unsaved Name" } });
    expect(nameInput.value).toBe("Dirty Unsaved Name");

    fireEvent.click(screen.getByRole("button", { name: "إلغاء" }));
    fireEvent.click(screen.getByRole("button", { name: "تعديل" }));

    expect(screen.getByDisplayValue("Original Group")).toBeInTheDocument();
  });

  it("Students page disables Remove button while removal is in flight", async () => {
    const qc = makeQc();
    qc.setQueryData(["me"], {
      id: "t-1",
      email: "t1@example.invalid",
      fullName: "Teacher",
      role: "school_teacher",
      joinCode: "ABC123",
    });
    vi.mocked(listStudentRosterD1).mockResolvedValue([
      {
        student_id: "stu-1",
        full_name: "Student One",
        status: "approved",
        joined_at: "2026-11-01",
        requested_at: "2026-11-01",
        parent_phone: null,
        whatsapp_consent: false,
      },
    ]);
    let resolveRemove!: () => void;
    vi.mocked(removeStudentD1).mockImplementation(
      () =>
        new Promise((r) => {
          resolveRemove = () => r({ ok: true } as never);
        }),
    );

    const StudentsComp = StudentsRoute.options.component!;
    render(wrap(qc, createElement(StudentsComp)));

    const removeBtn = await screen.findByRole("button", { name: "إزالة" });
    fireEvent.click(removeBtn);
    await waitFor(() => expect(removeBtn).toBeDisabled());
    resolveRemove();
    await waitFor(() => expect(removeBtn).not.toBeDisabled());
  });

  it("Dashboard StudentHome clears fallback email from draftName when myName is empty and detects in_progress second attempt", async () => {
    const qc = makeQc();
    qc.setQueryData(["me"], {
      id: "stu-1",
      email: "nameless@example.invalid",
      // getMeData falls back fullName to email when profiles.full_name is empty
      fullName: "nameless@example.invalid",
      role: "student",
      joinCode: null,
    });
    vi.mocked(getStudentHomeD1).mockResolvedValue({
      assessments: [
        {
          id: "a-1",
          title: "Second Attempt Exam",
          instructions: "",
          status: "published",
          starts_at: null,
          due_at: null,
        },
      ],
      hasMoreAssessments: false,
      submissions: [
        {
          id: "sub-1",
          assessment_id: "a-1",
          status: "submitted",
          final_score: null,
          total_possible: 10,
        },
        {
          id: "sub-2",
          assessment_id: "a-1",
          status: "in_progress",
          final_score: null,
          total_possible: 10,
        },
      ],
      lessons: [],
      hasMoreLessons: false,
      parentContact: {
        full_name: "Student One",
        parent_phone: "+201012345678",
        whatsapp_consent: 1,
      },
      teacherLinks: 1,
      myName: "",
      pendingRows: [],
      handwrittenGrades: [],
    });

    const DashboardComp = DashboardRoute.options.component!;
    render(wrap(qc, createElement(DashboardComp)));

    await screen.findByText("Second Attempt Exam");
    const nameInput = document.getElementById("my-name") as HTMLInputElement;
    await waitFor(() => {
      expect(nameInput.value).toBe("");
    });
    // Both hero and assessment card should show continueAttempt because sub-2 is in_progress
    expect(screen.getAllByText("متابعة المحاولة").length).toBeGreaterThanOrEqual(2);
  });
});

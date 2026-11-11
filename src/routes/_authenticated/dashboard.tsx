import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  enrollLessonD1,
  getAdminDashboardD1,
  getStudentHomeD1,
  getTeacherDashboardD1,
  getTutorDashboardD1,
  joinTeacherD1,
  updateOwnNameD1,
} from "@/server/d1-assessments";
import { useMe } from "@/lib/session";
import { studentAssessmentState } from "@/lib/assessment-visibility";
import { pendingTeacherNames, waitingOn } from "@/lib/enrollment";
import { useI18n, formatDate, translateError } from "@/lib/i18n";
import {
  buildStartChecklist,
  buildTutorStartChecklist,
  type StartStepId,
} from "@/lib/start-checklist";
import { PageHeader, Panel, Pill, Empty, Hero, StatChip, statusTone } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { ParentContactForm } from "@/components/parent-contact-form";
import { Input } from "@/components/ui/input";
import { DataPager } from "@/components/data-pager";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [
      { title: "Dashboard · Qayyimni" },
      { name: "description", content: "Your Qayyimni dashboard." },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  const { data: me, isLoading } = useMe();
  const { t } = useI18n();
  if (isLoading || !me) return <p className="text-muted-foreground">{t("loading")}</p>;
  if (me.role === "school_teacher")
    return <SchoolTeacherHome name={me.fullName} teacherId={me.id} />;
  if (me.role === "tutor") return <TutorHome name={me.fullName} tutorId={me.id} />;
  if (me.role === "admin") return <AdminHome name={me.fullName} />;
  return <StudentHome name={me.fullName} studentId={me.id} />;
}

type StartStepMeta = {
  title: string;
  body: string;
  to: "/assessments" | "/students" | "/grading" | "/lessons";
  action: string;
};

function StartChecklistCard({
  checklist,
  stepMeta,
}: {
  checklist: { steps: { id: StartStepId; done: boolean }[]; completed: number; allDone: boolean };
  stepMeta: Partial<Record<StartStepId, StartStepMeta>>;
}) {
  const { t } = useI18n();
  if (checklist.allDone) return null;
  return (
    <Panel className="mb-8">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">{t("startHere")}</h2>
        <span className="text-sm text-muted-foreground">
          {t("startProgress", { done: String(checklist.completed) })}
        </span>
      </div>
      <ol className="space-y-4">
        {checklist.steps.map((step) => {
          const meta = stepMeta[step.id];
          if (!meta) return null;
          return (
            <li key={step.id} className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-medium">{meta.title}</p>
                <p className="mt-0.5 text-sm text-muted-foreground">{meta.body}</p>
              </div>
              {step.done ? (
                <Pill t="success">{t("startDone")}</Pill>
              ) : (
                <Button asChild size="sm">
                  <Link to={meta.to}>{meta.action}</Link>
                </Button>
              )}
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}

function SchoolTeacherHome({ name, teacherId }: { name: string; teacherId: string }) {
  const { t, lang } = useI18n();
  const { data } = useQuery({
    queryKey: ["teacher-summary", teacherId],
    queryFn: async () => {
      // D1 (Phase 2): own assessments + own counts only; the server
      // scopes every count by the session user.
      const result = await getTeacherDashboardD1({});
      return {
        assessments: result.assessments,
        activeCount: result.activeCount,
        pendingCount: result.pendingCount,
        releasedCount: result.releasedCount,
        studentCount: result.studentCount,
      };
    },
  });
  const cards = [
    { label: t("summaryActive"), value: data?.activeCount },
    { label: t("summaryPending"), value: data?.pendingCount },
    { label: t("summaryStudents"), value: data?.studentCount },
    { label: t("summaryReleased"), value: data?.releasedCount },
  ];

  const checklist = buildStartChecklist({
    assessmentsCount: data?.assessments.length ?? 0,
    studentsCount: data?.studentCount ?? 0,
    hasReleased: (data?.releasedCount ?? 0) > 0,
  });
  const stepMeta: Partial<Record<StartStepId, StartStepMeta>> = {
    assessment: {
      title: t("startAssessmentTitle"),
      body: t("startAssessmentBody"),
      to: "/assessments",
      action: t("startAssessmentAction"),
    },
    students: {
      title: t("startStudentsTitle"),
      body: t("startStudentsBody"),
      to: "/students",
      action: t("startStudentsAction"),
    },
    release: {
      title: t("startReleaseTitle"),
      body: t("startReleaseBody"),
      to: "/grading",
      action: t("startReleaseAction"),
    },
  };
  const pendingStep = checklist.steps.find((step) => !step.done);
  const nextStep = pendingStep ? stepMeta[pendingStep.id] : undefined;
  return (
    <>
      {/* One decision per screen: the hero names the single next step, the
          numbers become quiet chips, and the list stays below. */}
      <Hero
        kicker={t("heroKicker")}
        title={
          nextStep ? (
            <>
              {t("heroNext")} <span className="signal">{nextStep.title}</span>
            </>
          ) : (
            t("teacherHomeTitle")
          )
        }
        body={nextStep ? nextStep.body : t("heroTeacherBody")}
        actions={
          <>
            {nextStep ? (
              <Button asChild size="lg" className="lift">
                <Link to={nextStep.to}>{nextStep.action}</Link>
              </Button>
            ) : (
              <Button asChild size="lg" className="lift">
                <Link to="/assessments">{t("newAssessment")}</Link>
              </Button>
            )}
            <Button asChild variant="secondary">
              <Link to="/assistant">{t("assistantTitle")}</Link>
            </Button>
          </>
        }
        hint={t("heroTeacherHint")}
      />
      <div className="mb-6 flex flex-wrap gap-2">
        {cards.map((c) => (
          <StatChip key={c.label} label={c.label} value={c.value} />
        ))}
      </div>
      {data && <StartChecklistCard checklist={checklist} stepMeta={stepMeta} />}
      <h2 className="mb-3 mt-8 text-lg font-semibold">{t("assessments")}</h2>
      {data && data.assessments.length === 0 ? (
        <Empty>
          <p>{t("noAssessments")}</p>
          <div className="mt-4">
            <Button asChild>
              <Link to="/assessments">{t("newAssessment")}</Link>
            </Button>
          </div>
        </Empty>
      ) : (
        <div className="divide-y rounded-lg border bg-card">
          {data?.assessments.slice(0, 6).map((a) => (
            <Link
              key={a.id}
              to="/assessments/$id"
              params={{ id: a.id }}
              className="flex items-center justify-between p-4 hover:bg-muted"
            >
              <span className="font-medium">{a.title}</span>
              <span className="flex items-center gap-3 text-sm text-muted-foreground">
                {formatDate(a.created_at, lang)}{" "}
                <Pill t={statusTone[a.status]}>{t(`st_${a.status}` as never)}</Pill>
              </span>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

function TutorHome({ name, tutorId }: { name: string; tutorId: string }) {
  const { t } = useI18n();
  const { data } = useQuery({
    queryKey: ["tutor-summary", tutorId],
    queryFn: async () => {
      // D1 (Phase 2): own lessons + own enrollment counts only.
      const result = await getTutorDashboardD1({});
      return {
        lessons: result.lessons,
        enrollments: result.enrollments,
        summary: {
          lesson_count: result.lessonCount,
          student_count: result.studentCount,
          published_assessment_count: result.publishedAssessmentCount,
        },
      };
    },
  });
  const cards = [
    { label: t("summaryLessons"), value: data?.summary?.lesson_count },
    { label: t("summaryStudents"), value: data?.summary?.student_count },
    { label: t("summaryActive"), value: data?.summary?.published_assessment_count },
  ];
  const tutorChecklist = buildTutorStartChecklist({
    lessonsCount: data?.summary?.lesson_count ?? 0,
    studentsCount: data?.summary?.student_count ?? 0,
    hasPublished: (data?.summary?.published_assessment_count ?? 0) > 0,
  });
  const tutorStepMeta: Partial<Record<StartStepId, StartStepMeta>> = {
    lesson: {
      title: t("startLessonTitle"),
      body: t("startLessonBody"),
      to: "/lessons",
      action: t("createLesson"),
    },
    students: {
      title: t("startStudentsTitle"),
      body: t("startStudentsBody"),
      to: "/students",
      action: t("startStudentsAction"),
    },
    published: {
      title: t("startPublishTitle"),
      body: t("startPublishBody"),
      to: "/assessments",
      action: t("newAssessment"),
    },
  };
  const pendingStep = tutorChecklist.steps.find((step) => !step.done);
  const nextStep = pendingStep ? tutorStepMeta[pendingStep.id] : undefined;
  return (
    <>
      <Hero
        kicker={t("heroKicker")}
        title={
          nextStep ? (
            <>
              {t("heroNext")} <span className="signal">{nextStep.title}</span>
            </>
          ) : (
            t("tutorHomeTitle")
          )
        }
        body={nextStep ? nextStep.body : t("heroTutorBody")}
        actions={
          <>
            {nextStep ? (
              <Button asChild size="lg" className="lift">
                <Link to={nextStep.to}>{nextStep.action}</Link>
              </Button>
            ) : (
              <Button asChild size="lg" className="lift">
                <Link to="/lessons">{t("createLesson")}</Link>
              </Button>
            )}
            <Button asChild variant="secondary">
              <Link to="/assistant">{t("assistantTitle")}</Link>
            </Button>
          </>
        }
        hint={t("heroTutorHint")}
      />
      <div className="mb-6 flex flex-wrap gap-2">
        {cards.map((c) => (
          <StatChip key={c.label} label={c.label} value={c.value} />
        ))}
      </div>
      <h2 className="mb-3 mt-8 text-lg font-semibold">{t("lessons")}</h2>
      {data && data.lessons.length === 0 ? (
        <Empty>{t("noLessons")}</Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {data?.lessons.slice(0, 6).map((l) => (
            <Panel key={l.id}>
              <h3 className="font-semibold">{l.title}</h3>
              {l.description ? (
                <p className="mt-1 text-sm text-muted-foreground">{l.description}</p>
              ) : null}
              <p className="mt-2 text-sm text-muted-foreground">
                {t("joinCodeLabel")}: <span dir="ltr">{l.join_code}</span> · {t("summaryStudents")}:{" "}
                {data?.enrollments.find((e) => e.lesson_id === l.id)?.student_count ?? 0}
              </p>
            </Panel>
          ))}
        </div>
      )}
    </>
  );
}

function AdminHome({ name }: { name: string }) {
  const { t } = useI18n();
  const { data } = useQuery({
    queryKey: ["admin-summary"],
    queryFn: async () => getAdminDashboardD1({}),
  });
  const cards = [
    { label: t("summaryTeachers"), value: data?.teachers },
    { label: t("summaryStudents"), value: data?.students },
  ];
  return (
    <>
      <PageHeader
        title={t("adminHomeTitle")}
        actions={
          <Button asChild>
            <Link to="/admin">{t("admin")}</Link>
          </Button>
        }
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((c) => (
          <Panel key={c.label}>
            <p className="text-sm text-muted-foreground">{c.label}</p>
            <p className="mt-2 font-display text-3xl font-bold text-primary">{c.value ?? "—"}</p>
          </Panel>
        ))}
      </div>
    </>
  );
}

function StudentHome({ name, studentId }: { name: string; studentId: string }) {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const [code, setCode] = useState("");
  const [lessonCode, setLessonCode] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(name);
  const [assignmentPage, setAssignmentPage] = useState(0);
  const [lessonPage, setLessonPage] = useState(0);
  const pageSize = 20;
  const { data, error: studentError } = useQuery({
    queryKey: ["student-home", studentId, assignmentPage, lessonPage],
    queryFn: async () => {
      // D1 (Phase 2): assigned published/closed assessments only
      // (plus the group rule), own submissions, own enrollments,
      // own profile, approved links, pending requests — all scoped
      // by the session user server-side. Drafts are never returned.
      const result = await getStudentHomeD1({ data: { assignmentPage, lessonPage } });
      return {
        assessments: result.assessments,
        hasMoreAssessments: result.hasMoreAssessments,
        submissions: result.submissions,
        lessons: result.lessons,
        hasMoreLessons: result.hasMoreLessons,
        parentContact: result.parentContact,
        teacherLinks: result.teacherLinks,
        myName: result.myName,
        pendingRows: result.pendingRows,
        handwrittenGrades: result.handwrittenGrades,
      };
    },
  });
  async function join(e: FormEvent) {
    e.preventDefault();
    // The teacher judges a request by name, so a nameless profile would arrive
    // as an anonymous row. Ask once, here, instead of letting it happen.
    if (!(data?.myName ?? "").trim()) {
      setDraftName(data?.myName ?? "");
      setEditingName(true);
      return void toast.error(t("nameRequiredHint"));
    }
    try {
      await joinTeacherD1({ data: { code } });
    } catch (err) {
      return void toast.error(translateError(err, lang));
    }
    toast.success(t("joined"));
    setCode("");
    qc.invalidateQueries();
  }
  async function saveName(e: FormEvent) {
    e.preventDefault();
    const trimmed = draftName.trim();
    if (!trimmed) return void toast.error(t("nameRequiredHint"));
    try {
      await updateOwnNameD1({ data: { fullName: trimmed } });
    } catch (err) {
      return void toast.error(translateError(err, lang));
    }
    toast.success(t("nameSaved"));
    setEditingName(false);
    qc.invalidateQueries();
    // Saving the name was the only thing blocking the request: send it now,
    // so the student does not have to type the code twice.
    if (code.trim()) {
      try {
        await joinTeacherD1({ data: { code } });
      } catch (joinError) {
        return void toast.error(translateError(joinError, lang));
      }
      toast.success(t("joined"));
      setCode("");
      qc.invalidateQueries();
    }
  }
  async function enroll(e: FormEvent) {
    e.preventDefault();
    try {
      await enrollLessonD1({ data: { code: lessonCode } });
    } catch (err) {
      return void toast.error(translateError(err, lang));
    }
    toast.success(t("enrolled"));
    setLessonCode("");
    qc.invalidateQueries();
  }
  const activeAssessment = data?.assessments.find(
    (a) => data.submissions.find((sub) => sub.assessment_id === a.id)?.status === "in_progress",
  );
  // A request is a third state: not "no teacher", not "nothing assigned yet".
  const pendingRows = data?.pendingRows ?? [];
  const waiting = waitingOn(pendingRows);
  const waitingNames = pendingTeacherNames(pendingRows);
  const needsName = data ? data.myName.length === 0 : false;
  return (
    <>
      {/* Student home asks one question: what is the next thing to do? */}
      <Hero
        kicker={t("heroKicker")}
        title={waiting > 0 && !activeAssessment ? t("waitingApprovalTitle") : t("studentHomeTitle")}
        body={
          activeAssessment
            ? t("heroStudentActive", { title: activeAssessment.title })
            : waiting > 0
              ? waitingNames.length > 0
                ? t("waitingApprovalBody", { name: waitingNames[0]! })
                : t("waitingApprovalBodyNoName")
              : (data?.teacherLinks ?? 0) === 0
                ? t("noTeacherLinked")
                : t("heroStudentIdle")
        }
        actions={
          activeAssessment ? (
            <Button asChild size="lg" className="lift">
              <Link to="/assessments/take/$id" params={{ id: activeAssessment.id }}>
                {t("continueAttempt")}
              </Link>
            </Button>
          ) : (
            <Button asChild size="lg" className="lift" variant="secondary">
              <a href="#join">{t("joinTeacher")}</a>
            </Button>
          )
        }
        hint={t("heroStudentHint")}
      />
      {/* (1) Teacher work — assessments assigned by teachers. */}
      <h2 className="mb-3 text-lg font-semibold">{t("schoolWork")}</h2>
      {/* A request the teacher cannot put a name to cannot be judged. */}
      {needsName || editingName ? (
        <Panel className="mb-4">
          <form onSubmit={saveName} className="flex flex-wrap items-end gap-3">
            <div className="min-w-0 flex-1">
              <label htmlFor="my-name" className="text-sm font-medium">
                {t("yourName")}
              </label>
              <Input
                id="my-name"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                className="mt-1.5 max-w-sm"
                maxLength={80}
                required
              />
              <p className="mt-1.5 text-xs text-muted-foreground">{t("nameRequiredHint")}</p>
            </div>
            <Button type="submit" variant="secondary">
              {t("saveName")}
            </Button>
          </form>
        </Panel>
      ) : null}

      {waiting > 0 ? (
        <Panel className="mb-4">
          <p className="font-medium">{t("waitingApprovalTitle")}</p>
          <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
            {pendingRows.map((r) => (
              <li key={r.teacher_id} className="flex flex-wrap justify-between gap-2">
                <span>{r.teacher_name || "—"}</span>
                <span>{formatDate(r.requested_at, lang)}</span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <Panel className="mb-8">
        <form id="join" onSubmit={join} className="flex flex-wrap items-end gap-3">
          <div className="flex-1">
            <label htmlFor="code" className="text-sm font-medium">
              {t("joinTeacher")}
            </label>
            <Input
              id="code"
              dir="ltr"
              placeholder={t("enterCode")}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="mt-1.5 max-w-xs uppercase"
              maxLength={12}
              required
            />
          </div>
          <Button type="submit" variant="secondary">
            {t("join")}
          </Button>
        </form>
      </Panel>
      <h3 className="mb-3 text-base font-semibold">{t("myAssessments")}</h3>
      {/* A failed read must never look like "nothing was assigned to me". */}
      {studentError ? (
        <p role="alert" className="mb-4 rounded-md bg-destructive/15 p-3 text-sm">
          {t("assessmentsLoadFailed")}{" "}
          <span className="text-muted-foreground">({translateError(studentError, lang)})</span>
        </p>
      ) : null}
      {data && !studentError && data.assessments.length === 0 ? (
        <Empty>
          <p>{t("noAssigned")}</p>
          <p className="mt-2">
            {data.teacherLinks === 0
              ? t("noTeacherLinked")
              : t("linkedButNothingAssigned", { count: String(data.teacherLinks) })}
          </p>
        </Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {data?.assessments.map((a) => {
            const sub = data.submissions.find((s) => s.assessment_id === a.id);
            // One pure decision, so "no button at all" can never come back:
            // every row ends up in exactly one explicit state.
            const state = studentAssessmentState({
              status: a.status,
              startsAt: a.starts_at,
              dueAt: a.due_at,
              submissionStatus: sub?.status ?? null,
            });
            return (
              <Panel key={a.id}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h3 className="min-w-0 font-semibold">{a.title}</h3>
                  <Pill t={statusTone[state] ?? "neutral"}>
                    {state === "released"
                      ? t("sub_released")
                      : state === "in_progress"
                        ? t("draft")
                        : state === "awaiting_review"
                          ? t("awaitingResult")
                          : state === "ended"
                            ? t("deadlinePassed")
                            : state === "not_open_yet"
                              ? t("notOpenYet")
                              : state === "unavailable"
                                ? t("notAvailableNow")
                                : t("availableNow")}
                  </Pill>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("dueAt")}: {formatDate(a.due_at, lang)}
                </p>
                <div className="mt-4">
                  {state === "released" ? (
                    <Pill t="success">
                      {t("finalScore")}: {sub?.final_score}/{sub?.total_possible}
                    </Pill>
                  ) : state === "in_progress" ? (
                    <Button asChild size="sm">
                      <Link to="/assessments/take/$id" params={{ id: a.id }}>
                        {t("continueAttempt")}
                      </Link>
                    </Button>
                  ) : state === "available" ? (
                    <Button asChild size="sm">
                      <Link to="/assessments/take/$id" params={{ id: a.id }}>
                        {t("startAssessment")}
                      </Link>
                    </Button>
                  ) : null}
                </div>
              </Panel>
            );
          })}
        </div>
      )}
      {data && (assignmentPage > 0 || data.hasMoreAssessments) ? (
        <DataPager
          page={assignmentPage}
          hasPrevious={assignmentPage > 0}
          hasNext={data.hasMoreAssessments}
          onPrevious={() => setAssignmentPage((current) => Math.max(0, current - 1))}
          onNext={() => setAssignmentPage((current) => current + 1)}
        />
      ) : null}
      {/* Handwritten grades linked to this student — final on save, so
          they appear here immediately, with no release step. Unlinked
          papers never appear here. */}
      {(data?.handwrittenGrades ?? []).length > 0 ? (
        <>
          <h2 className="mb-3 mt-10 text-lg font-semibold">{t("hwStudentResults")}</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {data!.handwrittenGrades.map((g) => (
              <Panel key={g.id}>
                <h3 className="min-w-0 font-semibold">{g.assessment_title || t("hwAdHoc")}</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {g.teacher_name || "—"} · {formatDate(g.created_at, lang)}
                </p>
                <div className="mt-4">
                  <Pill t="success">
                    {t("finalScore")}: {g.final_score}/{g.max_marks}
                  </Pill>
                </div>
                {/* AI feedback is teacher-only: students see score + teacher feedback. */}
                {g.teacher_feedback ? <p className="mt-2 text-sm">{g.teacher_feedback}</p> : null}
              </Panel>
            ))}
          </div>
        </>
      ) : null}
      {/* Contact details are needed once, then never again: keep them out of
          the way instead of occupying the top of the screen. */}
      <details className="mb-8 rounded-lg border bg-card p-4">
        <summary className="cursor-pointer text-sm font-medium">
          {t("parentPhone")} · {t("optional")}
        </summary>
        <div className="mt-4">
          <ParentContactForm
            studentId={studentId}
            initialPhone={data?.parentContact?.parent_phone ?? null}
            initialConsent={!!data?.parentContact?.whatsapp_consent}
            onSaved={() => qc.invalidateQueries({ queryKey: ["student-home"] })}
          />
        </div>
      </details>
      {/* (2) My lessons — lessons this student enrolled in (tutor track). */}
      <h2 className="mb-3 mt-10 text-lg font-semibold">{t("myLessons")}</h2>
      <Panel className="mb-8">
        <form onSubmit={enroll} className="flex flex-wrap items-end gap-3">
          <div className="flex-1">
            <label htmlFor="lesson-code" className="text-sm font-medium">
              {t("enrollLesson")}
            </label>
            <Input
              id="lesson-code"
              dir="ltr"
              placeholder={t("enterCode")}
              value={lessonCode}
              onChange={(e) => setLessonCode(e.target.value)}
              className="mt-1.5 max-w-xs uppercase"
              maxLength={12}
              required
            />
          </div>
          <Button type="submit" variant="secondary">
            {t("join")}
          </Button>
        </form>
      </Panel>
      {data && data.lessons.length === 0 && lessonPage === 0 ? (
        <Empty>{t("noLessons")}</Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {data?.lessons.map((l) => (
            <Panel key={l.id}>
              <h3 className="font-semibold">{l.title}</h3>
              {l.description ? (
                <p className="mt-1 text-sm text-muted-foreground">{l.description}</p>
              ) : null}
              <p className="mt-2 text-sm text-muted-foreground">
                {t("joinCodeLabel")}: <span dir="ltr">{l.join_code}</span>
              </p>
            </Panel>
          ))}
        </div>
      )}
      {data && (lessonPage > 0 || data.hasMoreLessons) ? (
        <DataPager
          page={lessonPage}
          hasPrevious={lessonPage > 0}
          hasNext={data.hasMoreLessons}
          onPrevious={() => setLessonPage((current) => Math.max(0, current - 1))}
          onNext={() => setLessonPage((current) => current + 1)}
        />
      ) : null}
    </>
  );
}

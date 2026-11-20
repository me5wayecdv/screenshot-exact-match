import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  getAdminDashboardD1,
  getTeacherDashboardD1,
  getTutorDashboardD1,
} from "@/server/d1-assessments";
import { useMe } from "@/lib/session";
import { useI18n, formatDate } from "@/lib/i18n";
import {
  buildStartChecklist,
  buildTutorStartChecklist,
  type StartStepId,
} from "@/lib/start-checklist";
import { PageHeader, Panel, Pill, Empty, Hero, StatCard, statusTone } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";

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
  // Students live in their groups now: no standalone exams page.
  return <Navigate to="/groups" replace />;
}

type StartStepMeta = {
  title: string;
  body: string;
  to: "/groups" | "/students" | "/grading" | "/lessons";
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
    <Panel className="mb-6">
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
            <li key={step.id} className="flex flex-wrap items-center gap-4">
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
      to: "/groups",
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
  return (
    <>
      {/* One decision per screen: the hero welcomes, the checklist owns the
          next steps, and the numbers sit in between as big cards. */}
      <Hero
        title={t("teacherHomeTitle")}
        body={t("heroTeacherBody")}
        actions={
          <>
            {checklist.allDone ? (
              <Button asChild size="lg" className="lift">
                <Link to="/groups">{t("startAssessmentAction")}</Link>
              </Button>
            ) : null}
            <Button asChild variant="secondary">
              <Link to="/assistant">{t("assistantTitle")}</Link>
            </Button>
          </>
        }
        hint={t("heroTeacherHint")}
      />
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {cards.map((c) => (
          <StatCard key={c.label} label={c.label} value={c.value} />
        ))}
      </div>
      {data && <StartChecklistCard checklist={checklist} stepMeta={stepMeta} />}
      <h2 className="mb-4 mt-6 text-lg font-semibold">{t("assessments")}</h2>
      {!data ? (
        <Empty>
          <p>{t("loading")}</p>
        </Empty>
      ) : data.assessments.length === 0 ? (
        <Empty>
          <p>{t("noAssessments")}</p>
          <div className="mt-4">
            <Button asChild>
              <Link to="/groups">{t("startAssessmentAction")}</Link>
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
      to: "/groups",
      action: t("newAssessment"),
    },
  };
  return (
    <>
      <Hero
        title={t("tutorHomeTitle")}
        body={t("heroTutorBody")}
        actions={
          <>
            {tutorChecklist.allDone ? (
              <Button asChild size="lg" className="lift">
                <Link to="/lessons">{t("createLesson")}</Link>
              </Button>
            ) : null}
            <Button asChild variant="secondary">
              <Link to="/assistant">{t("assistantTitle")}</Link>
            </Button>
          </>
        }
        hint={t("heroTutorHint")}
      />
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-3">
        {cards.map((c) => (
          <StatCard key={c.label} label={c.label} value={c.value} />
        ))}
      </div>
      {data && <StartChecklistCard checklist={tutorChecklist} stepMeta={tutorStepMeta} />}
      <h2 className="mb-4 mt-6 text-lg font-semibold">{t("lessons")}</h2>
      {!data ? (
        <Empty>
          <p>{t("loading")}</p>
        </Empty>
      ) : data.lessons.length === 0 ? (
        <Empty>
          <p>{t("noLessons")}</p>
          <div className="mt-4">
            <Button asChild>
              <Link to="/lessons">{t("createLesson")}</Link>
            </Button>
          </div>
        </Empty>
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
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        {cards.map((c) => (
          <StatCard key={c.label} label={c.label} value={c.value} />
        ))}
      </div>
    </>
  );
}

import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useMe } from "@/lib/session";
import { useI18n, formatDate, translateError } from "@/lib/i18n";
import { PageHeader, Panel, Pill, Empty, statusTone } from "@/components/ui-kit";
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

function SchoolTeacherHome({ name, teacherId }: { name: string; teacherId: string }) {
  const { t, lang } = useI18n();
  const { data } = useQuery({
    queryKey: ["teacher-summary", teacherId],
    queryFn: async () => {
      const [recent, summary] = await Promise.all([
        supabase
          .from("assessments")
          .select("id, title, status, created_at")
          .eq("teacher_id", teacherId)
          .order("created_at", { ascending: false })
          .range(0, 5),
        supabase.rpc("teacher_dashboard_summary"),
      ]);
      if (recent.error) throw recent.error;
      if (summary.error) throw summary.error;
      const counts = summary.data?.[0];
      return {
        assessments: recent.data ?? [],
        activeCount: counts?.active_assessment_count ?? 0,
        pendingCount: counts?.pending_submission_count ?? 0,
        releasedCount: counts?.released_submission_count ?? 0,
        studentCount: counts?.student_count ?? 0,
      };
    },
  });
  const cards = [
    { label: t("summaryActive"), value: data?.activeCount },
    { label: t("summaryPending"), value: data?.pendingCount },
    { label: t("summaryStudents"), value: data?.studentCount },
    { label: t("summaryReleased"), value: data?.releasedCount },
  ];

  return (
    <>
      <PageHeader
        title={`${t("welcome")}، ${name}`}
        actions={
          <>
            <Button asChild variant="outline">
              <Link to="/assistant">{t("assistantTitle")}</Link>
            </Button>
            <Button asChild>
              <Link to="/assessments">{t("newAssessment")}</Link>
            </Button>
          </>
        }
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => (
          <Panel key={c.label}>
            <p className="text-sm text-muted-foreground">{c.label}</p>
            <p className="mt-2 font-display text-3xl font-bold text-primary">{c.value ?? "—"}</p>
          </Panel>
        ))}
      </div>
      <h2 className="mb-3 mt-10 text-lg font-semibold">{t("assessments")}</h2>
      {data && data.assessments.length === 0 ? (
        <Empty>{t("noAssessments")}</Empty>
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
      const [lessonResult, summaryResult] = await Promise.all([
        supabase
          .from("lessons")
          .select("id, title, description, join_code, created_at")
          .order("created_at", { ascending: false })
          .range(0, 6),
        supabase.rpc("tutor_dashboard_summary"),
      ]);
      if (lessonResult.error) throw lessonResult.error;
      if (summaryResult.error) throw summaryResult.error;
      const lessonRows = lessonResult.data ?? [];
      const lessons = lessonRows.slice(0, 6);
      const { data: enrollments, error } = lessons.length
        ? await supabase.rpc("tutor_lesson_enrollment_counts", {
            _lesson_ids: lessons.map((lesson) => lesson.id),
          })
        : { data: [], error: null };
      if (error) throw error;
      return {
        lessons,
        enrollments: enrollments ?? [],
        summary: summaryResult.data?.[0] ?? null,
      };
    },
  });
  const cards = [
    { label: t("summaryLessons"), value: data?.summary?.lesson_count },
    { label: t("summaryStudents"), value: data?.summary?.student_count },
    { label: t("summaryActive"), value: data?.summary?.published_assessment_count },
  ];
  return (
    <>
      <PageHeader
        title={`${t("welcome")}، ${name}`}
        actions={
          <>
            <Button asChild variant="outline">
              <Link to="/assistant">{t("assistantTitle")}</Link>
            </Button>
            <Button asChild>
              <Link to="/lessons">{t("createLesson")}</Link>
            </Button>
          </>
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
      <h2 className="mb-3 mt-10 text-lg font-semibold">{t("lessons")}</h2>
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
    queryFn: async () => {
      const [tc, st] = await Promise.all([
        supabase
          .from("user_roles")
          .select("id", { count: "exact", head: true })
          .in("role", ["school_teacher", "tutor"]),
        supabase
          .from("user_roles")
          .select("id", { count: "exact", head: true })
          .eq("role", "student"),
      ]);
      return { teachers: tc.count ?? 0, students: st.count ?? 0 };
    },
  });
  const cards = [
    { label: t("summaryTeachers"), value: data?.teachers },
    { label: t("summaryStudents"), value: data?.students },
  ];
  return (
    <>
      <PageHeader
        title={`${t("welcome")}، ${name}`}
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
  const [assignmentPage, setAssignmentPage] = useState(0);
  const [lessonPage, setLessonPage] = useState(0);
  const pageSize = 20;
  const { data } = useQuery({
    queryKey: ["student-home", studentId, assignmentPage, lessonPage],
    queryFn: async () => {
      const [a, le, pc] = await Promise.all([
        supabase
          .from("assessments")
          .select("id, title, instructions, due_at, status")
          .order("created_at", { ascending: false })
          .range(assignmentPage * pageSize, assignmentPage * pageSize + pageSize),
        supabase
          .from("lesson_enrollments")
          .select("lesson_id, lessons(id, title, description, join_code)")
          .order("enrolled_at", { ascending: false })
          .range(lessonPage * pageSize, lessonPage * pageSize + pageSize),
        supabase
          .from("profiles")
          .select("parent_phone, whatsapp_consent")
          .eq("id", studentId)
          .maybeSingle(),
      ]);
      if (a.error) throw a.error;
      if (le.error) throw le.error;
      const assessmentRows = a.data ?? [];
      const lessonRows = le.data ?? [];
      const assessmentPageRows = assessmentRows.slice(0, pageSize);
      const assessmentIds = assessmentPageRows.map((assessment) => assessment.id);
      const { data: submissionRows, error: submissionsError } = assessmentIds.length
        ? await supabase
            .from("submissions")
            .select("id, assessment_id, status, final_score, total_possible")
            .in("assessment_id", assessmentIds)
        : { data: [], error: null };
      if (submissionsError) throw submissionsError;
      const lessons = lessonRows
        .slice(0, pageSize)
        .map((r) => {
          const nested = r.lessons as unknown;
          return Array.isArray(nested) ? nested[0] : nested;
        })
        .filter(Boolean) as {
        id: string;
        title: string;
        description: string;
        join_code: string | null;
      }[];
      return {
        assessments: assessmentPageRows,
        hasMoreAssessments: assessmentRows.length > pageSize,
        submissions: submissionRows ?? [],
        lessons,
        hasMoreLessons: lessonRows.length > pageSize,
        parentContact: pc.data ?? null,
      };
    },
  });
  async function join(e: FormEvent) {
    e.preventDefault();
    const { error } = await supabase.rpc("join_teacher", { _code: code });
    if (error) return void toast.error(translateError(error, lang));
    toast.success(t("joined"));
    setCode("");
    qc.invalidateQueries();
  }
  async function enroll(e: FormEvent) {
    e.preventDefault();
    const { error } = await supabase.rpc("enroll_lesson", { _code: lessonCode });
    if (error) return void toast.error(translateError(error, lang));
    toast.success(t("enrolled"));
    setLessonCode("");
    qc.invalidateQueries();
  }
  return (
    <>
      <PageHeader title={`${t("welcome")}، ${name}`} />
      <Panel className="mb-8">
        <h2 className="mb-3 font-semibold">{t("parentPhone")}</h2>
        <ParentContactForm
          studentId={studentId}
          initialPhone={data?.parentContact?.parent_phone ?? null}
          initialConsent={data?.parentContact?.whatsapp_consent ?? false}
          onSaved={() => qc.invalidateQueries({ queryKey: ["student-home"] })}
        />
      </Panel>
      {/* (1) Teacher work — assessments assigned by teachers. */}
      <h2 className="mb-3 text-lg font-semibold">{t("schoolWork")}</h2>
      <Panel className="mb-8">
        <form onSubmit={join} className="flex flex-wrap items-end gap-3">
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
      {data && data.assessments.length === 0 ? (
        <Empty>{t("noAssigned")}</Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {data?.assessments.map((a) => {
            const sub = data.submissions.find((s) => s.assessment_id === a.id);
            const late = a.due_at && new Date(a.due_at) < new Date();
            const canStart = !sub && a.status === "published" && !late;
            return (
              <Panel key={a.id}>
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-semibold">{a.title}</h3>
                  {sub && (
                    <Pill t={statusTone[sub.status] ?? "neutral"}>
                      {sub.status === "released"
                        ? t("sub_released")
                        : sub.status === "in_progress"
                          ? t("draft")
                          : t("awaitingResult")}
                    </Pill>
                  )}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("dueAt")}: {formatDate(a.due_at, lang)}
                </p>
                <div className="mt-4">
                  {sub ? (
                    sub.status === "released" ? (
                      <Pill t="success">
                        {t("finalScore")}: {sub.final_score}/{sub.total_possible}
                      </Pill>
                    ) : sub.status === "in_progress" ? (
                      <Button asChild size="sm">
                        <Link to="/assessments/take/$id" params={{ id: a.id }}>
                          {t("continueAttempt")}
                        </Link>
                      </Button>
                    ) : null
                  ) : !canStart ? (
                    <Pill t="danger">{t("deadlinePassed")}</Pill>
                  ) : (
                    <Button asChild size="sm">
                      <Link to="/assessments/take/$id" params={{ id: a.id }}>
                        {t("startAssessment")}
                      </Link>
                    </Button>
                  )}
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

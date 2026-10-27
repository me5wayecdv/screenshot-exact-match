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

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [
      { title: "Dashboard · Qemmini" },
      { name: "description", content: "Your Qemmini dashboard." },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  const { data: me, isLoading } = useMe();
  const { t } = useI18n();
  if (isLoading || !me) return <p className="text-muted-foreground">{t("loading")}</p>;
  if (me.role === "school_teacher") return <SchoolTeacherHome name={me.fullName} />;
  if (me.role === "tutor") return <TutorHome name={me.fullName} />;
  if (me.role === "admin") return <AdminHome name={me.fullName} />;
  return <StudentHome name={me.fullName} studentId={me.id} />;
}

function SchoolTeacherHome({ name }: { name: string }) {
  const { t, lang } = useI18n();
  const { data } = useQuery({
    queryKey: ["teacher-summary"],
    queryFn: async () => {
      const [a, s, st, sc] = await Promise.all([
        supabase
          .from("assessments")
          .select("id, title, status, created_at")
          .order("created_at", { ascending: false }),
        supabase.from("submissions").select("id, status, submitted_at, assessment_id"),
        supabase.rpc("my_students"),
        // RLS on schools returns only schools this teacher belongs to (member / creator).
        supabase
          .from("schools")
          .select("id, name, join_code, created_at")
          .order("created_at", { ascending: false }),
      ]);
      return {
        assessments: a.data ?? [],
        submissions: s.data ?? [],
        students: st.data ?? [],
        schools: sc.data ?? [],
      };
    },
  });
  const cards = [
    {
      label: t("summaryActive"),
      value: data?.assessments.filter((x) => x.status === "published").length,
    },
    {
      label: t("summaryPending"),
      value: data?.submissions.filter(
        (x) => x.status === "awaiting_review" || x.status === "approved",
      ).length,
    },
    { label: t("summaryStudents"), value: data?.students.length },
    {
      label: t("summaryReleased"),
      value: data?.submissions.filter((x) => x.status === "released").length,
    },
  ];
  return (
    <>
      <PageHeader
        title={`${t("welcome")}، ${name}`}
        actions={
          <Button asChild>
            <Link to="/assessments">{t("newAssessment")}</Link>
          </Button>
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
      <h2 className="mb-3 mt-10 text-lg font-semibold">{t("schools")}</h2>
      {data && data.schools.length === 0 ? (
        <Empty>{t("noSchools")}</Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {data?.schools.map((s) => (
            <Panel key={s.id}>
              <h3 className="font-semibold">{s.name}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("joinCodeLabel")}: <span dir="ltr">{s.join_code}</span>
              </p>
              <div className="mt-4">
                <Button asChild variant="secondary" size="sm">
                  <Link to="/school">{t("school")}</Link>
                </Button>
              </div>
            </Panel>
          ))}
        </div>
      )}
    </>
  );
}

function TutorHome({ name }: { name: string }) {
  const { t } = useI18n();
  const { data } = useQuery({
    queryKey: ["tutor-summary"],
    queryFn: async () => {
      const [l, e, a] = await Promise.all([
        supabase
          .from("lessons")
          .select("id, title, description, join_code, created_at")
          .order("created_at", { ascending: false }),
        // RLS on lesson_enrollments returns only enrollments in this tutor's lessons.
        supabase.from("lesson_enrollments").select("lesson_id, student_id"),
        supabase.from("assessments").select("id, status"),
      ]);
      return { lessons: l.data ?? [], enrollments: e.data ?? [], assessments: a.data ?? [] };
    },
  });
  const studentCount = new Set((data?.enrollments ?? []).map((e) => e.student_id)).size;
  const cards = [
    { label: t("summaryLessons"), value: data?.lessons.length },
    { label: t("summaryStudents"), value: studentCount },
    {
      label: t("summaryActive"),
      value: data?.assessments.filter((x) => x.status === "published").length,
    },
  ];
  return (
    <>
      <PageHeader
        title={`${t("welcome")}، ${name}`}
        actions={
          <Button asChild>
            <Link to="/lessons">{t("createLesson")}</Link>
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
                {(data?.enrollments ?? []).filter((e) => e.lesson_id === l.id).length}
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
      const [sc, tc, st] = await Promise.all([
        supabase.from("schools").select("id", { count: "exact", head: true }),
        supabase
          .from("user_roles")
          .select("id", { count: "exact", head: true })
          .in("role", ["school_teacher", "tutor"]),
        supabase
          .from("user_roles")
          .select("id", { count: "exact", head: true })
          .eq("role", "student"),
      ]);
      return { schools: sc.count ?? 0, teachers: tc.count ?? 0, students: st.count ?? 0 };
    },
  });
  const cards = [
    { label: t("summarySchools"), value: data?.schools },
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
  const { data } = useQuery({
    queryKey: ["student-home"],
    queryFn: async () => {
      const [a, s, le, pc] = await Promise.all([
        supabase
          .from("assessments")
          .select("id, title, instructions, due_at, status")
          .order("created_at", { ascending: false }),
        supabase
          .from("submissions")
          .select("id, assessment_id, status, final_score, total_possible"),
        supabase
          .from("lesson_enrollments")
          .select("lesson_id, lessons(id, title, description, join_code)"),
        supabase
          .from("profiles")
          .select("parent_phone, whatsapp_consent")
          .eq("id", studentId)
          .maybeSingle(),
      ]);
      const lessons = (le.data ?? [])
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
        assessments: a.data ?? [],
        submissions: s.data ?? [],
        lessons,
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
      {/* (1) School work — assessments assigned by school teachers. */}
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
      {/* (2) My lessons — lessons this student enrolled in (tutor track, separate from school work). */}
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
      {data && data.lessons.length === 0 ? (
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
    </>
  );
}

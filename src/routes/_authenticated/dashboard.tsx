import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useMe } from "@/lib/session";
import { useI18n, formatDate, translateError } from "@/lib/i18n";
import { PageHeader, Panel, Pill, Empty, statusTone } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard · Qemmini" }, { name: "description", content: "Your Qemmini dashboard." }] }),
  component: Dashboard,
});

function Dashboard() {
  const { data: me, isLoading } = useMe();
  const { t } = useI18n();
  if (isLoading || !me) return <p className="text-muted-foreground">{t("loading")}</p>;
  return me.role === "teacher" ? <TeacherHome name={me.fullName} /> : <StudentHome name={me.fullName} />;
}

function TeacherHome({ name }: { name: string }) {
  const { t, lang } = useI18n();
  const { data } = useQuery({
    queryKey: ["teacher-summary"],
    queryFn: async () => {
      const [a, s, st] = await Promise.all([
        supabase.from("assessments").select("id, title, status, created_at").order("created_at", { ascending: false }),
        supabase.from("submissions").select("id, status, submitted_at, assessment_id"),
        supabase.rpc("my_students"),
      ]);
      return { assessments: a.data ?? [], submissions: s.data ?? [], students: st.data ?? [] };
    },
  });
  const cards = [
    { label: t("summaryActive"), value: data?.assessments.filter((x) => x.status === "published").length },
    { label: t("summaryPending"), value: data?.submissions.filter((x) => x.status === "awaiting_review" || x.status === "approved").length },
    { label: t("summaryStudents"), value: data?.students.length },
    { label: t("summaryReleased"), value: data?.submissions.filter((x) => x.status === "released").length },
  ];
  return (
    <>
      <PageHeader title={`${t("welcome")}، ${name}`} actions={<Button asChild><Link to="/assessments">{t("newAssessment")}</Link></Button>} />
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
            <Link key={a.id} to="/assessments/$id" params={{ id: a.id }} className="flex items-center justify-between p-4 hover:bg-muted">
              <span className="font-medium">{a.title}</span>
              <span className="flex items-center gap-3 text-sm text-muted-foreground">
                {formatDate(a.created_at, lang)} <Pill t={statusTone[a.status]}>{t(`st_${a.status}` as never)}</Pill>
              </span>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

function StudentHome({ name }: { name: string }) {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const [code, setCode] = useState("");
  const { data } = useQuery({
    queryKey: ["student-home"],
    queryFn: async () => {
      const [a, s] = await Promise.all([
        supabase.from("assessments").select("id, title, instructions, due_at, status").order("created_at", { ascending: false }),
        supabase.from("submissions").select("id, assessment_id, status, final_score, total_possible"),
      ]);
      return { assessments: a.data ?? [], submissions: s.data ?? [] };
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
  return (
    <>
      <PageHeader title={`${t("welcome")}، ${name}`} />
      <Panel className="mb-8">
        <form onSubmit={join} className="flex flex-wrap items-end gap-3">
          <div className="flex-1">
            <label htmlFor="code" className="text-sm font-medium">{t("joinTeacher")}</label>
            <Input id="code" dir="ltr" placeholder={t("enterCode")} value={code} onChange={(e) => setCode(e.target.value)} className="mt-1.5 max-w-xs uppercase" maxLength={12} required />
          </div>
          <Button type="submit" variant="secondary">{t("join")}</Button>
        </form>
      </Panel>
      <h2 className="mb-3 text-lg font-semibold">{t("myAssessments")}</h2>
      {data && data.assessments.length === 0 ? (
        <Empty>{t("noAssigned")}</Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {data?.assessments.map((a) => {
            const sub = data.submissions.find((s) => s.assessment_id === a.id);
            const late = a.due_at && new Date(a.due_at) < new Date();
            return (
              <Panel key={a.id}>
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-semibold">{a.title}</h3>
                  {sub && <Pill t={statusTone[sub.status]}>{sub.status === "released" ? t("sub_released") : t("awaitingResult")}</Pill>}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{t("dueAt")}: {formatDate(a.due_at, lang)}</p>
                <div className="mt-4">
                  {sub ? (
                    sub.status === "released" ? (
                      <Pill t="success">{t("finalScore")}: {sub.final_score}/{sub.total_possible}</Pill>
                    ) : null
                  ) : a.status !== "published" || late ? (
                    <Pill t="danger">{t("deadlinePassed")}</Pill>
                  ) : (
                    <Pill t="info">{t("st_published")}</Pill>
                  )}
                </div>
              </Panel>
            );
          })}
        </div>
      )}
    </>
  );
}

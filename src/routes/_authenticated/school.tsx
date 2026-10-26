import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useMe } from "@/lib/session";
import { useI18n, translateError } from "@/lib/i18n";
import { SchoolWorkspaceContent } from "@/components/school-workspace-content";
import { PageHeader, Panel, Empty } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/_authenticated/school")({
  head: () => ({ meta: [{ title: "School · Qemmini" }] }),
  component: School,
});

function School() {
  const { t, lang } = useI18n();
  const { data: me, isLoading } = useMe();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [classSchoolId, setClassSchoolId] = useState("");
  const [className, setClassName] = useState("");

  const { data } = useQuery({
    queryKey: ["school-workspace"],
    enabled: !!me,
    queryFn: async () => {
      const [sc, st, cl, a] = await Promise.all([
        // RLS returns only schools this user belongs to (teacher / creator / admin).
        supabase.from("schools").select("id, name, join_code, created_at").order("created_at", { ascending: false }),
        supabase.from("school_teachers").select("school_id, teacher_id"),
        supabase.from("classes").select("id, school_id, name"),
        supabase.from("assessments").select("id, teacher_id"),
      ]);
      return { schools: sc.data ?? [], schoolTeachers: st.data ?? [], classes: cl.data ?? [], assessments: a.data ?? [] };
    },
  });

  if (isLoading || !me) return <p className="text-muted-foreground">{t("loading")}</p>;
  if (me.role !== "school_teacher" && me.role !== "admin") return <Panel><Empty>{t("schoolOnly")}</Empty></Panel>;

  async function createSchool(e: FormEvent) {
    e.preventDefault();
    const { data: school, error } = await supabase.from("schools").insert({ name: name.trim(), created_by: me!.id }).select("id").single();
    if (error) return void toast.error(translateError(error, lang));
    // Creator becomes a member of the school they created (RLS insert policy allows the creator).
    if (school) await supabase.from("school_teachers").insert({ school_id: school.id, teacher_id: me!.id });
    toast.success(t("created"));
    setName("");
    qc.invalidateQueries({ queryKey: ["school-workspace"] });
  }

  async function joinSchool(e: FormEvent) {
    e.preventDefault();
    const { error } = await supabase.rpc("join_school", { _code: joinCode });
    if (error) return void toast.error(translateError(error, lang));
    toast.success(t("joined"));
    setJoinCode("");
    qc.invalidateQueries({ queryKey: ["school-workspace"] });
  }

  async function createClass(e: FormEvent) {
    e.preventDefault();
    const { error } = await supabase.from("classes").insert({ school_id: classSchoolId, teacher_id: me!.id, name: className.trim() });
    if (error) return void toast.error(translateError(error, lang));
    toast.success(t("created"));
    setClassName("");
    qc.invalidateQueries({ queryKey: ["school-workspace"] });
  }

  return (
    <>
      <PageHeader title={t("school")} />
      <div className="grid gap-4 md:grid-cols-2">
        <Panel>
          <form onSubmit={createSchool} className="flex flex-wrap items-end gap-3">
            <div className="flex-1">
              <label htmlFor="school-name" className="text-sm font-medium">{t("schoolName")}</label>
              <Input id="school-name" value={name} onChange={(e) => setName(e.target.value)} className="mt-1.5" required />
            </div>
            <Button type="submit">{t("createSchool")}</Button>
          </form>
        </Panel>
        <Panel>
          <form onSubmit={joinSchool} className="flex flex-wrap items-end gap-3">
            <div className="flex-1">
              <label htmlFor="school-code" className="text-sm font-medium">{t("joinSchool")}</label>
              <Input id="school-code" dir="ltr" placeholder={t("enterCode")} value={joinCode} onChange={(e) => setJoinCode(e.target.value)} className="mt-1.5 uppercase" maxLength={12} required />
            </div>
            <Button type="submit" variant="secondary">{t("join")}</Button>
          </form>
        </Panel>
      </div>
      <h2 className="mb-3 mt-10 text-lg font-semibold">{t("schools")}</h2>
      {data && data.schools.length === 0 ? (
        <Empty>{t("noSchools")}</Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {data?.schools.map((s) => {
            const teacherIds = new Set((data?.schoolTeachers ?? []).filter((x) => x.school_id === s.id).map((x) => x.teacher_id));
            return (
              <Panel key={s.id}>
                <h3 className="font-semibold">{s.name}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{t("joinCodeLabel")}: <span dir="ltr">{s.join_code}</span></p>
                <p className="mt-2 text-sm text-muted-foreground">
                  {t("teachers")}: {teacherIds.size} · {t("classes")}: {(data?.classes ?? []).filter((c) => c.school_id === s.id).length} · {t("assessments")}: {(data?.assessments ?? []).filter((a) => teacherIds.has(a.teacher_id)).length}
                </p>
              </Panel>
            );
          })}
        </div>
      )}
      <h2 className="mb-3 mt-10 text-lg font-semibold">{t("createClass")}</h2>
      <Panel>
        <form onSubmit={createClass} className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="class-school" className="text-sm font-medium">{t("school")}</label>
            <select id="class-school" value={classSchoolId} onChange={(e) => setClassSchoolId(e.target.value)} className="mt-1.5 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" required>
              <option value="">{t("school")}</option>
              {data?.schools.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}
            </select>
          </div>
          <div className="flex-1">
            <label htmlFor="class-name" className="text-sm font-medium">{t("className")}</label>
            <Input id="class-name" value={className} onChange={(e) => setClassName(e.target.value)} className="mt-1.5" required />
          </div>
          <Button type="submit">{t("createClass")}</Button>
        </form>
      </Panel>
      {/* School-wide overview (teachers, classes, assessments). Rendered
          for school teachers only; admins use the school list above. */}
      {me.role === "school_teacher" && <SchoolWorkspaceContent />}
    </>
  );
}

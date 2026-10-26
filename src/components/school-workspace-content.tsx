import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useI18n } from "@/lib/i18n";
import { useMe } from "@/lib/session";
import { PageHeader, Panel, Pill, Empty, statusTone } from "@/components/ui-kit";

/**
 * School workspace overview, rendered at the bottom of /school for
 * school teachers. Schema verified against the segmentation migration:
 * schools (id, name), school_teachers (school_id, teacher_id) — the
 * current user's first school is used — classes (id, school_id, name).
 *
 * RLS NOTE: teachers/classes lists are genuinely school-wide (school
 * member read policies exist), but the assessments overview only shows
 * assessments the viewer can read — i.e. their own — because the
 * assessments/submissions/answers policies are still owner-only.
 * School-wide assessment visibility needs new member-read policies and
 * is a follow-up, not silently enabled here.
 */
export function SchoolWorkspaceContent() {
  const { t } = useI18n();
  const { data: me } = useMe();

  const schoolQuery = useQuery({
    queryKey: ["school-workspace-school", me?.id],
    enabled: !!me,
    queryFn: async () => {
      const { data: link, error: linkError } = await supabase
        .from("school_teachers")
        .select("school_id")
        .eq("teacher_id", me!.id)
        .maybeSingle();
      if (linkError) throw linkError;
      if (!link) return null;
      const { data: school, error: schoolError } = await supabase
        .from("schools")
        .select("id, name")
        .eq("id", link.school_id)
        .maybeSingle();
      if (schoolError) throw schoolError;
      return school;
    },
  });

  const schoolId = schoolQuery.data?.id ?? null;

  const teachersQuery = useQuery({
    queryKey: ["school-workspace-teachers", schoolId],
    enabled: !!schoolId,
    queryFn: async () => {
      const { data: links, error: linksError } = await supabase
        .from("school_teachers")
        .select("teacher_id")
        .eq("school_id", schoolId!);
      if (linksError) throw linksError;
      const ids = (links ?? []).map((l) => l.teacher_id);
      if (ids.length === 0) return { ids, profiles: [] as { id: string; full_name: string }[] };
      const { data: profiles, error: profilesError } = await supabase
        .from("profiles")
        .select("id, full_name")
        .in("id", ids)
        .order("full_name", { ascending: true });
      if (profilesError) throw profilesError;
      return { ids, profiles: profiles ?? [] };
    },
  });

  const classesQuery = useQuery({
    queryKey: ["school-workspace-classes", schoolId],
    enabled: !!schoolId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("classes")
        .select("id, name")
        .eq("school_id", schoolId!)
        .order("name", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });

  const teacherIds = teachersQuery.data?.ids ?? [];
  const assessmentsQuery = useQuery({
    queryKey: ["school-workspace-assessments", schoolId, teacherIds.join(",")],
    enabled: !!schoolId && teacherIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("assessments")
        .select("id, title, status, teacher_id")
        .in("teacher_id", teacherIds);
      if (error) throw error;
      return data ?? [];
    },
  });

  if (schoolQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">{t("loading")}</p>;
  }
  if (schoolQuery.isError) {
    return <Empty>{t("errorGeneric")}</Empty>;
  }
  if (!schoolQuery.data) {
    return <Empty>{t("schoolNoSchool")}</Empty>;
  }

  const school = schoolQuery.data;
  const teachers = teachersQuery.data?.profiles ?? [];
  const classes = classesQuery.data ?? [];
  const assessments = assessmentsQuery.data ?? [];
  const countStatus = (status: string) => assessments.filter((a) => a.status === status).length;

  return (
    <div className="mt-8">
      <PageHeader title={school.name} subtitle={t("schoolWorkspace")} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Panel>
          <p className="text-sm text-muted-foreground">{t("schoolTeachers")}</p>
          <p className="mt-1 text-3xl font-bold">{teachers.length}</p>
        </Panel>
        <Panel>
          <p className="text-sm text-muted-foreground">{t("schoolClasses")}</p>
          <p className="mt-1 text-3xl font-bold">{classes.length}</p>
        </Panel>
        <Panel>
          <p className="text-sm text-muted-foreground">{t("schoolTotalAssessments")}</p>
          <p className="mt-1 text-3xl font-bold">{assessments.length}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("st_published")}: {countStatus("published")} · {t("st_draft")}: {countStatus("draft")}
          </p>
        </Panel>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Panel>
          <h2 className="mb-3 text-lg font-bold">{t("schoolTeachers")}</h2>
          {teachersQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">{t("loading")}</p>
          ) : teachers.length === 0 ? (
            <Empty>{t("schoolNoTeachers")}</Empty>
          ) : (
            <ul className="divide-y text-sm">
              {teachers.map((teacher) => (
                <li key={teacher.id} className="py-2">{teacher.full_name || "—"}</li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel>
          <h2 className="mb-3 text-lg font-bold">{t("schoolClasses")}</h2>
          {classesQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">{t("loading")}</p>
          ) : classes.length === 0 ? (
            <Empty>{t("schoolNoClasses")}</Empty>
          ) : (
            <ul className="divide-y text-sm">
              {classes.map((c) => (
                <li key={c.id} className="py-2">{c.name}</li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel className="mt-6">
        <h2 className="mb-3 text-lg font-bold">{t("schoolAssessmentsOverview")}</h2>
        {assessmentsQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        ) : assessments.length === 0 ? (
          <Empty>{t("noAssessments")}</Empty>
        ) : (
          <ul className="divide-y text-sm">
            {assessments.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 py-2">
                <span>{a.title}</span>
                <Pill t={statusTone[a.status] ?? "neutral"}>{t(`st_${a.status}` as never)}</Pill>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

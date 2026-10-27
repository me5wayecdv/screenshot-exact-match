import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useMe } from "@/lib/session";
import { useI18n } from "@/lib/i18n";
import { PageHeader, Panel, Empty } from "@/components/ui-kit";

export const Route = createFileRoute("/_authenticated/admin")({
  head: () => ({ meta: [{ title: "Admin · Qemmini" }] }),
  component: Admin,
});

function Admin() {
  const { t } = useI18n();
  const { data: me, isLoading } = useMe();
  const { data } = useQuery({
    queryKey: ["admin-page"],
    enabled: me?.role === "admin",
    queryFn: async () => {
      const [sc, tc, st] = await Promise.all([
        supabase
          .from("schools")
          .select("id, name, join_code, created_at")
          .order("created_at", { ascending: false }),
        supabase
          .from("user_roles")
          .select("id", { count: "exact", head: true })
          .in("role", ["school_teacher", "tutor"]),
        supabase
          .from("user_roles")
          .select("id", { count: "exact", head: true })
          .eq("role", "student"),
      ]);
      return { schools: sc.data ?? [], teachers: tc.count ?? 0, students: st.count ?? 0 };
    },
  });
  if (isLoading || !me) return <p className="text-muted-foreground">{t("loading")}</p>;
  if (me.role !== "admin")
    return (
      <Panel>
        <Empty>{t("adminOnly")}</Empty>
      </Panel>
    );
  return (
    <>
      <PageHeader title={t("admin")} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[
          { label: t("summarySchools"), value: data?.schools.length },
          { label: t("summaryTeachers"), value: data?.teachers },
          { label: t("summaryStudents"), value: data?.students },
        ].map((c) => (
          <Panel key={c.label}>
            <p className="text-sm text-muted-foreground">{c.label}</p>
            <p className="mt-2 font-display text-3xl font-bold text-primary">{c.value ?? "—"}</p>
          </Panel>
        ))}
      </div>
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
            </Panel>
          ))}
        </div>
      )}
    </>
  );
}

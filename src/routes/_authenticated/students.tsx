import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useMe } from "@/lib/session";
import { useI18n, formatDate, translateError } from "@/lib/i18n";
import { PageHeader, Panel, Empty } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/students")({
  head: () => ({ meta: [{ title: "Students · Qemmini" }, { name: "description", content: "Manage your students." }] }),
  component: Students,
});

function Students() {
  const { t, lang } = useI18n();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["my-students"], queryFn: async () => (await supabase.rpc("my_students")).data ?? [] });
  async function remove(id: string) {
    const { error } = await supabase.from("teacher_students").delete().eq("teacher_id", me!.id).eq("student_id", id);
    if (error) return void toast.error(translateError(error, lang));
    qc.invalidateQueries({ queryKey: ["my-students"] });
  }
  return (
    <>
      <PageHeader title={t("students")} />
      <Panel className="mb-8">
        <p className="text-sm text-muted-foreground">{t("joinCode")}</p>
        <p dir="ltr" className="mt-1 font-display text-4xl font-bold tracking-[0.3em] text-primary">{me?.joinCode ?? "—"}</p>
        <p className="mt-2 text-sm text-muted-foreground">{t("joinCodeHint")}</p>
      </Panel>
      {data && data.length === 0 ? (
        <Empty>{t("noStudents")}</Empty>
      ) : (
        <div className="divide-y rounded-lg border bg-card">
          {data?.map((s) => (
            <div key={s.student_id} className="flex items-center justify-between p-4">
              <span className="font-medium">{s.full_name || "—"}</span>
              <span className="flex items-center gap-3 text-sm text-muted-foreground">
                {formatDate(s.joined_at, lang)}
                <Button size="sm" variant="ghost" onClick={() => remove(s.student_id)}>{t("remove")}</Button>
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

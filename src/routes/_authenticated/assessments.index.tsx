import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useI18n, formatDate, translateError } from "@/lib/i18n";
import { PageHeader, Panel, Pill, Empty, statusTone } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/_authenticated/assessments/")({
  head: () => ({
    meta: [
      { title: "Assessments · Qemmini" },
      { name: "description", content: "Create and manage assessments." },
    ],
  }),
  component: AssessmentsList,
});

type AssessmentRow = {
  id: string;
  title: string;
  status: string;
  due_at: string | null;
  created_at: string;
  subjects: { name: string } | null;
};

function AssessmentsList() {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  // The query used to swallow its error (`(await ...).data ?? []`), so any
  // failure — an RLS denial, a broken embedded subject join, a missing
  // column — rendered as "no assessments yet". Surface it instead.
  const { data, isLoading, error } = useQuery({
    queryKey: ["assessments"],
    queryFn: async (): Promise<AssessmentRow[]> => {
      const base = "id, title, status, due_at, created_at";
      const first = await supabase
        .from("assessments")
        .select(`${base}, subjects(name)`)
        .order("created_at", { ascending: false });
      if (!first.error) return (first.data ?? []) as AssessmentRow[];
      // The embedded subject join is cosmetic. If PostgREST cannot resolve
      // it (an FK it does not know about), the list used to collapse to
      // "no assessments yet" and look like vanished data; retry plain.
      const plain = await supabase
        .from("assessments")
        .select(base)
        .order("created_at", { ascending: false });
      if (plain.error) throw plain.error;
      return (plain.data ?? []).map((r) => ({ ...r, subjects: null })) as AssessmentRow[];
    },
  });
  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { data: row, error } = await supabase
      .from("assessments")
      .insert({ title: title.trim() })
      .select("id")
      .single();
    setBusy(false);
    if (error) return void toast.error(translateError(error, lang));
    navigate({ to: "/assessments/$id", params: { id: row.id } });
  }
  return (
    <>
      <PageHeader
        title={t("assessments")}
        actions={
          <Link to="/assessments/generate">
            <Button variant="outline">{t("genTitle")}</Button>
          </Link>
        }
      />
      <Panel className="mb-8">
        <form onSubmit={create} className="flex flex-wrap items-end gap-3">
          <div className="min-w-60 flex-1 space-y-1.5">
            <Label htmlFor="title">{t("newAssessment")}</Label>
            <Input
              id="title"
              required
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("title")}
            />
          </div>
          <Button disabled={busy || !title.trim()}>{t("create")}</Button>
        </form>
      </Panel>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t("loading")}</p>
      ) : error ? (
        <p role="alert" className="rounded-md bg-destructive/15 p-3 text-sm">
          {t("assessmentsLoadFailed")}{" "}
          <span className="text-muted-foreground">({translateError(error, lang)})</span>
        </p>
      ) : data && data.length === 0 ? (
        <Empty>{t("noAssessments")}</Empty>
      ) : (
        <div className="divide-y rounded-lg border bg-card">
          {data?.map((a) => (
            <div
              key={a.id}
              className="flex flex-wrap items-center justify-between gap-2 p-4 hover:bg-muted"
            >
              <Link to="/assessments/$id" params={{ id: a.id }} className="flex-1">
                <span className="font-medium">{a.title}</span>
                {a.subjects?.name && (
                  <span className="ms-2 text-sm text-muted-foreground">· {a.subjects.name}</span>
                )}
              </Link>
              <span className="flex items-center gap-3 text-sm text-muted-foreground">
                {t("dueAt")}: {formatDate(a.due_at, lang)}
                <Pill t={statusTone[a.status]}>{t(`st_${a.status}` as never)}</Pill>
                <Link
                  to="/assessments/report/$id"
                  params={{ id: a.id }}
                  className="font-medium text-primary hover:underline"
                >
                  {t("report")}
                </Link>
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

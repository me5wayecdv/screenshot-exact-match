import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useI18n, formatDate, translateError } from "@/lib/i18n";
import { PageHeader, Panel, Pill, Empty, statusTone } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { DataPager } from "@/components/data-pager";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/_authenticated/assessments/")({
  head: () => ({
    meta: [
      { title: "Assessments · Qayyimni" },
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
  // Main's pagination, plus two things it still lacked: (a) the cosmetic
  // subjects(name) embed is retried without the join instead of taking the
  // whole page down, and (b) a real error renders as an error — an empty
  // list used to be indistinguishable from a failed read.
  const [page, setPage] = useState(0);
  const pageSize = 20;
  const { data, isLoading, error } = useQuery({
    queryKey: ["assessments", page],
    queryFn: async (): Promise<{ rows: AssessmentRow[]; hasNext: boolean }> => {
      const base = "id, title, status, due_at, created_at";
      const run = (select: string) =>
        supabase
          .from("assessments")
          .select(select)
          .order("created_at", { ascending: false })
          .range(page * pageSize, page * pageSize + pageSize);
      const first = await run(`${base}, subjects(name)`);
      if (!first.error) {
        const rows = (first.data ?? []) as unknown as AssessmentRow[];
        return { rows: rows.slice(0, pageSize), hasNext: rows.length > pageSize };
      }
      const plain = await run(base);
      if (plain.error) throw plain.error;
      const plainRows = (plain.data ?? []) as unknown as Omit<AssessmentRow, "subjects">[];
      const rows: AssessmentRow[] = plainRows.map((r) => ({ ...r, subjects: null }));
      return { rows: rows.slice(0, pageSize), hasNext: rows.length > pageSize };
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
      ) : data && data.rows.length === 0 && page === 0 ? (
        <Empty>{t("noAssessments")}</Empty>
      ) : (
        <div className="divide-y rounded-lg border bg-card">
          {data?.rows.map((a) => (
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
      {data && (page > 0 || data.hasNext) ? (
        <DataPager
          page={page}
          hasPrevious={page > 0}
          hasNext={data.hasNext}
          onPrevious={() => setPage((current) => Math.max(0, current - 1))}
          onNext={() => setPage((current) => current + 1)}
        />
      ) : null}
    </>
  );
}

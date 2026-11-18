import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  createAssessmentD1,
  listTeacherAssessmentsD1,
  type AssessmentListRow,
} from "@/server/d1-assessments";
import { useI18n, formatDate, translateError } from "@/lib/i18n";
import { setGenerateHandoff } from "@/lib/generate-handoff";
import { PageHeader, Panel, Pill, EmptyCard, statusTone } from "@/components/ui-kit";
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

type AssessmentRow = AssessmentListRow;

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

function AssessmentsList() {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  // Inline Arabic validation under the field instead of the browser's
  // English "Please fill out this field" bubble (the form uses noValidate).
  const [titleError, setTitleError] = useState<string | null>(null);
  // AI card: the chosen PDF and/or pasted lesson text are handed to the
  // generate page, which stays the single place the AI pipeline runs.
  const [aiFile, setAiFile] = useState<File | null>(null);
  const [aiText, setAiText] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  // Main's pagination, plus two things it still lacked: (a) the cosmetic
  // subjects(name) embed is retried without the join instead of taking the
  // whole page down, and (b) a real error renders as an error — an empty
  // list used to be indistinguishable from a failed read.
  const [page, setPage] = useState(0);
  const pageSize = 20;
  const { data, isLoading, error } = useQuery({
    queryKey: ["assessments", page],
    queryFn: async (): Promise<{ rows: AssessmentRow[]; hasNext: boolean }> => {
      // D1 (Phase 2): the teacher's own assessments only — the server
      // function scopes by the session user, never by a client id.
      const result = await listTeacherAssessmentsD1({ data: { page } });
      return { rows: result.rows, hasNext: result.hasNext };
    },
  });
  async function create(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) {
      setTitleError(t("titleRequired"));
      return;
    }
    setTitleError(null);
    setBusy(true);
    try {
      const row = await createAssessmentD1({ data: { title: title.trim() } });
      navigate({ to: "/assessments/$id", params: { id: row.id } });
    } catch (err) {
      toast.error(translateError(err, lang));
    } finally {
      setBusy(false);
    }
  }
  async function startAi(e: FormEvent) {
    e.preventDefault();
    const text = aiText.trim();
    if (!aiFile && !text) return;
    setAiBusy(true);
    try {
      if (aiFile) {
        const dataUrl = await readAsDataUrl(aiFile);
        setGenerateHandoff({ file: { name: aiFile.name, dataUrl }, ...(text ? { text } : {}) });
      } else {
        setGenerateHandoff({ text });
      }
      navigate({ to: "/assessments/generate" });
    } catch (err) {
      toast.error(translateError(err, lang));
    } finally {
      setAiBusy(false);
    }
  }
  const aiReady = !!aiFile || !!aiText.trim();
  return (
    <>
      <PageHeader title={t("assessments")} />
      <section aria-label={t("assessments")} className="mb-8 grid gap-4 md:grid-cols-2">
        <Panel>
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-base font-semibold">{t("aiCardTitle")}</h2>
            <Pill t="primary">AI</Pill>
          </div>
          <p className="mb-4 text-sm text-muted-foreground">{t("aiCardBody")}</p>
          <form onSubmit={startAi} noValidate className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="ai-file">{t("aiCardFileLabel")}</Label>
              <input
                id="ai-file"
                type="file"
                accept="application/pdf,.pdf"
                onChange={(e) => setAiFile(e.target.files?.[0] ?? null)}
                className="sr-only"
              />
              <label
                htmlFor="ai-file"
                className="inline-flex cursor-pointer items-center justify-center rounded-md border bg-background px-3 py-1.5 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t("aiCardChooseFile")}
              </label>
              <p className="text-sm text-muted-foreground" aria-live="polite">
                {aiFile ? aiFile.name : t("aiCardNoFile")}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ai-text">{t("aiCardPasteLabel")}</Label>
              <textarea
                id="ai-text"
                rows={3}
                value={aiText}
                onChange={(e) => setAiText(e.target.value)}
                placeholder={t("genSourcePlaceholder")}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            <Button type="submit" disabled={aiBusy || !aiReady}>
              {aiBusy ? t("loading") : t("genTitle")}
            </Button>
          </form>
        </Panel>
        <Panel>
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-base font-semibold">{t("manualCardTitle")}</h2>
            <Pill>{t("manualCardBadge")}</Pill>
          </div>
          <p className="mb-4 text-sm text-muted-foreground">{t("manualCardBody")}</p>
          <form onSubmit={create} noValidate className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="title">{t("newAssessment")}</Label>
              <Input
                id="title"
                maxLength={200}
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  if (titleError) setTitleError(null);
                }}
                placeholder={t("title")}
                aria-invalid={titleError ? true : undefined}
                aria-describedby={titleError ? "title-error" : undefined}
              />
              {titleError ? (
                <p id="title-error" role="alert" className="text-sm text-destructive">
                  {titleError}
                </p>
              ) : null}
            </div>
            <Button type="submit" disabled={busy}>
              {busy ? t("loading") : t("manualCardAction")}
            </Button>
          </form>
        </Panel>
      </section>
      <section aria-label={t("myAssessments")}>
        <h2 className="mb-3 text-base font-semibold">{t("myAssessments")}</h2>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        ) : error ? (
          <p role="alert" className="rounded-md bg-destructive/15 p-3 text-sm">
            {t("assessmentsLoadFailed")}{" "}
            <span className="text-muted-foreground">({translateError(error, lang)})</span>
          </p>
        ) : data && data.rows.length === 0 && page === 0 ? (
          <EmptyCard title={t("noAssessments")} body={t("noAssessmentsHint")} />
        ) : (
          <div className="divide-y rounded-lg border bg-card">
            {data?.rows.map((a) => (
              <div
                key={a.id}
                className="flex flex-wrap items-center justify-between gap-2 p-4 hover:bg-muted"
              >
                <Link to="/assessments/$id" params={{ id: a.id }} className="flex-1">
                  <span className="font-medium">{a.title}</span>
                  {a.subjectName && (
                    <span className="ms-2 text-sm text-muted-foreground">· {a.subjectName}</span>
                  )}
                </Link>
                <span className="flex items-center gap-3 text-sm text-muted-foreground">
                  {t("dueAt")}: {formatDate(a.due_at, lang)}
                  <Pill t={statusTone[a.status]}>
                    {a.status === "draft"
                      ? lang === "ar"
                        ? "قيد الإعداد"
                        : "In preparation"
                      : t(`st_${a.status}` as never)}
                  </Pill>
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
      </section>
    </>
  );
}

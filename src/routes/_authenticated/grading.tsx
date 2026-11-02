import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { useI18n, translateError, formatDate } from "@/lib/i18n";
import { useMe } from "@/lib/session";
import { PageHeader, Panel, Pill, Empty, statusTone } from "@/components/ui-kit";
import { AiGradeSuggestion } from "@/components/AiGradeSuggestion";
import { IntegritySummary } from "@/components/integrity-summary";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { sendWhatsAppReport } from "@/lib/whatsapp.functions";
import { WhatsAppSendButton } from "@/components/whatsapp-send-button";
import { DataPager } from "@/components/data-pager";

type Q = Database["public"]["Tables"]["questions"]["Row"] & {
  question_keys: Database["public"]["Tables"]["question_keys"]["Row"] | null;
};
type Submission = Database["public"]["Tables"]["submissions"]["Row"];
// Answers live in the EXISTING public.answers table (see the base
// migration). Teacher scores are final_score; auto_score is the
// deterministic objective auto-grade. No AI in this pass.
type AnswerRow = Database["public"]["Tables"]["answers"]["Row"];

export const Route = createFileRoute("/_authenticated/grading")({
  head: () => ({
    meta: [
      { title: "Grading · Qayyimni" },
      { name: "description", content: "Review submissions awaiting grading." },
    ],
  }),
  component: Grading,
});

function normalize(s: string) {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Deterministic objective auto-grade. Mirrors public.score_objective in
 *  the existing migration: exact (trimmed) match for mcq/true_false,
 *  normalised match against the correct answer or any accepted
 *  alternative for short answers, null for written questions. The teacher
 *  always has the final word via final_score. */
function autoFor(q: Q, answerText: string): number | null {
  const key = q.question_keys;
  if (!key) return null;
  const marks = Number(q.marks);
  if (q.type === "mcq" || q.type === "true_false") {
    return (answerText ?? "").trim() === (key.correct_answer ?? "").trim() ? marks : 0;
  }
  if (q.type === "short_answer") {
    const norm = normalize(answerText ?? "");
    if (!norm) return 0;
    if (norm === normalize(key.correct_answer ?? "")) return marks;
    const alts = (key.accepted_alternatives as string[]) ?? [];
    if (alts.some((a) => normalize(a) === norm)) return marks;
    return 0;
  }
  return null;
}

function useGradingList(teacherId: string | undefined, openPage: number, releasedPage: number) {
  const openPageSize = 30;
  const releasedPageSize = 20;
  return useQuery({
    queryKey: ["grading-list", teacherId, openPage, releasedPage],
    enabled: !!teacherId,
    queryFn: async () => {
      const [openResult, releasedResult] = await Promise.all([
        supabase.rpc("teacher_grading_page", {
          _status: "awaiting_review",
          _offset: openPage * openPageSize,
          _limit: openPageSize + 1,
        }),
        supabase.rpc("teacher_grading_page", {
          _status: "released",
          _offset: releasedPage * releasedPageSize,
          _limit: releasedPageSize + 1,
        }),
      ]);
      if (openResult.error) throw openResult.error;
      if (releasedResult.error) throw releasedResult.error;
      const openRows = (openResult.data ?? []) as Submission[];
      const releasedRows = (releasedResult.data ?? []) as Submission[];
      const submissions = openRows.slice(0, openPageSize);
      const released = releasedRows.slice(0, releasedPageSize);
      const visibleRows = [...submissions, ...released];
      const assessmentIds = [...new Set(visibleRows.map((row) => row.assessment_id))];
      const studentIds = [...new Set(visibleRows.map((row) => row.student_id))];
      const [assessmentResult, profileResult] = await Promise.all([
        assessmentIds.length
          ? supabase.from("assessments").select("id, title").in("id", assessmentIds)
          : Promise.resolve({ data: [], error: null }),
        studentIds.length
          ? supabase.from("profiles").select("id, full_name").in("id", studentIds)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (assessmentResult.error) throw assessmentResult.error;
      const titles = new Map(
        (assessmentResult.data ?? []).map((assessment) => [assessment.id, assessment.title]),
      );
      const names = new Map(
        (profileResult.data ?? []).map((profile) => [profile.id, profile.full_name || "—"]),
      );
      return {
        submissions,
        released,
        hasMoreSubmissions: openRows.length > openPageSize,
        hasMoreReleased: releasedRows.length > releasedPageSize,
        titles,
        names,
      };
    },
  });
}

function useGradingDetail(submission: Submission | null) {
  return useQuery({
    queryKey: ["grading-detail", submission?.id],
    enabled: !!submission,
    queryFn: async () => {
      const s = submission!;
      const [qRes, aRes] = await Promise.all([
        supabase
          .from("questions")
          .select("*, question_keys(*)")
          .eq("assessment_id", s.assessment_id)
          .order("position"),
        supabase.from("answers").select("*").eq("submission_id", s.id),
      ]);
      if (qRes.error) throw qRes.error;
      if (aRes.error) throw aRes.error;
      return {
        questions: (qRes.data ?? []) as unknown as Q[],
        answers: (aRes.data ?? []) as unknown as AnswerRow[],
      };
    },
  });
}

function Grading() {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const { data: me, isLoading: meLoading } = useMe();
  const [openPage, setOpenPage] = useState(0);
  const [releasedPage, setReleasedPage] = useState(0);
  const gradingTeacherId =
    me && (me.role === "school_teacher" || me.role === "tutor") ? me.id : undefined;
  const canGrade = gradingTeacherId !== undefined;
  const { data: list, isLoading: listLoading } = useGradingList(
    gradingTeacherId,
    openPage,
    releasedPage,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    list?.submissions.find((s) => s.id === selectedId) ?? list?.submissions[0] ?? null;
  const isReleased = selected?.status === "released";
  const { data: detail, isLoading: detailLoading } = useGradingDetail(selected);
  const [scores, setScores] = useState<Record<string, string>>({});
  const [feedbacks, setFeedbacks] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const autoDone = useRef(new Set<string>());

  // Initialise the edit form from saved teacher scores/feedback whenever a
  // different submission's detail loads.
  useEffect(() => {
    if (!detail || !selected) return;
    const s: Record<string, string> = {};
    const f: Record<string, string> = {};
    for (const a of detail.answers) {
      s[a.id] = a.final_score === null ? "" : String(a.final_score);
      f[a.id] = a.feedback ?? "";
    }
    setScores(s);
    setFeedbacks(f);
  }, [detail, selected?.id]);

  // Auto-grade objective answers on first open of a submission: persist
  // auto_score only where the stored value differs from the computed one,
  // so this effect never loops. Teacher scores are never touched here.
  useEffect(() => {
    if (
      !detail ||
      !selected ||
      selected.status === "released" ||
      autoDone.current.has(selected.id)
    ) {
      return;
    }
    const jobs = detail.answers.flatMap((a) => {
      const q = detail.questions.find((qq) => qq.id === a.question_id);
      if (!q) return [];
      const computed = autoFor(q, a.response ?? "");
      if (computed === null || Number(a.auto_score) === computed) return [];
      return [{ id: a.id, computed }];
    });
    void (async () => {
      if (jobs.length === 0) {
        autoDone.current.add(selected.id);
        return;
      }
      const results = await Promise.all(
        jobs.map((j) => supabase.from("answers").update({ auto_score: j.computed }).eq("id", j.id)),
      );
      const failed = results.find((r) => r.error);
      if (failed) {
        toast.error(translateError(failed.error, lang));
        return;
      }
      autoDone.current.add(selected.id);
      await qc.invalidateQueries({ queryKey: ["grading-detail", selected.id] });
    })();
  }, [detail, selected, qc, lang]);

  if (meLoading || listLoading) return <p className="text-muted-foreground">{t("loading")}</p>;
  // Teachers and tutors may grade only assessments they own; the bounded
  // RPC applies the same owner check independently of this UI gate.
  if (!me || !canGrade) return <Empty>{t("gradingTeacherOnly")}</Empty>;

  const submissions = list?.submissions ?? [];
  const released = list?.released ?? [];
  const answerByQuestion = new Map((detail?.answers ?? []).map((a) => [a.question_id, a]));
  const totalPossible = (detail?.questions ?? []).reduce((s, q) => s + Number(q.marks), 0);

  function scoreOf(answerId: string, marks: number): { value: number | null; error: boolean } {
    const raw = (scores[answerId] ?? "").trim();
    if (raw === "") return { value: null, error: false };
    const n = Number(raw);
    return { value: n, error: Number.isNaN(n) || n < 0 || n > marks };
  }

  /** Save teacher scores + feedback through the audited, owner-scoped RPC. */
  async function saveAll(force = false): Promise<boolean> {
    if (!detail || !selected) return false;
    for (const q of detail.questions) {
      const a = answerByQuestion.get(q.id);
      if (!a) continue;
      if (scoreOf(a.id, Number(q.marks)).error) {
        toast.error(t("gradingScoreRange"));
        return false;
      }
    }
    const writes = detail.questions.flatMap((q) => {
      const a = answerByQuestion.get(q.id);
      if (!a) return [];
      const { value } = scoreOf(a.id, Number(q.marks));
      const fb = feedbacks[a.id] ?? "";
      if (!force && value === a.final_score && fb === (a.feedback ?? "")) return [];
      return [
        supabase.rpc("review_answer", {
          _answer: a.id,
          _score: value,
          _feedback: fb,
          _decision: value === null ? "reject" : "approve",
        }),
      ];
    });
    const results = await Promise.all(writes);
    const failed = results.find((r) => r.error);
    if (failed) {
      toast.error(translateError(failed.error, lang));
      return false;
    }
    return true;
  }

  async function save() {
    setBusy(true);
    const ok = await saveAll();
    setBusy(false);
    if (!ok) return;
    toast.success(t("gradingSaved"));
    await qc.invalidateQueries({ queryKey: ["grading-list", me?.id] });
    await qc.invalidateQueries({ queryKey: ["grading-detail", selected?.id] });
  }

  async function release() {
    if (!me || !detail || !selected || isReleased) return;
    // Teacher-final-word: every question needs an explicit teacher score
    // (auto scores alone never release a submission).
    for (const q of detail.questions) {
      const a = answerByQuestion.get(q.id);
      if (!a || scoreOf(a.id, Number(q.marks)).value === null) {
        toast.error(t("gradingReleaseBlocked"));
        return;
      }
    }
    setBusy(true);
    // Force a review RPC for every answer so legacy drafts with previously
    // saved direct scores are promoted through the current audited state path.
    const ok = await saveAll(true);
    if (!ok) {
      setBusy(false);
      return;
    }
    const { error } = await supabase.rpc("release_submission", {
      _sub: selected.id,
      _feedback: "",
    });
    setBusy(false);
    if (error) return void toast.error(translateError(error, lang));
    toast.success(t("released"));
    // Auto-send is toggle-gated SERVER-side (default OFF). A skipped
    // result (toggle off / no number / no consent / already sent) is
    // deliberately silent — release must never nag. Only a real send or
    // a real Meta failure gets a toast, and the failure stays visible
    // in the audit row on the report page. The try/catch guarantees a
    // send problem can never break the release itself.
    try {
      const sendResult = await sendWhatsAppReport({
        data: { submissionId: selected.id, trigger: "auto" },
      });
      if (sendResult.ok && sendResult.status === "sent") toast.success(t("whatsappSent"));
      else if (!sendResult.ok)
        toast.error(
          sendResult.error ? translateError(new Error(sendResult.error), lang) : t("errorGeneric"),
        );
    } catch (e) {
      toast.error(translateError(e, lang));
    }
    setSelectedId(null);
    await qc.invalidateQueries({ queryKey: ["grading-list", me.id] });
    await qc.invalidateQueries({ queryKey: ["grading-detail", selected.id] });
  }

  return (
    <>
      <PageHeader
        title={t("grading")}
        subtitle={t("gradingAutoNote")}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link to="/handwritten">{t("hwPaperGrade")}</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/audit">{t("auditViewHistory")}</Link>
            </Button>
          </div>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <Panel className="h-fit">
          <h2 className="mb-3 font-semibold">{t("submissions")}</h2>
          {submissions.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noSubmissions")}</p>
          ) : (
            <ul className="space-y-1">
              {submissions.map((s) => (
                <li key={s.id}>
                  <button
                    className={`w-full rounded-md px-3 py-2 text-start text-sm hover:bg-muted ${selected?.id === s.id ? "bg-muted font-medium" : ""}`}
                    onClick={() => setSelectedId(s.id)}
                  >
                    <span className="block">{list?.titles.get(s.assessment_id) ?? "—"}</span>
                    <span className="block text-xs text-muted-foreground">
                      {list?.names.get(s.student_id) ?? "—"} · {formatDate(s.submitted_at, lang)}
                    </span>
                    <Pill t={statusTone[s.status] ?? "neutral"}>
                      {t(`sub_${s.status}` as never)}
                    </Pill>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {list && (openPage > 0 || list.hasMoreSubmissions) ? (
            <DataPager
              page={openPage}
              hasPrevious={openPage > 0}
              hasNext={list.hasMoreSubmissions}
              onPrevious={() => {
                setSelectedId(null);
                setOpenPage((current) => Math.max(0, current - 1));
              }}
              onNext={() => {
                setSelectedId(null);
                setOpenPage((current) => current + 1);
              }}
            />
          ) : null}
          {(released.length > 0 || releasedPage > 0) && (
            <div className="mt-6">
              <h3 className="mb-3 font-semibold">{t("released")}</h3>
              <ul className="space-y-3">
                {released.map((s) => (
                  <li key={s.id} className="rounded-md border p-3">
                    <span className="block text-sm font-medium">
                      {list?.titles.get(s.assessment_id) ?? "—"}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {list?.names.get(s.student_id) ?? "—"} · {formatDate(s.submitted_at, lang)}
                    </span>
                    <div className="mt-2">
                      <WhatsAppSendButton submissionId={s.id} studentId={s.student_id} />
                    </div>
                  </li>
                ))}
              </ul>
              {list && (releasedPage > 0 || list.hasMoreReleased) ? (
                <DataPager
                  page={releasedPage}
                  hasPrevious={releasedPage > 0}
                  hasNext={list.hasMoreReleased}
                  onPrevious={() => setReleasedPage((current) => Math.max(0, current - 1))}
                  onNext={() => setReleasedPage((current) => current + 1)}
                />
              ) : null}
            </div>
          )}
        </Panel>

        <div>
          {!selected ? (
            <Empty>{t("gradingSelectSubmission")}</Empty>
          ) : detailLoading || !detail ? (
            <p className="text-muted-foreground">{t("loading")}</p>
          ) : (
            <div className="space-y-6">
              <Panel>
                <h2 className="font-semibold">{list?.titles.get(selected.assessment_id) ?? "—"}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("student_")}: {list?.names.get(selected.student_id) ?? "—"} ·{" "}
                  {t("submittedAt")}: {formatDate(selected.submitted_at, lang)} · {t("totalMarks")}:{" "}
                  {totalPossible}
                </p>
              </Panel>
              <IntegritySummary submissionId={selected.id} assessmentId={selected.assessment_id} />
              {detail.questions.map((q, i) => {
                const a = answerByQuestion.get(q.id);
                const key = q.question_keys;
                const auto = a ? autoFor(q, a.response ?? "") : null;
                return (
                  <Panel key={q.id} className="space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-primary">
                        {t("question")} {i + 1} · {t(`q_${q.type}` as never)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {t("marks")}: {Number(q.marks)}
                      </span>
                    </div>
                    <p className="whitespace-pre-wrap text-sm">{q.prompt}</p>
                    <div className="rounded-md bg-muted p-3 text-sm">
                      <span className="text-muted-foreground">{t("answer")}: </span>
                      <span className="whitespace-pre-wrap">{a?.response || t("unanswered")}</span>
                    </div>
                    {key && (
                      <div className="space-y-1 text-sm">
                        {q.type !== "written" ? (
                          <>
                            <p>
                              <span className="text-muted-foreground">{t("expected")}: </span>
                              {key.correct_answer || "—"}
                            </p>
                            {((key.accepted_alternatives as string[]) ?? []).length > 0 && (
                              <p>
                                <span className="text-muted-foreground">{t("alternatives")}: </span>
                                {((key.accepted_alternatives as string[]) ?? []).join("، ")}
                              </p>
                            )}
                          </>
                        ) : (
                          <p className="whitespace-pre-wrap">
                            <span className="text-muted-foreground">{t("rubric")}: </span>
                            {key.rubric || "—"}
                          </p>
                        )}
                        {key.explanation && (
                          <p>
                            <span className="text-muted-foreground">{t("explanation")}: </span>
                            {key.explanation}
                          </p>
                        )}
                      </div>
                    )}
                    {!a ? (
                      <p className="text-sm text-muted-foreground">{t("noSubmissions")}</p>
                    ) : (
                      <div className="grid gap-4 md:grid-cols-3">
                        <div className="space-y-1.5">
                          <Label>{t("autoScore")}</Label>
                          <p className="h-9 px-3 py-2 text-sm">{auto === null ? "—" : auto}</p>
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor={`ts-${a.id}`}>{t("teacherScore")}</Label>
                          <Input
                            id={`ts-${a.id}`}
                            type="number"
                            min={0}
                            max={Number(q.marks)}
                            step={0.5}
                            dir="ltr"
                            value={scores[a.id] ?? ""}
                            disabled={isReleased}
                            onChange={(e) => setScores({ ...scores, [a.id]: e.target.value })}
                          />
                        </div>
                        <div className="space-y-1.5 md:col-span-3">
                          <Label htmlFor={`fb-${a.id}`}>{t("feedback")}</Label>
                          <Textarea
                            id={`fb-${a.id}`}
                            rows={2}
                            value={feedbacks[a.id] ?? ""}
                            disabled={isReleased}
                            maxLength={2000}
                            onChange={(e) => setFeedbacks({ ...feedbacks, [a.id]: e.target.value })}
                          />
                        </div>
                      </div>
                    )}
                    {a && q.type === "written" && !isReleased && (
                      <AiGradeSuggestion
                        key={a.id}
                        answerId={a.id}
                        questionPrompt={q.prompt}
                        rubric={key?.rubric ?? ""}
                        acceptedAlternatives={(key?.accepted_alternatives as string[]) ?? []}
                        studentAnswer={a.response ?? ""}
                        maxMarks={Number(q.marks)}
                        assessmentId={selected.assessment_id}
                        onAccept={(v) => {
                          setScores((p) => ({ ...p, [a.id]: String(v.score) }));
                          setFeedbacks((p) => ({ ...p, [a.id]: v.feedback }));
                        }}
                      />
                    )}
                  </Panel>
                );
              })}
              <div className="flex flex-wrap gap-2">
                <Button onClick={save} disabled={busy || isReleased}>
                  {busy ? t("saving") : t("gradingSaveScores")}
                </Button>
                <Button variant="outline" onClick={release} disabled={busy || isReleased}>
                  {t("release")}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

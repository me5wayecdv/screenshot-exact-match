import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  autoScoreFor,
  getGradingDetailD1,
  listGradingPageD1,
  quickSettleSubmissionD1,
  releaseSubmissionD1,
  reviewAnswerD1,
  setAutoScoresD1,
  type GradingAnswer,
  type GradingQuestion,
  type GradingSubmission,
} from "@/server/d1-grading";
import { useI18n, translateError, formatDate } from "@/lib/i18n";
import { useMe } from "@/lib/session";
import { PageHeader, Panel, Pill, Empty, statusTone } from "@/components/ui-kit";
import { AiGradeSuggestion } from "@/components/AiGradeSuggestion";
import { IntegritySummary } from "@/components/integrity-summary";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { getReviewMapsD1, listReviewRequestsD1, type ReviewRow } from "@/server/d1-reviews";
import { sendWhatsAppReportD1 } from "@/server/d1-report";
import { WhatsAppSendButton } from "@/components/whatsapp-send-button";
import { DataPager } from "@/components/data-pager";

type Q = GradingQuestion & { question_keys: GradingQuestion["key"] };
type Submission = GradingSubmission;
// Answers live in the D1 answers table. Teacher scores are
// final_score; auto_score is the deterministic objective auto-grade.
// No AI in this pass.
type AnswerRow = GradingAnswer;

export const Route = createFileRoute("/_authenticated/grading")({
  head: () => ({
    meta: [
      { title: "Grading · Qayyimni" },
      { name: "description", content: "Review submissions awaiting grading." },
    ],
  }),
  component: Grading,
});

/** Deterministic objective auto-grade (server rule in
 *  d1-grading.ts, mirroring the old score_objective): exact trimmed
 *  match for mcq/true_false, normalised match against the correct
 *  answer or an accepted alternative for short answers, null for
 *  written questions. The teacher always has the final word via
 *  final_score. */
function autoFor(q: Q, answerText: string): number | null {
  return autoScoreFor({ type: q.type, marks: Number(q.marks) }, q.question_keys, answerText);
}

function useGradingList(teacherId: string | undefined, openPage: number, releasedPage: number) {
  const openPageSize = 30;
  const releasedPageSize = 20;
  return useQuery({
    queryKey: ["grading-list", teacherId, openPage, releasedPage],
    enabled: !!teacherId,
    queryFn: async () => {
      // D1 (Phase 2): the server joins submissions to the teacher's
      // OWN assessments only (assessments.teacher_id = session user)
      // and returns titles/names already joined — a non-owner teacher
      // sees nothing, not even another teacher's student names.
      const [openResult, releasedResult] = await Promise.all([
        listGradingPageD1({
          data: {
            status: "awaiting_review",
            offset: openPage * openPageSize,
            limit: openPageSize,
          },
        }),
        listGradingPageD1({
          data: {
            status: "released",
            offset: releasedPage * releasedPageSize,
            limit: releasedPageSize,
          },
        }),
      ]);
      const submissions = openResult.submissions;
      const released = releasedResult.submissions;
      const visibleRows = [...submissions, ...released];
      return {
        submissions,
        released,
        hasMoreSubmissions: openResult.hasMore,
        hasMoreReleased: releasedResult.hasMore,
        titles: new Map(visibleRows.map((row) => [row.assessment_id, row.assessmentTitle])),
        names: new Map(visibleRows.map((row) => [row.student_id, row.studentName])),
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
      // D1 (Phase 2): ownership is checked server-side against the
      // submission's assessment; keys come back only for the owning
      // teacher, never for a student path.
      const detail = await getGradingDetailD1({ data: { submissionId: s.id } });
      return {
        questions: detail.questions.map((q) => ({ ...q, question_keys: q.key })),
        answers: detail.answers,
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
  // FROZEN GATE: school_teacher only — tutors are barred from
  // /grading (the old page's client gate also admitted tutors, but
  // the D1 server enforces school_teacher; the UI now matches it).
  const gradingTeacherId = me && me.role === "school_teacher" ? me.id : undefined;
  const canGrade = gradingTeacherId !== undefined;
  const { data: list, isLoading: listLoading } = useGradingList(
    gradingTeacherId,
    openPage,
    releasedPage,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Review requests attach to RELEASED submissions, so selection also
  // looks in the released page. Released submissions are re-gradable
  // (grade-review flow): the teacher edits scores and re-publishes,
  // and the student's result updates in place.
  const selected =
    list?.submissions.find((s) => s.id === selectedId) ??
    list?.released.find((s) => s.id === selectedId) ??
    list?.submissions[0] ??
    null;
  const isReleased = selected?.status === "released";
  const { data: detail, isLoading: detailLoading } = useGradingDetail(selected);
  // Grade-review requests (Phase 7 feature, surfaced inside التصحيح):
  // open requests filed by students on their released submissions.
  const reviewRequestsQuery = useQuery({
    queryKey: ["grading-review-requests", gradingTeacherId],
    enabled: !!gradingTeacherId,
    // D1: teacher_id = caller, enforced server-side.
    queryFn: async () => (await listReviewRequestsD1({ data: {} })) as ReviewRow[],
  });
  const openReviews = (reviewRequestsQuery.data ?? []).filter((r) => r.status === "open");
  const reviewSubmissionIds = [...new Set(openReviews.map((r) => r.submission_id))];
  const reviewStudentIds = [...new Set(openReviews.map((r) => r.student_id))];
  const reviewQuestionIds = [
    ...new Set(openReviews.map((r) => r.question_id).filter(Boolean)),
  ] as string[];
  const reviewMapsQuery = useQuery({
    queryKey: [
      "grading-review-maps",
      reviewSubmissionIds.join(","),
      reviewStudentIds.join(","),
      reviewQuestionIds.join(","),
    ],
    enabled: openReviews.length > 0,
    // D1: maps built only from submissions visible to the caller.
    queryFn: async () =>
      getReviewMapsD1({
        data: {
          submissionIds: reviewSubmissionIds,
          studentIds: reviewStudentIds,
          questionIds: reviewQuestionIds,
        },
      }),
  });
  const reviewMaps = reviewMapsQuery.data;
  const reviewRequestSubmissions = new Set(openReviews.map((r) => r.submission_id));
  const [scores, setScores] = useState<Record<string, string>>({});
  const [feedbacks, setFeedbacks] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  // Sidebar layout: submissions and review requests live in separate
  // tabs, never mixed in one list.
  const [sideTab, setSideTab] = useState<"submissions" | "reviews">("submissions");
  const [settleBusyId, setSettleBusyId] = useState<string | null>(null);
  const autoDone = useRef(new Set<string>());

  // Initialise the edit form from saved teacher scores/feedback whenever a
  // different submission's detail loads.
  const selectedSubmissionId = selected?.id;
  useEffect(() => {
    if (!detail || !selectedSubmissionId) return;
    const s: Record<string, string> = {};
    const f: Record<string, string> = {};
    for (const a of detail.answers) {
      s[a.id] = a.final_score === null ? "" : String(a.final_score);
      f[a.id] = a.feedback ?? "";
    }
    setScores(s);
    setFeedbacks(f);
  }, [detail, selectedSubmissionId]);

  // Auto-grade objective answers on first open of a submission: persist
  // auto_score where the stored value differs, and let the server promote
  // the auto-grade to final_score wherever the teacher has not scored yet
  // (auto_score synced but final_score missing still sends, so the
  // promotion cannot be skipped). A set teacher score is never resent,
  // so this effect never loops and never overwrites the teacher.
  useEffect(() => {
    if (
      !detail ||
      !selected ||
      selected.status === "released" ||
      // Partially released submissions were auto-graded at submit
      // time already; the server skips promotion for them too.
      selected.status === "partially_released" ||
      autoDone.current.has(selected.id)
    ) {
      return;
    }
    const jobs = detail.answers.flatMap((a) => {
      const q = detail.questions.find((qq) => qq.id === a.question_id);
      if (!q) return [];
      const computed = autoFor(q, a.response ?? "");
      if (computed === null) return [];
      if (Number(a.auto_score) === computed && a.final_score !== null) return [];
      return [{ id: a.id, computed }];
    });
    void (async () => {
      if (jobs.length === 0) {
        autoDone.current.add(selected.id);
        return;
      }
      try {
        await setAutoScoresD1({
          data: {
            submissionId: selected.id,
            scores: jobs.map((j) => ({ answerId: j.id, score: j.computed })),
          },
        });
      } catch (err) {
        toast.error(translateError(err, lang));
        return;
      }
      autoDone.current.add(selected.id);
      await qc.invalidateQueries({ queryKey: ["grading-detail", selected.id] });
    })();
  }, [detail, selected, qc, lang]);

  if (meLoading || listLoading) return <p className="text-muted-foreground">{t("loading")}</p>;
  // A school teacher may grade only assessments they own; the
  // server applies the same owner check independently of this UI gate.
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
        () =>
          reviewAnswerD1({
            data: {
              answerId: a.id,
              score: value,
              feedback: fb,
              decision: value === null ? "reject" : "approve",
            },
          }),
      ];
    });
    try {
      // Keep published totals deterministic when several answers change.
      for (const write of writes) await write();
    } catch (err) {
      toast.error(translateError(err, lang));
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

  /** One-click settle straight from the submissions list: auto-grade
   *  what the deterministic rule can grade, then publish through the
   *  normal audited release path. The server refuses (without writing
   *  anything) when a question still needs the teacher's eye. */
  async function quickSettle(submissionId: string) {
    if (!me) return;
    setSettleBusyId(submissionId);
    try {
      await quickSettleSubmissionD1({ data: { submissionId } });
    } catch (err) {
      setSettleBusyId(null);
      return void toast.error(translateError(err, lang));
    }
    setSettleBusyId(null);
    toast.success(t("gradingQuickSettleDone"));
    // Always skipped while sending is OFF — deliberately silent, same
    // as the manual release path.
    try {
      await sendWhatsAppReportD1({ data: { submissionId, trigger: "auto" } });
    } catch (e) {
      toast.error(translateError(e, lang));
    }
    if (selectedId === submissionId) setSelectedId(null);
    await qc.invalidateQueries({ queryKey: ["grading-list", me.id] });
  }

  /** Quick-action label for an unsettled row, or null when the
   *  submission still needs manual grading and must be opened. */
  function quickActionLabel(s: Submission): string | null {
    if (s.unscoredCount === 0) return t("gradingQuickRelease");
    if (s.objectiveOnly) return t("gradingQuickGradeRelease");
    return null;
  }

  async function release() {
    if (!me || !detail || !selected) return;
    // Re-release of a published submission (grade-review correction):
    // the server recomputes canonical totals and updates the same row,
    // so the student's result is replaced, never duplicated.
    const wasReleased = isReleased;
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
    // D1 (Phase 2): the server enforces the release gate — every
    // question needs a teacher score — and computes canonical totals.
    // The handwritten exception (AI grade final on save) lives in the
    // handwritten workstream, not here, so this gate is not weakened.
    try {
      await releaseSubmissionD1({ data: { submissionId: selected.id, feedback: "" } });
    } catch (err) {
      setBusy(false);
      return void toast.error(translateError(err, lang));
    }
    setBusy(false);
    toast.success(wasReleased ? t("gradingRepublished") : t("released"));
    // Auto-send is toggle-gated SERVER-side (default OFF). A skipped
    // result (toggle off / no number / no consent / already sent) is
    // deliberately silent — release must never nag. The try/catch
    // guarantees a send problem can never break the release itself.
    // D1 (Phase 2b): WhatsApp sending stays OFF in the pilot, so
    // this always answers skipped and performs no send — the toggle
    // only stores the flag until sending is deliberately switched on.
    try {
      // Always skipped while sending is OFF — deliberately silent.
      await sendWhatsAppReportD1({
        data: { submissionId: selected.id, trigger: "auto" },
      });
    } catch (e) {
      toast.error(translateError(e, lang));
    }
    // Keep a re-released submission open; a fresh release moves on.
    if (!wasReleased) setSelectedId(null);
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
          <div className="mb-4 grid grid-cols-2 gap-1 rounded-md border p-1" role="tablist">
            <button
              role="tab"
              aria-selected={sideTab === "submissions"}
              className={`rounded px-2 py-1.5 text-sm transition-colors ${
                sideTab === "submissions"
                  ? "bg-muted font-medium"
                  : "text-muted-foreground hover:bg-muted/50"
              }`}
              onClick={() => setSideTab("submissions")}
            >
              {t("submissions")}
            </button>
            <button
              role="tab"
              aria-selected={sideTab === "reviews"}
              className={`rounded px-2 py-1.5 text-sm transition-colors ${
                sideTab === "reviews"
                  ? "bg-muted font-medium"
                  : "text-muted-foreground hover:bg-muted/50"
              }`}
              onClick={() => setSideTab("reviews")}
            >
              <span className="inline-flex items-center gap-1.5">
                {t("reviewsTeacherRequests")}
                {openReviews.length > 0 && <Pill t="primary">{openReviews.length}</Pill>}
              </span>
            </button>
          </div>
          {sideTab === "reviews" ? (
            openReviews.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("gradingReviewsEmpty")}</p>
            ) : (
              <ul className="space-y-3">
                {openReviews.map((r) => {
                  const assessmentTitle = reviewMaps
                    ? (reviewMaps.assessmentTitles[
                        reviewMaps.submissionToAssessment[r.submission_id] ?? ""
                      ] ?? "—")
                    : "—";
                  const questionPrompt = r.question_id
                    ? (reviewMaps?.questionPrompts[r.question_id] ?? null)
                    : null;
                  const openable =
                    submissions.some((s) => s.id === r.submission_id) ||
                    released.some((s) => s.id === r.submission_id);
                  return (
                    <li key={r.id} className="space-y-2 rounded-md border border-primary/40 p-3">
                      <span className="block text-sm font-medium">{assessmentTitle}</span>
                      <span className="block text-xs text-muted-foreground">
                        {reviewMaps?.names[r.student_id] ?? "—"} · {formatDate(r.created_at, lang)}
                      </span>
                      {questionPrompt && (
                        <span className="block text-xs text-muted-foreground">
                          {t("reviewsQuestion")}: {(questionPrompt || "").slice(0, 80)}
                        </span>
                      )}
                      <p className="whitespace-pre-wrap text-sm">{r.message}</p>
                      <div className="flex flex-wrap gap-2">
                        {openable && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setSelectedId(r.submission_id)}
                          >
                            {t("gradingReviewOpenSubmission")}
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" asChild>
                          <Link to="/reviews">{t("gradingReviewReply")}</Link>
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )
          ) : (
            <>
              {submissions.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("noSubmissions")}</p>
              ) : (
                <ul className="space-y-1">
                  {submissions.map((s) => {
                    const actionLabel = quickActionLabel(s);
                    return (
                      <li key={s.id}>
                        <button
                          className={`w-full rounded-md px-3 py-2 text-start text-sm hover:bg-muted ${selected?.id === s.id ? "bg-muted font-medium" : ""}`}
                          onClick={() => setSelectedId(s.id)}
                        >
                          <span className="block">{list?.titles.get(s.assessment_id) ?? "—"}</span>
                          <span className="block text-xs text-muted-foreground">
                            {list?.names.get(s.student_id) ?? "—"} ·{" "}
                            {formatDate(s.submitted_at, lang)}
                          </span>
                          <Pill t={statusTone[s.status] ?? "neutral"}>
                            {t(`sub_${s.status}` as never)}
                          </Pill>
                        </button>
                        {actionLabel && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="mt-1 w-full"
                            disabled={settleBusyId === s.id}
                            onClick={() => void quickSettle(s.id)}
                          >
                            {settleBusyId === s.id ? t("saving") : actionLabel}
                          </Button>
                        )}
                      </li>
                    );
                  })}
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
                          {list?.names.get(s.student_id) ?? "—"} ·{" "}
                          {formatDate(s.submitted_at, lang)}
                        </span>
                        {reviewRequestSubmissions.has(s.id) && (
                          <div className="mt-1">
                            <Pill t="primary">{t("gradingReviewBadge")}</Pill>
                          </div>
                        )}
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
            </>
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
              {selected.status !== "released" && (
                <Panel className="border-info/40 bg-info/10 text-sm">
                  <p>{t("gradingPartialNote")}</p>
                </Panel>
              )}
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
                            onChange={(e) => setScores({ ...scores, [a.id]: e.target.value })}
                          />
                        </div>
                        <div className="space-y-1.5 md:col-span-3">
                          <Label htmlFor={`fb-${a.id}`}>{t("feedback")}</Label>
                          <Textarea
                            id={`fb-${a.id}`}
                            rows={2}
                            value={feedbacks[a.id] ?? ""}
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
                        // AI-F4 display fix: a suggestion generated earlier
                        // (persisted in answers.ai_suggestion) renders on
                        // mount, so it survives a reload. Advisory only.
                        {...(a.aiSuggestion ? { initialSuggestion: a.aiSuggestion } : {})}
                        questionId={q.id}
                        submissionId={selected.id}
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
                <Button onClick={save} disabled={busy}>
                  {busy ? t("saving") : t("gradingSaveScores")}
                </Button>
                <Button variant="outline" onClick={release} disabled={busy}>
                  {isReleased ? t("gradingRepublish") : t("release")}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

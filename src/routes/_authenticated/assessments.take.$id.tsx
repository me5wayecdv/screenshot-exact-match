import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  getTakeDataD1,
  getTakeStatusD1,
  recordIntegrityEventD1,
  saveDraftD1,
  startAttemptD1,
  submitAttemptD1,
  type TakeAnswer,
  type TakeQuestion,
  type TakeStatus,
  type TakeSubmission,
} from "@/server/d1-take";
import { useI18n, translateError, formatDate } from "@/lib/i18n";
import { useIntegrityRecorder } from "@/hooks/useIntegrityRecorder";
import {
  loadQuestionOrder,
  saveQuestionOrder,
  resolveQuestionOrder,
  resolveOrderIds,
  shuffleIds,
} from "@/lib/shuffle";
import {
  canStartAttempt,
  effectiveDeadlineMs,
  formatCountdown,
  remainingSeconds,
  windowState,
} from "@/lib/exam-attempt";
import { useMe } from "@/lib/session";
import { PageHeader, Panel, Pill, Empty, statusTone } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type Q = TakeQuestion;
type Submission = TakeSubmission;
// Answers are the student's OWN response rows only, without scores or
// feedback (see d1-take.ts): the take payload never selects keys or
// grading fields for a student.
type AnswerRow = TakeAnswer;

export const Route = createFileRoute("/_authenticated/assessments/take/$id")({
  head: () => ({
    meta: [
      { title: "Take assessment · Qayyimni" },
      { name: "description", content: "Answer a published assessment assigned to you." },
    ],
  }),
  component: Take,
});

function useTakeData(id: string, studentId: string | undefined) {
  return useQuery({
    queryKey: ["take", id, studentId],
    enabled: !!studentId,
    queryFn: async () => {
      // D1 (Phase 2) + GATE FIRST: the server calls canTakeAssessment
      // before loading any question or answer. A failed gate returns
      // { allowed: false } with NO questions, answers, or submissions
      // — except the §6 draft/history exceptions documented in
      // d1-take.ts (an existing draft resumes, a submitted attempt's
      // history stays visible, even after the window closes).
      const result = await getTakeDataD1({ data: { assessmentId: id } });
      if (!result.allowed) {
        return {
          allowed: false as const,
          reason: result.reason,
          assessment: null,
          questions: [] as Q[],
          submissions: [] as Submission[],
          answersBySubmission: {} as Record<string, AnswerRow[]>,
        };
      }
      return {
        allowed: true as const,
        reason: null,
        assessment: result.assessment,
        questions: result.questions,
        submissions: result.submissions,
        answersBySubmission: result.answersBySubmission,
      };
    },
  });
}

function Take() {
  const { id } = Route.useParams();
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const { data: me, isLoading: meLoading } = useMe();
  const { data, isLoading, isFetching, error } = useTakeData(id, me?.id);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "queued" | "saved">("idle");
  // Phase 3: submit goes through the queue — "submitting" is the
  // enqueue, "processing" is the consumer working, "done" is the
  // submitted row visible. queueStuck is the honest timeout notice:
  // the message is durable in the queue, the student just hasn't seen
  // the applied state yet.
  const [submitState, setSubmitState] = useState<"idle" | "submitting" | "processing">("idle");
  const [queueStuck, setQueueStuck] = useState(false);
  // Monotonic draft counter, seeded from the server's draft_seq (see
  // the draft effect below) so a reload never re-uses a stale low
  // number — the consumer skips seq <= draft_seq as already applied.
  const draftSeqRef = useRef(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const initKey = useRef("");
  const startKey = useRef("");
  const resumeKey = useRef("");
  const autoSubmitKey = useRef("");
  const lastSaved = useRef("");
  // Drafts created in THIS page session (auto-start / new attempt) are
  // fresh, not resumed: the resume effect must skip them, or every new
  // attempt would wrongly record a session_interrupted event.
  const freshDraftIds = useRef(new Set<string>());

  const submissions = data?.submissions ?? [];
  const draft = submissions.find((s) => s.status === "in_progress") ?? null;
  const submitted = submissions.filter((s) => s.status !== "in_progress");
  const latestSubmitted = submitted.length > 0 ? submitted[submitted.length - 1] : null;
  const maxAttempts = Math.max(1, data?.assessment?.max_attempts ?? 1);
  const win = data?.assessment
    ? windowState(Date.now(), data.assessment.starts_at, data.assessment.due_at)
    : "open";

  // Phase 3: poll the queued-write status until `done` holds. Backoff
  // 1s → 5s cap, 90s total cap, then throws TAKE_QUEUE_TIMEOUT — the
  // caller shows the stuck notice (the message is durable in the
  // queue; nothing is re-enqueued).
  async function pollTakeStatus(
    submissionId: string,
    done: (s: TakeStatus) => boolean,
  ): Promise<TakeStatus> {
    const start = Date.now();
    let delay = 1000;
    for (;;) {
      const status = await getTakeStatusD1({ data: { submissionId, assessmentId: id } });
      if (done(status)) return status;
      if (status.status === "failed") return status;
      if (Date.now() - start > 90_000) throw new Error("TAKE_QUEUE_TIMEOUT");
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 1.5, 5000);
    }
  }

  // Current answers as draft rows (shared by autosave and submit —
  // the queued submit carries the FULL final answers).
  function currentAnswerRows() {
    const times = recorder.getTimesSeconds();
    return Object.entries(answers).map(([question_id, response]) => ({
      question_id,
      response,
      time_spent_seconds: Math.max(0, Math.round(times[question_id] ?? 0)),
    }));
  }

  // --- §6 (integrity): recorder mounts only while a draft is being edited.
  const recorder = useIntegrityRecorder({
    enabled: !!draft,
    assessmentId: id,
    studentId: me?.id ?? "",
  });

  // --- §6: resume — flush the previous session's buffered events into the
  // draft, then record one session_interrupted event (once per draft).
  useEffect(() => {
    if (!draft || !me) return;
    if (freshDraftIds.current.has(draft.id)) return;
    const key = draft.id;
    if (resumeKey.current === key) return;
    resumeKey.current = key;
    (async () => {
      try {
        await recorder.flushEvents(draft.id);
      } catch {
        // Non-fatal: events stay buffered for the next flush.
      }
      // D1 (Phase 2): the resume event goes through the owner-checked
      // server function (the submission must be the student's own).
      // The buffered-events flush still uses the recorder hook, which
      // is a separate workstream (see report).
      try {
        await recordIntegrityEventD1({
          data: {
            submissionId: draft.id,
            eventType: "session_interrupted",
            questionId: null,
          },
        });
        toast.success(t("takeResumed"));
      } catch {
        // Non-fatal: the draft itself still loads.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.id, me?.id]);

  // --- §6: auto-start a new attempt when the student lands with no draft
  // and attempts remain. start_attempt is idempotent: a concurrent second
  // call simply resumes the in-progress row it finds.
  // Phase 3: the start is queued — the producer returns the
  // client-generated submission id immediately, and this effect polls
  // the status until the consumer creates the row (or redirects to an
  // existing in-progress row). A resume returns synchronously.
  async function startAttemptAndWait(order: string[]) {
    const submissionId = crypto.randomUUID();
    setStarting(true);
    try {
      const { queued, submissionId: returnedId } = await startAttemptD1({
        data: { assessmentId: id, questionOrder: order, submissionId },
      });
      let finalId = returnedId;
      if (queued) {
        try {
          const status = await pollTakeStatus(
            returnedId,
            (s) => s.status === "started" || s.status === "submitted",
          );
          if (status.status === "started" || status.status === "submitted") {
            finalId = status.submissionId;
          } else {
            throw new Error(status.status === "failed" ? status.reason : "TAKE_QUEUE_TIMEOUT");
          }
        } catch (err) {
          // Start timed out or failed in the queue: let the auto-start
          // effect run again (the consumer dedupes by student+exam),
          // and show the stuck notice in the meantime.
          startKey.current = "";
          setQueueStuck(true);
          throw err;
        }
      }
      freshDraftIds.current.add(finalId);
    } catch (err) {
      toast.error(translateError(err, lang));
    } finally {
      setStarting(false);
    }
    await qc.invalidateQueries({ queryKey: ["take", id, me?.id] });
  }

  useEffect(() => {
    if (!data || !me || me.role !== "student") return;
    if (!data.allowed || !data.assessment || data.assessment.status !== "published") return;
    if (draft || win !== "open") return;
    if (!canStartAttempt(submissions.length, maxAttempts)) return;
    const key = `${id}:${me.id}:${submissions.length}`;
    if (startKey.current === key) return;
    startKey.current = key;
    const order = shuffleIds(data.questions.map((q) => q.id));
    saveQuestionOrder(id, me.id, order);
    void startAttemptAndWait(order);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, me, draft, win]);

  // --- §6: question order — draft row wins, then localStorage, then a
  // fresh shuffle (which the auto-start above persists via start_attempt).
  const [displayOrder, setDisplayOrder] = useState<string[] | null>(null);
  const orderKeyRef = useRef("");
  useEffect(() => {
    if (!data || !me) return;
    const active = draft ?? latestSubmitted;
    const key = `${id}:${me.id}:${active?.id ?? "new"}`;
    if (orderKeyRef.current === key) return;
    orderKeyRef.current = key;
    const storedOrder =
      (active as unknown as { question_order?: string[] | null } | null)?.question_order ?? null;
    const stored = storedOrder ?? loadQuestionOrder(id, me.id);
    if (stored && stored.length > 0) {
      setDisplayOrder(
        resolveOrderIds(
          data.questions.map((q) => q.id),
          stored,
        ),
      );
      return;
    }
    setDisplayOrder(data.questions.map((q) => q.id));
  }, [data, me, id, draft, latestSubmitted]);

  // Initialise the form from the draft's answers exactly once per draft,
  // so refetches never clobber in-progress edits. The init must wait
  // out a background refetch: on a resume, React Query hands back the
  // previous visit's cached data first (draft + the answers as of that
  // visit's early fetch, i.e. empty), and initialising from it would
  // show an empty form — and let autosave overwrite the real saved
  // answers with blanks — while the fresh fetch is still in flight.
  // Skipping while isFetching leaves initKey unset, so the init runs
  // once the fresh data lands.
  useEffect(() => {
    if (!data || !draft || isFetching) return;
    const key = `${id}:${draft.id}`;
    if (initKey.current === key) return;
    initKey.current = key;
    // Phase 3: seed the draft counter from the server's applied seq so
    // a reload never re-uses a stale low number.
    draftSeqRef.current = Math.max(draftSeqRef.current, draft.draft_seq ?? 0);
    const next: Record<string, string> = {};
    for (const q of data.questions) next[q.id] = "";
    for (const a of data.answersBySubmission[draft.id] ?? [])
      next[a.question_id] = a.response ?? "";
    setAnswers(next);
  }, [data, id, draft, isFetching]);

  // --- §6: debounced autosave into the draft (server-enforced: edits
  // freeze at expiry / window end inside save_draft).
  // Phase 3: the save is queued — "queued" means durable in the queue
  // but not yet applied; the poll below waits for the consumer to
  // apply this seq (or a newer one, which subsumes it). A poll timeout
  // leaves the draft dirty so a later edit re-sends it.
  useEffect(() => {
    if (!draft || !me) return;
    const payload = JSON.stringify(answers);
    if (payload === lastSaved.current) return;
    setSaveState("saving");
    const timer = setTimeout(() => {
      const rows = currentAnswerRows();
      const seq = (draftSeqRef.current += 1);
      const saveWithRetry = async () => {
        for (let attempt = 0; ; attempt += 1) {
          try {
            return await saveDraftD1({
              data: { submissionId: draft.id, answers: rows, seq },
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (
              !/D1 DB is overloaded|D1_ERROR.*overloaded|too many resources consumed within a 10 second window/i.test(
                message,
              ) ||
              attempt >= 3
            )
              throw error;
            await new Promise((resolve) => setTimeout(resolve, [200, 400, 800][attempt]));
          }
        }
      };
      void saveWithRetry()
        .then(async ({ ok, queued }) => {
          if (!ok) {
            setSaveState("idle");
            return;
          }
          if (!queued) {
            lastSaved.current = payload;
            setSaveState("saved");
            try {
              await recorder.flushEvents(draft.id);
            } catch {
              // Non-fatal: events stay buffered for the next flush.
            }
            return;
          }
          setSaveState("queued");
          try {
            const status = await pollTakeStatus(
              draft.id,
              (s) =>
                (s.status === "started" || s.status === "submitted") &&
                (s.lastAppliedDraftSeq ?? 0) >= seq,
            );
            if (status.status === "failed" || status.status === "pending") {
              // "pending" cannot happen here (the poll only returns
              // once the draft applied), but treat it as not-saved so
              // the draft stays dirty and a later edit re-sends it.
              setSaveState("idle");
              return;
            }
            lastSaved.current = payload;
            draftSeqRef.current = Math.max(draftSeqRef.current, status.lastAppliedDraftSeq ?? seq);
            setSaveState("saved");
            try {
              await recorder.flushEvents(draft.id);
            } catch {
              // Non-fatal: events stay buffered for the next flush.
            }
          } catch {
            // Poll timed out: leave the draft dirty so a later edit or
            // the next autosave attempt can persist it without
            // interrupting the student.
            setSaveState("idle");
            setQueueStuck(true);
          }
        })
        .catch(() => {
          // Silent bounded retry: leave the draft dirty so a later edit or
          // the next autosave attempt can persist it without interrupting the student.
          setSaveState("idle");
        });
    }, 1500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answers, draft?.id]);

  // --- §6: live countdown. The deadline is the earlier of the server
  // timer expiry and the assessment due date.
  const deadlineMs = draft ? effectiveDeadlineMs(draft.expires_at, data?.assessment?.due_at) : null;
  useEffect(() => {
    if (deadlineMs === null) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [deadlineMs]);
  const remaining = remainingSeconds(deadlineMs, nowMs);

  // Phase 3: submit is queued with the FULL final answers — the
  // consumer applies them, then flips the status. The poll waits for
  // the submitted row; on timeout the draft stays (the message is
  // durable in the queue) and the stuck notice offers a re-check.
  async function submitAttempt() {
    if (!me || !draft || busy) return;
    setBusy(true);
    setSubmitState("submitting");
    const rows = currentAnswerRows();
    const seq = draftSeqRef.current + 1;
    let result: { ok: boolean; queued?: boolean };
    try {
      result = await submitAttemptD1({ data: { submissionId: draft.id, answers: rows, seq } });
    } catch (err) {
      setBusy(false);
      setSubmitState("idle");
      toast.error(translateError(err, lang));
      return;
    }
    if (!result.ok) {
      setBusy(false);
      setSubmitState("idle");
      toast.error(t("errorGeneric"));
      return;
    }
    if (result.queued) {
      setSubmitState("processing");
      try {
        const status = await pollTakeStatus(
          draft.id,
          (s) => s.status === "submitted" || s.status === "failed",
        );
        if (status.status === "failed") {
          setBusy(false);
          setSubmitState("idle");
          toast.error(t("errorGeneric"));
          return;
        }
      } catch {
        setBusy(false);
        setSubmitState("idle");
        setQueueStuck(true);
        return;
      }
    }
    setSubmitState("idle");
    setBusy(false);
    try {
      await recorder.flushEvents(draft.id);
    } catch {
      toast.error(t("integrityFlushWarning"));
    }
    toast.success(t("submitted"));
    await qc.invalidateQueries({ queryKey: ["take", id, me.id] });
  }

  // --- §6: auto-submit the frozen answers when the countdown hits zero.
  useEffect(() => {
    if (!draft || remaining === null || remaining !== 0) return;
    const key = draft.id;
    if (autoSubmitKey.current === key) return;
    autoSubmitKey.current = key;
    void submitAttempt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remaining, draft?.id]);

  async function startNewAttempt() {
    if (!me || !data || !data.allowed) return;
    const order = shuffleIds(data.questions.map((q) => q.id));
    saveQuestionOrder(id, me.id, order);
    await startAttemptAndWait(order);
  }

  if (meLoading || isLoading) return <p className="text-muted-foreground">{t("loading")}</p>;
  // While a fresh fetch is in flight, never render a terminal "not
  // assigned" state from possibly-stale cached data: a previous
  // visit's allowed:false payload (e.g. a direct URL opened before
  // approval) would otherwise flash here until the fresh fetch
  // lands. Content states (allowed + published) keep rendering
  // during background refetches, so a tab-switch refetch never
  // blanks an in-progress draft.
  if (
    isFetching &&
    (!data || !data.allowed || !data.assessment || data.assessment.status !== "published")
  ) {
    return <p className="text-muted-foreground">{t("loading")}</p>;
  }
  // Student-only page. Teachers are never assigned as students, but gate
  // explicitly so a teacher opening this URL gets a clear message instead
  // of a misleading "not assigned" state.
  if (me && me.role !== "student") return <Empty>{t("takeStudentsOnly")}</Empty>;
  if (error || !data) return <Empty>{t("takeNotAssigned")}</Empty>;

  // Gate failure: the server loaded nothing (no questions, answers,
  // or submissions), so this message is the whole page.
  if (!data.allowed || !data.assessment) return <Empty>{t("takeNotAssigned")}</Empty>;
  const { assessment } = data;
  const questions = displayOrder
    ? resolveQuestionOrder(data.questions, displayOrder)
    : data.questions;
  if (assessment.status !== "published") return <Empty>{t("takeNotAssigned")}</Empty>;
  if (questions.length === 0) return <Empty>{t("takeNoQuestions")}</Empty>;

  const total = questions.reduce((s, q) => s + Number(q.marks), 0);
  const editing = !!draft && remaining !== 0 && win !== "past_due";
  const pastDue = win === "past_due" && !draft;

  // Window hasn't opened and no draft exists (a draft always wins: a
  // student who already started is never locked out by a later edit).
  if (!draft && win === "not_started") return <Empty>{t("takeNotStarted")}</Empty>;
  if (!draft && starting)
    return (
      <>
        <p className="text-muted-foreground">{t("loading")}</p>
        {queueStuck && (
          <Panel className="mt-6 space-y-2 text-sm">
            <p>{t("takeQueueStuck")}</p>
            <Button
              variant="secondary"
              onClick={() => {
                setQueueStuck(false);
                void qc.invalidateQueries({ queryKey: ["take", id, me?.id] });
              }}
            >
              {t("takeRecheck")}
            </Button>
          </Panel>
        )}
      </>
    );

  // History view: latest submitted attempt, with a new-attempt button
  // while the teacher's max_attempts allows it and the window is open.
  if (!draft && latestSubmitted) {
    const rows = data.answersBySubmission[latestSubmitted.id] ?? [];
    const answerByQuestion = new Map(rows.map((a) => [a.question_id, a]));
    const canNew = canStartAttempt(submissions.length, maxAttempts) && win === "open";
    return (
      <>
        <PageHeader
          title={assessment.title}
          subtitle={
            <span className="flex flex-wrap items-center gap-2">
              <Pill t={statusTone[latestSubmitted.status] ?? "neutral"}>
                {t(`sub_${latestSubmitted.status}` as never)}
              </Pill>
              {t("takeAttempt")}: {latestSubmitted.attempt_number} · {t("totalMarks")}: {total}
              {latestSubmitted.status === "released" && latestSubmitted.final_score !== null && (
                <>
                  {" "}
                  {t("finalScore")}: {Number(latestSubmitted.final_score)} /{" "}
                  {Number(latestSubmitted.total_possible)}
                </>
              )}
            </span>
          }
        />
        {latestSubmitted.status !== "released" && (
          <p className="mb-6 rounded-md bg-info/15 p-3 text-sm">{t("takeLocked")}</p>
        )}
        <div className="space-y-6">
          {questions.map((q, i) => (
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
              <p className="whitespace-pre-wrap rounded-md bg-muted p-3 text-sm">
                {t("yourAnswer")}: {answerByQuestion.get(q.id)?.response || t("unanswered")}
              </p>
            </Panel>
          ))}
        </div>
        {canNew && (
          <div className="mt-6">
            <Button onClick={startNewAttempt} disabled={starting}>
              {starting ? t("saving") : t("takeNewAttempt")}
            </Button>
          </div>
        )}
      </>
    );
  }

  if (!draft && pastDue) return <Empty>{t("takeLateBlocked")}</Empty>;
  if (!draft) return <Empty>{t("takeNotAssigned")}</Empty>;

  // Answering mode: editing a draft (or finalising frozen answers).
  return (
    <>
      <PageHeader
        title={assessment.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Pill t="neutral">
              {t("takeAttempt")}: {draft.attempt_number}
            </Pill>
            {remaining !== null && (
              <Pill t={remaining <= 60 ? "danger" : "neutral"}>
                {t("takeTimeLeft")}: {formatCountdown(remaining)}
              </Pill>
            )}
            {t("totalMarks")}: {total} · {t("questions")}: {questions.length}
            {assessment.due_at && (
              <span>
                {t("dueAt")}: {formatDate(assessment.due_at, lang)}
              </span>
            )}
            {saveState === "saving" && (
              <span className="text-xs text-muted-foreground">{t("takeSaving")}</span>
            )}
            {saveState === "queued" && (
              <span className="text-xs text-muted-foreground">{t("takeQueued")}</span>
            )}
            {saveState === "saved" && (
              <span className="text-xs text-muted-foreground">{t("takeSaved")}</span>
            )}
          </span>
        }
      />
      {assessment.instructions && (
        <Panel className="mb-6 whitespace-pre-wrap text-sm">{assessment.instructions}</Panel>
      )}
      {submitState === "processing" && (
        <p className="mb-6 rounded-md bg-info/15 p-3 text-sm">{t("takeProcessing")}</p>
      )}
      {queueStuck && (
        <Panel className="mb-6 space-y-2 text-sm">
          <p>{t("takeQueueStuck")}</p>
          <Button
            variant="secondary"
            onClick={() => {
              setQueueStuck(false);
              void qc.invalidateQueries({ queryKey: ["take", id, me?.id] });
            }}
          >
            {t("takeRecheck")}
          </Button>
        </Panel>
      )}
      {!editing && (
        <p className="mb-6 rounded-md bg-destructive/15 p-3 text-sm">{t("takeLateBlocked")}</p>
      )}

      <div className="space-y-6">
        {questions.map((q, i) => (
          <div
            key={q.id}
            ref={recorder.registerPanel(q.id)}
            onFocusCapture={() => recorder.setCurrentQuestionId(q.id)}
          >
            <Panel className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-primary">
                  {t("question")} {i + 1} · {t(`q_${q.type}` as never)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t("marks")}: {Number(q.marks)}
                </span>
              </div>
              <p className="whitespace-pre-wrap text-sm">{q.prompt}</p>
              {q.type === "mcq" && (
                <fieldset disabled={!editing} className="space-y-2">
                  {((q.options as string[]) ?? []).map((opt, oi) => (
                    <label key={oi} className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name={`q-${q.id}`}
                        checked={(answers[q.id] ?? "") === opt}
                        onChange={() => setAnswers({ ...answers, [q.id]: opt })}
                      />
                      {opt}
                    </label>
                  ))}
                </fieldset>
              )}
              {q.type === "true_false" && (
                <fieldset disabled={!editing} className="flex gap-4">
                  {(["true", "false"] as const).map((v) => (
                    <label key={v} className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name={`q-${q.id}`}
                        checked={(answers[q.id] ?? "") === v}
                        onChange={() => setAnswers({ ...answers, [q.id]: v })}
                      />
                      {v === "true" ? t("trueLabel") : t("falseLabel")}
                    </label>
                  ))}
                </fieldset>
              )}
              {q.type === "short_answer" && (
                <div className="space-y-1.5">
                  <Label htmlFor={`a-${q.id}`}>{t("yourAnswer")}</Label>
                  <Input
                    id={`a-${q.id}`}
                    value={answers[q.id] ?? ""}
                    maxLength={20000}
                    disabled={!editing}
                    onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                  />
                </div>
              )}
              {q.type === "written" && (
                <div className="space-y-1.5">
                  <Label htmlFor={`a-${q.id}`}>{t("yourAnswer")}</Label>
                  <Textarea
                    id={`a-${q.id}`}
                    rows={5}
                    value={answers[q.id] ?? ""}
                    maxLength={20000}
                    disabled={!editing}
                    onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                  />
                </div>
              )}
            </Panel>
          </div>
        ))}
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        {confirming ? (
          <>
            <span className="text-sm">{t("submitConfirm")}</span>
            <Button
              onClick={async () => {
                setConfirming(false);
                await submitAttempt();
              }}
              disabled={busy}
            >
              {busy ? t("saving") : t("submit")}
            </Button>
            <button
              type="button"
              className="text-sm underline"
              onClick={() => setConfirming(false)}
            >
              {t("cancel")}
            </button>
          </>
        ) : (
          <Button onClick={() => setConfirming(true)} disabled={busy}>
            {busy ? t("saving") : t("submit")}
          </Button>
        )}
      </div>
    </>
  );
}

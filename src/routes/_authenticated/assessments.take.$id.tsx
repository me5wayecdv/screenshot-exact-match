import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { useI18n, translateError, formatDate } from "@/lib/i18n";
import { useIntegrityRecorder } from "@/hooks/useIntegrityRecorder";
import {
  loadQuestionOrder,
  saveQuestionOrder,
  resolveQuestionOrder,
  resolveOrderIds,
  shuffleIds,
} from "@/lib/shuffle";
import { useMe } from "@/lib/session";
import { PageHeader, Panel, Pill, Empty, statusTone } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type Q = Database["public"]["Tables"]["questions"]["Row"];
type Submission = Database["public"]["Tables"]["submissions"]["Row"];
// Answers live in the EXISTING public.answers table (see the base
// migration). No second answer store is created.
type AnswerRow = Database["public"]["Tables"]["answers"]["Row"];

export const Route = createFileRoute("/_authenticated/assessments/take/$id")({
  head: () => ({
    meta: [
      { title: "Take assessment · Qemmini" },
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
      const [a, asg, q] = await Promise.all([
        supabase.from("assessments").select("*").eq("id", id).single(),
        supabase
          .from("assessment_assignments")
          .select("student_id")
          .eq("assessment_id", id)
          .eq("student_id", studentId!)
          .maybeSingle(),
        // Questions ONLY. Never select question_keys here: keys are
        // teacher-only via RLS and must never reach the student client.
        supabase.from("questions").select("*").eq("assessment_id", id).order("position"),
      ]);
      if (a.error) throw a.error;
      const submissionRes = await supabase
        .from("submissions")
        .select("*")
        .eq("assessment_id", id)
        .eq("student_id", studentId!)
        .maybeSingle();
      if (submissionRes.error) throw submissionRes.error;
      let existingAnswers: AnswerRow[] = [];
      if (submissionRes.data) {
        const ans = await supabase
          .from("answers")
          .select("*")
          .eq("submission_id", submissionRes.data.id);
        if (ans.error) throw ans.error;
        existingAnswers = (ans.data ?? []) as unknown as AnswerRow[];
      }
      return {
        assessment: a.data,
        assigned: !!asg.data,
        questions: (q.data ?? []) as Q[],
        submission: submissionRes.data as Submission | null,
        existingAnswers,
      };
    },
  });
}

function Take() {
  const { id } = Route.useParams();
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const { data: me, isLoading: meLoading } = useMe();
  const { data, isLoading, error } = useTakeData(id, me?.id);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const initKey = useRef("");

  // --- Slice 3 (integrity): recorder mounts only while answering ---
  // (data loaded + student + no submission yet + not past due). The locked
  // review view records nothing.
  const answering =
    !!data &&
    !!me &&
    me.role === "student" &&
    !data.submission &&
    !(data.assessment.due_at && Date.now() > new Date(data.assessment.due_at).getTime());
  const recorder = useIntegrityRecorder({
    enabled: answering,
    assessmentId: id,
    studentId: me?.id ?? "",
  });

  // --- Slice 3 (integrity): per-student shuffled question order ---
  // Submission column wins, then localStorage; a fresh shuffle is saved to
  // localStorage immediately and to the submission row at submit time.
  // Locked legacy submissions (no stored order anywhere) keep position order.
  const [displayOrder, setDisplayOrder] = useState<string[] | null>(null);
  const orderKeyRef = useRef("");
  useEffect(() => {
    if (!data || !me) return;
    const key = `${id}:${me.id}:${data.submission?.id ?? "new"}`;
    if (orderKeyRef.current === key) return;
    orderKeyRef.current = key;
    const submissionOrder =
      (data.submission as unknown as { question_order?: string[] | null } | null)?.question_order ??
      null;
    const stored = submissionOrder ?? loadQuestionOrder(id, me.id);
    if (stored && stored.length > 0) {
      setDisplayOrder(
        resolveOrderIds(
          data.questions.map((q) => q.id),
          stored,
        ),
      );
      return;
    }
    if (data.submission) {
      setDisplayOrder(data.questions.map((q) => q.id));
      return;
    }
    const fresh = shuffleIds(data.questions.map((q) => q.id));
    saveQuestionOrder(id, me.id, fresh);
    setDisplayOrder(fresh);
  }, [data, me, id]);

  // Initialise the form from an existing submission's answers exactly once
  // per assessment/submission, so refetches never clobber in-progress edits.
  useEffect(() => {
    if (!data) return;
    const key = `${id}:${data.submission?.id ?? "new"}`;
    if (initKey.current === key) return;
    initKey.current = key;
    const next: Record<string, string> = {};
    for (const q of data.questions) next[q.id] = "";
    for (const a of data.existingAnswers) next[a.question_id] = a.response ?? "";
    setAnswers(next);
  }, [data, id]);

  if (meLoading || isLoading) return <p className="text-muted-foreground">{t("loading")}</p>;
  // Student-only page. Teachers are never assigned as students, but gate
  // explicitly so a teacher opening this URL gets a clear message instead
  // of a misleading "not assigned" state.
  if (me && me.role !== "student") return <Empty>{t("takeStudentsOnly")}</Empty>;
  if (error || !data) return <Empty>{t("takeNotAssigned")}</Empty>;

  const { assessment, submission } = data;
  const questions = displayOrder
    ? resolveQuestionOrder(data.questions, displayOrder)
    : data.questions;
  if (!data.assigned || assessment.status !== "published")
    return <Empty>{t("takeNotAssigned")}</Empty>;
  if (questions.length === 0) return <Empty>{t("takeNoQuestions")}</Empty>;

  const locked = !!submission;
  const late = !!assessment.due_at && !locked && Date.now() > new Date(assessment.due_at).getTime();
  const total = questions.reduce((s, q) => s + Number(q.marks), 0);
  const answerByQuestion = new Map(data.existingAnswers.map((a) => [a.question_id, a]));

  async function submit() {
    if (!me || locked || late) return;
    if (!window.confirm(t("submitConfirm"))) return;
    setBusy(true);
    const { data: sub, error: sErr } = await supabase
      .from("submissions")
      .insert({
        assessment_id: id,
        student_id: me.id,
        status: "awaiting_review",
        total_possible: total,
        ...(displayOrder || questions.length > 0
          ? { question_order: displayOrder ?? questions.map((q) => q.id) }
          : {}),
      })
      .select("id")
      .single();
    if (sErr || !sub) {
      setBusy(false);
      // Unique (assessment_id, student_id): a submission already exists
      // (e.g. submitted in another tab). Reload into the locked view.
      if (sErr?.code === "23505") {
        toast.error(t("alreadySubmitted"));
        await qc.invalidateQueries({ queryKey: ["take", id, me.id] });
        return;
      }
      return void toast.error(translateError(sErr, lang));
    }
    const times = recorder.getTimesSeconds();
    const rows = questions.map((q) => ({
      submission_id: sub.id,
      question_id: q.id,
      response: answers[q.id] ?? "",
      max_marks: Number(q.marks),
      review_status: "not_graded",
      time_spent_seconds: Math.max(0, Math.round(times[q.id] ?? 0)),
    }));
    const { error: aErr } = await supabase.from("answers").insert(rows);
    setBusy(false);
    if (aErr) {
      // Known partial-failure edge (see deliverable notes): the submission
      // row now exists but its answers did not save. Surface the error and
      // reload; do not silently pretend the submission succeeded.
      toast.error(translateError(aErr, lang));
      await qc.invalidateQueries({ queryKey: ["take", id, me.id] });
      return;
    }
    try {
      await recorder.flushEvents(sub.id);
    } catch {
      // Non-fatal: the submission + answers are already saved.
      toast.error(t("integrityFlushWarning"));
    }
    toast.success(t("submitted"));
    await qc.invalidateQueries({ queryKey: ["take", id, me.id] });
  }

  return (
    <>
      <PageHeader
        title={assessment.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            {locked && submission && (
              <Pill t={statusTone[submission.status] ?? "neutral"}>
                {t(`sub_${submission.status}` as never)}
              </Pill>
            )}
            {t("totalMarks")}: {total} · {t("questions")}: {questions.length}
            {assessment.due_at && (
              <span>
                {t("dueAt")}: {formatDate(assessment.due_at, lang)}
              </span>
            )}
          </span>
        }
      />
      {assessment.instructions && (
        <Panel className="mb-6 whitespace-pre-wrap text-sm">{assessment.instructions}</Panel>
      )}
      {locked && (
        <p className="mb-6 rounded-md bg-info/15 p-3 text-sm">
          {t("takeLocked")}
          {submission?.status === "released" && submission.final_score !== null && (
            <>
              {" "}
              {t("finalScore")}: {Number(submission.final_score)} /{" "}
              {Number(submission.total_possible)}
            </>
          )}
        </p>
      )}
      {late && (
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
                <fieldset disabled={locked || late} className="space-y-2">
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
                <fieldset disabled={locked || late} className="flex gap-4">
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
                    disabled={locked || late}
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
                    disabled={locked || late}
                    onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                  />
                </div>
              )}
              {locked && (
                <p className="whitespace-pre-wrap rounded-md bg-muted p-3 text-sm">
                  {t("yourAnswer")}: {answerByQuestion.get(q.id)?.response || t("unanswered")}
                </p>
              )}
            </Panel>
          </div>
        ))}
      </div>

      {!locked && !late && (
        <div className="mt-6">
          <Button onClick={submit} disabled={busy}>
            {busy ? t("saving") : t("submit")}
          </Button>
        </div>
      )}
    </>
  );
}

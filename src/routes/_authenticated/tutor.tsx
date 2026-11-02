import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useI18n, translateError } from "@/lib/i18n";
import { useMe } from "@/lib/session";
import { PageHeader, Panel, Pill, Empty } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  computeObjectiveStats,
  computeQuestionStats,
  formatPct,
  reteachTopics,
  type AnswerInput,
  type QuestionInput,
} from "@/lib/analytics";
import { askTutor, getTutorStatus, tutorPracticeFeedback, tutorStudyTips } from "@/server/tutor";

// Phase 5 — smart tutor (students only).
//
// SESSION-ONLY BY DESIGN: chat messages and practice attempts are kept
// in browser state and vanish on leaving the page — no new table, no
// migration. The page says so plainly (tutorSessionNote).
//
// SAFETY: every AI call is validated server-side — the question must
// belong to an assessment where THIS student has a RELEASED submission,
// and question_keys is never read. The tutor gives hints and
// step-by-step explanations, never a ready-made answer or a key.

type ChatMsg = { role: "user" | "assistant"; content: string };

export const Route = createFileRoute("/_authenticated/tutor")({
  head: () => ({
    meta: [
      { title: "Smart tutor · Qayyimni" },
      {
        name: "description",
        content: "Step-by-step explanations, hints and personal review plans.",
      },
    ],
  }),
  component: TutorPage,
});

function TutorPage() {
  const { t, lang } = useI18n();
  const { data: me, isLoading: meLoading } = useMe();
  const role = me?.role as string | undefined;
  const isStudent = role === "student";

  const [selectedId, setSelectedId] = useState("");
  const [questionId, setQuestionId] = useState("");
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [followUp, setFollowUp] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [topic, setTopic] = useState("");
  const [topicChat, setTopicChat] = useState<ChatMsg[]>([]);
  const [topicBusy, setTopicBusy] = useState(false);
  const [practiceQ, setPracticeQ] = useState("");
  const [newAnswer, setNewAnswer] = useState("");
  const [practiceFeedback, setPracticeFeedback] = useState("");
  const [practiceBusy, setPracticeBusy] = useState(false);
  const [tips, setTips] = useState<{ objective: string; tip: string }[]>([]);
  const [tipsBusy, setTipsBusy] = useState(false);

  const statusQuery = useQuery({
    queryKey: ["tutor-status"],
    enabled: isStudent,
    queryFn: () => getTutorStatus({ data: {} }),
  });
  const configured = statusQuery.data?.configured ?? null;

  const releasedQuery = useQuery({
    queryKey: ["tutor-released", me?.id],
    enabled: !!me?.id && isStudent,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("submissions")
        .select("id, assessment_id, final_score, total_possible")
        .eq("student_id", me!.id)
        .eq("status", "released")
        .order("id", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
  const released = releasedQuery.data ?? [];
  const assessmentIds = [...new Set(released.map((s) => s.assessment_id))];

  const assessmentsQuery = useQuery({
    queryKey: ["tutor-assessments", assessmentIds.join(",")],
    enabled: assessmentIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("assessments")
        .select("id, title, subject_id")
        .in("id", assessmentIds);
      if (error) throw error;
      return data ?? [];
    },
  });
  const assessments = useMemo(() => assessmentsQuery.data ?? [], [assessmentsQuery.data]);

  useEffect(() => {
    if (!selectedId && assessments.length > 0) setSelectedId(assessments[0]!.id);
  }, [selectedId, assessments]);

  const submission = released.find((s) => s.assessment_id === selectedId) ?? null;

  const detailQuery = useQuery({
    queryKey: ["tutor-detail", selectedId, submission?.id],
    enabled: !!selectedId && !!submission,
    queryFn: async () => {
      const { data: questions, error: qErr } = await supabase
        .from("questions")
        .select("id, position, type, prompt, marks, objective, options")
        .eq("assessment_id", selectedId)
        .order("position");
      if (qErr) throw qErr;
      const { data: answers, error: aErr } = await supabase
        .from("answers")
        .select("question_id, response, final_score, auto_score, feedback")
        .eq("submission_id", submission!.id);
      if (aErr) throw aErr;
      return { questions: questions ?? [], answers: answers ?? [] };
    },
  });

  useEffect(() => {
    const qs = detailQuery.data?.questions ?? [];
    if (qs.length > 0 && !qs.some((q) => q.id === questionId)) {
      setQuestionId(qs[0]!.id);
      setChat([]);
    }
  }, [detailQuery.data, questionId]);

  useEffect(() => {
    const qs = detailQuery.data?.questions ?? [];
    if (qs.length > 0 && !qs.some((q) => q.id === practiceQ)) {
      setPracticeQ(qs[0]!.id);
    }
  }, [detailQuery.data, practiceQ]);

  async function getAccessToken(): Promise<string> {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? "";
  }

  async function sendChat(mode: "hint" | "explain", customText?: string) {
    if (!questionId) return;
    const answer = detailQuery.data?.answers.find((a) => a.question_id === questionId);
    const display = customText ?? (mode === "hint" ? t("tutorHintAsk") : t("tutorExplainAsk"));
    const history = chat;
    setChat((prev) => [...prev, { role: "user", content: display }]);
    setChatBusy(true);
    try {
      const accessToken = await getAccessToken();
      const result = await askTutor({
        data: {
          accessToken,
          language: lang,
          questionId,
          studentAnswer: answer?.response ?? "",
          teacherFeedback: answer?.feedback ?? "",
          mode,
          customText: customText?.trim() ? customText.trim() : undefined,
          messages: history,
        },
      });
      if (!result.ok) {
        toast.error(
          result.code === "TUTOR_NOT_CONFIGURED"
            ? t("tutorNotConfigured")
            : translateError(result, lang),
        );
        return;
      }
      setChat((prev) => [...prev, { role: "assistant", content: result.reply }]);
    } catch (err) {
      toast.error(translateError(err, lang));
    } finally {
      setChatBusy(false);
    }
  }

  async function sendTopic() {
    const text = topic.trim();
    if (!text) return;
    const history = topicChat;
    setTopicChat((prev) => [...prev, { role: "user", content: text }]);
    setTopic("");
    setTopicBusy(true);
    try {
      const accessToken = await getAccessToken();
      const result = await askTutor({
        data: { accessToken, language: lang, topic: text, mode: "explain", messages: history },
      });
      if (!result.ok) {
        toast.error(
          result.code === "TUTOR_NOT_CONFIGURED"
            ? t("tutorNotConfigured")
            : translateError(result, lang),
        );
        return;
      }
      setTopicChat((prev) => [...prev, { role: "assistant", content: result.reply }]);
    } catch (err) {
      toast.error(translateError(err, lang));
    } finally {
      setTopicBusy(false);
    }
  }

  async function evaluatePractice() {
    if (!practiceQ || !newAnswer.trim()) return;
    setPracticeBusy(true);
    setPracticeFeedback("");
    try {
      const accessToken = await getAccessToken();
      const result = await tutorPracticeFeedback({
        data: { accessToken, language: lang, questionId: practiceQ, newAnswer: newAnswer.trim() },
      });
      if (!result.ok) {
        toast.error(
          result.code === "TUTOR_NOT_CONFIGURED"
            ? t("tutorNotConfigured")
            : translateError(result, lang),
        );
        return;
      }
      setPracticeFeedback(result.reply);
    } catch (err) {
      toast.error(translateError(err, lang));
    } finally {
      setPracticeBusy(false);
    }
  }

  async function generateTips(weakObjectives: string[]) {
    if (!selectedId || weakObjectives.length === 0) return;
    setTipsBusy(true);
    try {
      const accessToken = await getAccessToken();
      const result = await tutorStudyTips({
        data: { accessToken, language: lang, assessmentId: selectedId, objectives: weakObjectives },
      });
      if (!result.ok) {
        toast.error(
          result.code === "TUTOR_NOT_CONFIGURED"
            ? t("tutorNotConfigured")
            : translateError(result, lang),
        );
        return;
      }
      setTips(result.tips);
    } catch (err) {
      toast.error(translateError(err, lang));
    } finally {
      setTipsBusy(false);
    }
  }

  if (meLoading) return <p className="text-muted-foreground">{t("loading")}</p>;
  if (!me || !isStudent) return <Empty>{t("tutorStudentOnly")}</Empty>;

  const questions = detailQuery.data?.questions ?? [];
  const answers = detailQuery.data?.answers ?? [];
  const questionStats = computeQuestionStats(
    questions.map((q): QuestionInput => ({
      id: q.id,
      prompt: q.prompt,
      type: q.type,
      marks: Number(q.marks),
      objective: q.objective ?? "",
      difficulty: "medium",
    })),
    answers.map((a): AnswerInput => ({
      question_id: a.question_id,
      auto_score: a.auto_score,
      final_score: a.final_score,
    })),
  );
  const objectiveStats = computeObjectiveStats(questionStats);
  const weak = reteachTopics(objectiveStats, 50);
  const weakObjectives = weak.map((o) => o.objective);
  const selectedQuestion = questions.find((q) => q.id === questionId) ?? null;
  const selectedAnswer = answers.find((a) => a.question_id === questionId) ?? null;
  const selectedScore =
    selectedAnswer && (selectedAnswer.final_score ?? selectedAnswer.auto_score) !== null
      ? Number(selectedAnswer.final_score ?? selectedAnswer.auto_score)
      : null;
  const practiceQuestion = questions.find((q) => q.id === practiceQ) ?? null;

  return (
    <>
      <PageHeader title={t("tutorTitle")} subtitle={t("tutorSubtitle")} />
      <div className="space-y-6">
        <Panel>
          <p className="text-sm text-muted-foreground">{t("tutorSessionNote")}</p>
        </Panel>
        {configured === false && (
          <Panel>
            <p className="rounded-md bg-warning/20 p-3 text-sm">{t("tutorNotConfigured")}</p>
          </Panel>
        )}

        {assessments.length === 0 ? (
          <Empty>{t("tutorNoReleased")}</Empty>
        ) : (
          <>
            <Panel className="space-y-4">
              <h2 className="font-semibold">{t("tutorSelectAssessment")}</h2>
              <select
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={selectedId}
                onChange={(e) => {
                  setSelectedId(e.target.value);
                  setChat([]);
                  setTips([]);
                }}
              >
                {assessments.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.title}
                  </option>
                ))}
              </select>
            </Panel>

            <Panel className="space-y-4">
              <h2 className="font-semibold">{t("tutorWeakObjectives")}</h2>
              <p className="text-xs text-muted-foreground">{t("tutorWeakNote")}</p>
              {weak.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("tutorNoWeak")}</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {weak.map((o) => (
                    <li key={o.objective}>
                      {o.objective || t("anNoObjective")} — {formatPct(o.avgPct, lang)}
                    </li>
                  ))}
                </ul>
              )}
              <h3 className="text-sm font-medium">{t("tutorPlan")}</h3>
              <p className="text-xs text-muted-foreground">{t("tutorPlanNote")}</p>
              <Button
                variant="outline"
                onClick={() => void generateTips(weakObjectives)}
                disabled={tipsBusy || weakObjectives.length === 0 || configured === false}
              >
                {tipsBusy ? t("tutorGeneratingTips") : t("tutorGenerateTips")}
              </Button>
              {tips.length > 0 && (
                <ul className="space-y-2 text-sm">
                  {tips.map((tip) => (
                    <li key={tip.objective}>
                      <span className="font-medium">{tip.objective || t("anNoObjective")}:</span>{" "}
                      {tip.tip}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            {detailQuery.isLoading ? (
              <p className="text-sm text-muted-foreground">{t("loading")}</p>
            ) : questions.length > 0 ? (
              <>
                <Panel className="space-y-4">
                  <h2 className="font-semibold">{t("tutorQuestion")}</h2>
                  <div className="space-y-1.5">
                    <Label>{t("tutorQuestion")}</Label>
                    <select
                      className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                      value={questionId}
                      onChange={(e) => {
                        setQuestionId(e.target.value);
                        setChat([]);
                      }}
                    >
                      {questions.map((q, i) => (
                        <option key={q.id} value={q.id}>
                          {i + 1}. {(q.prompt || "").slice(0, 60)}
                        </option>
                      ))}
                    </select>
                  </div>
                  {selectedQuestion && (
                    <div className="space-y-2 text-sm">
                      <p className="whitespace-pre-wrap">{selectedQuestion.prompt}</p>
                      {Array.isArray(selectedQuestion.options) &&
                        (selectedQuestion.options as string[]).length > 0 && (
                          <ul className="list-disc ps-5 text-muted-foreground">
                            {(selectedQuestion.options as string[]).map((opt, i) => (
                              <li key={i}>{opt}</li>
                            ))}
                          </ul>
                        )}
                      <p>
                        {t("tutorYourAnswer")}:{" "}
                        <span className="text-muted-foreground">
                          {selectedAnswer?.response || t("tutorNoAnswer")}
                        </span>
                      </p>
                      <p>
                        {t("tutorYourScore")}:{" "}
                        <span dir="ltr">
                          {selectedScore !== null
                            ? `${selectedScore} / ${Number(selectedQuestion.marks)}`
                            : "—"}
                        </span>{" "}
                        <Pill>{t(`q_${selectedQuestion.type}` as never)}</Pill>
                      </p>
                      {selectedAnswer?.feedback ? (
                        <p>
                          {t("tutorTeacherFeedback")}:{" "}
                          <span className="text-muted-foreground">{selectedAnswer.feedback}</span>
                        </p>
                      ) : null}
                    </div>
                  )}
                  <div className="space-y-2">
                    {chat.map((m, i) => (
                      <p
                        key={i}
                        className={`whitespace-pre-wrap rounded-md p-3 text-sm ${
                          m.role === "user" ? "bg-muted" : "border"
                        }`}
                      >
                        {m.content}
                      </p>
                    ))}
                    {chatBusy && (
                      <p className="text-sm text-muted-foreground">{t("tutorThinking")}</p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      onClick={() => void sendChat("hint")}
                      disabled={chatBusy || configured === false}
                    >
                      {t("tutorHintAsk")}
                    </Button>
                    <Button
                      onClick={() => void sendChat("explain")}
                      disabled={chatBusy || configured === false}
                    >
                      {t("tutorExplainAsk")}
                    </Button>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      value={followUp}
                      onChange={(e) => setFollowUp(e.target.value)}
                      placeholder={t("tutorAskPlaceholder")}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && followUp.trim()) {
                          const text = followUp;
                          setFollowUp("");
                          void sendChat("explain", text);
                        }
                      }}
                    />
                    <Button
                      onClick={() => {
                        const text = followUp;
                        setFollowUp("");
                        void sendChat("explain", text);
                      }}
                      disabled={chatBusy || !followUp.trim() || configured === false}
                    >
                      {t("tutorSend")}
                    </Button>
                  </div>
                </Panel>

                <Panel className="space-y-4">
                  <h2 className="font-semibold">{t("tutorPractice")}</h2>
                  <p className="text-xs text-muted-foreground">{t("tutorPracticeNote")}</p>
                  <div className="space-y-1.5">
                    <Label>{t("tutorPracticeQuestion")}</Label>
                    <select
                      className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                      value={practiceQ}
                      onChange={(e) => setPracticeQ(e.target.value)}
                    >
                      {questions.map((q, i) => (
                        <option key={q.id} value={q.id}>
                          {i + 1}. {(q.prompt || "").slice(0, 60)}
                        </option>
                      ))}
                    </select>
                  </div>
                  {practiceQuestion && (
                    <p className="whitespace-pre-wrap text-sm">{practiceQuestion.prompt}</p>
                  )}
                  <div className="space-y-1.5">
                    <Label>{t("tutorNewAnswer")}</Label>
                    <Textarea
                      value={newAnswer}
                      onChange={(e) => setNewAnswer(e.target.value)}
                      rows={3}
                    />
                  </div>
                  <Button
                    onClick={() => void evaluatePractice()}
                    disabled={practiceBusy || !newAnswer.trim() || configured === false}
                  >
                    {practiceBusy ? t("tutorEvaluating") : t("tutorEvaluate")}
                  </Button>
                  {practiceFeedback && (
                    <div className="space-y-1">
                      <p className="text-sm font-medium">{t("tutorFeedback")}</p>
                      <p className="whitespace-pre-wrap rounded-md border p-3 text-sm">
                        {practiceFeedback}
                      </p>
                    </div>
                  )}
                </Panel>
              </>
            ) : null}

            <Panel className="space-y-4">
              <h2 className="font-semibold">{t("tutorFreeTopic")}</h2>
              <p className="text-xs text-muted-foreground">{t("tutorTopicHint")}</p>
              <div className="space-y-2">
                {topicChat.map((m, i) => (
                  <p
                    key={i}
                    className={`whitespace-pre-wrap rounded-md p-3 text-sm ${
                      m.role === "user" ? "bg-muted" : "border"
                    }`}
                  >
                    {m.content}
                  </p>
                ))}
                {topicBusy && <p className="text-sm text-muted-foreground">{t("tutorThinking")}</p>}
              </div>
              <div className="flex gap-2">
                <Input
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder={t("tutorFreeTopicPlaceholder")}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && topic.trim()) void sendTopic();
                  }}
                />
                <Button
                  onClick={() => void sendTopic()}
                  disabled={topicBusy || !topic.trim() || configured === false}
                >
                  {t("tutorAskTopic")}
                </Button>
              </div>
            </Panel>
          </>
        )}
      </div>
    </>
  );
}

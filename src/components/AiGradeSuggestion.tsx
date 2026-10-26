/**
 * AiGradeSuggestion — per-written-answer "suggest grade" control for the
 * /grading page (slice 1).
 *
 * Behaviour (teacher-final-word, unchanged release gate):
 *  - Renders only for written answers (the parent guards q.type === "written").
 *  - "Suggest" calls the server function suggestGrade; the AI key never
 *    touches this component — only the teacher's Supabase session token is
 *    forwarded so the server can re-check role + assessment ownership.
 *  - On success it shows suggested score + Arabic feedback + confidence,
 *    with Accept / Edit / Reject.
 *  - Accept fills the parent's teacher score/feedback fields via onAccept.
 *    It does NOT save to Supabase and does NOT release anything: the teacher
 *    still presses the page's existing "save" / "release" buttons, and the
 *    existing release gate (every question needs a teacher score) is
 *    untouched.
 *  - Edit lets the teacher change score/feedback before applying; Reject
 *    discards the suggestion and returns to the idle button.
 *  - If the server reports AI_NOT_CONFIGURED (or the status probe says the
 *    provider is not configured), the button becomes disabled with a clear
 *    "AI not configured" note instead of failing silently.
 *
 * Parent wiring (see NOTES.md): render with key={answerId} so switching
 * submissions never leaks one answer's suggestion into another's card.
 */

import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useI18n } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  getAiGradingStatus,
  logAiTrainingExample,
  suggestGrade,
  type AiGradeSuggestion as ServerSuggestion,
} from "@/server/ai-grade";

export type AiGradeAcceptValue = {
  score: number;
  feedback: string;
};

export type AiGradeSuggestionProps = {
  /** answers.id — used as the React key by the parent; see header note. */
  answerId: string;
  questionPrompt: string;
  /** question_keys.rubric (empty string when none). */
  rubric: string;
  /** question_keys.accepted_alternatives (empty array when none). */
  acceptedAlternatives: string[];
  /** answers.response. */
  studentAnswer: string;
  /** questions.marks / answers.max_marks. */
  maxMarks: number;
  /** submissions.assessment_id — enables the server-side ownership check. */
  assessmentId?: string;
  /**
   * Called on Accept (or on applying an edited suggestion). The parent
   * writes these into its existing score/feedback state, e.g.:
   *   setScores((p) => ({ ...p, [answerId]: String(v.score) }));
   *   setFeedbacks((p) => ({ ...p, [answerId]: v.feedback }));
   * Nothing is saved to Supabase here.
   */
  onAccept: (value: AiGradeAcceptValue) => void;
};

type Phase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "suggested"; suggestion: ServerSuggestion }
  | { kind: "editing"; suggestion: ServerSuggestion; score: string; feedback: string }
  | { kind: "accepted" }
  | { kind: "needsKey" }
  | { kind: "error"; message: string };

function formatScore(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

export function AiGradeSuggestion({
  answerId: _answerId,
  questionPrompt,
  rubric,
  acceptedAlternatives,
  studentAnswer,
  maxMarks,
  assessmentId,
  onAccept,
}: AiGradeSuggestionProps) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const blank = !studentAnswer.trim();

  // Probe once: if the server has no AI provider configured, show the
  // disabled state up front. A probe failure is ignored on purpose — the
  // Suggest click will surface the real error instead of disabling a
  // working button.
  useEffect(() => {
    let cancelled = false;
    void getAiGradingStatus({ data: {} })
      .then((res) => {
        if (!cancelled && !res.configured) setPhase({ kind: "needsKey" });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // Probe once per answer card (keyed by answerId upstream).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSuggest() {
    setPhase({ kind: "loading" });
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token ?? "";
      const result = await suggestGrade({
        data: {
          questionPrompt,
          rubric,
          acceptedAlternatives,
          studentAnswer,
          maxMarks,
          assessmentId,
          accessToken,
        },
      });
      if (!result.ok) {
        if (result.code === "AI_NOT_CONFIGURED") {
          setPhase({ kind: "needsKey" });
        } else if (result.code === "UNAUTHORIZED") {
          setPhase({ kind: "error", message: t("aiGradeUnauthorized") });
        } else {
          setPhase({ kind: "error", message: t("aiGradeFailed") });
        }
        return;
      }
      setPhase({ kind: "suggested", suggestion: result.suggestion });
    } catch {
      setPhase({ kind: "error", message: t("aiGradeFailed") });
    }
  }

  function handleAccept(suggestion: ServerSuggestion) {
    onAccept({ score: suggestion.suggestedScore, feedback: suggestion.feedback });
    setPhase({ kind: "accepted" });
    void logTrainingPair(
      suggestion.suggestedScore,
      suggestion.feedback,
      suggestion.suggestedScore,
      suggestion.feedback,
    );
  }

  function handleApplyEdit() {
    if (phase.kind !== "editing") return;
    const n = Number(phase.score);
    if (Number.isNaN(n) || n < 0 || n > maxMarks) return;
    onAccept({ score: Math.round(n * 100) / 100, feedback: phase.feedback });
    setPhase({ kind: "accepted" });
    void logTrainingPair(
      phase.suggestion.suggestedScore,
      phase.suggestion.feedback,
      Math.round(n * 100) / 100,
      phase.feedback,
    );
  }

  /**
   * Best-effort training-data logging: one anonymized row pairing the AI
   * suggestion with the teacher's final values, for a future fine-tuning
   * phase (see logAiTrainingExample in src/server/ai-grade.ts). Fires on
   * Accept and on applying an Edit — never on Reject. Failures are
   * swallowed on purpose: logging must never block grading.
   */
  async function logTrainingPair(
    aiScore: number,
    aiFeedback: string,
    finalScore: number,
    finalFeedback: string,
  ) {
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token ?? "";
      if (!accessToken) return;
      await logAiTrainingExample({
        data: {
          questionPrompt,
          rubric,
          studentAnswer,
          aiSuggestedScore: aiScore,
          aiFeedback,
          teacherFinalScore: finalScore,
          teacherFeedback: finalFeedback,
          maxMarks,
          assessmentId,
          accessToken,
        },
      });
    } catch {
      // Ignored by design.
    }
  }

  if (phase.kind === "needsKey") {
    return (
      <div className="space-y-2">
        <Button variant="outline" disabled title={t("aiGradeNeedsKey")}>
          {t("aiSuggest")}
        </Button>
        <p className="text-xs text-muted-foreground">{t("aiGradeNeedsKey")}</p>
      </div>
    );
  }

  if (phase.kind === "suggested" || phase.kind === "editing") {
    const s = phase.suggestion;
    const confidenceKey =
      s.confidence === "high"
        ? "aiGradeConfidenceHigh"
        : s.confidence === "low"
          ? "aiGradeConfidenceLow"
          : "aiGradeConfidenceMedium";
    if (phase.kind === "editing") {
      const invalid =
        phase.score.trim() === "" ||
        Number.isNaN(Number(phase.score)) ||
        Number(phase.score) < 0 ||
        Number(phase.score) > maxMarks;
      return (
        <div className="space-y-2 rounded-md border p-3">
          <p className="text-sm font-medium">{t("aiGradeSuggestedScore")}</p>
          <Input
            type="number"
            min={0}
            max={maxMarks}
            step="any"
            value={phase.score}
            onChange={(e) =>
              setPhase({ ...phase, score: e.target.value })
            }
            aria-label={t("score")}
          />
          <Textarea
            value={phase.feedback}
            onChange={(e) => setPhase({ ...phase, feedback: e.target.value })}
            aria-label={t("feedback")}
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={invalid} onClick={handleApplyEdit}>
              {t("useSuggestion")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setPhase({ kind: "suggested", suggestion: s })}
            >
              {t("cancel")}
            </Button>
          </div>
        </div>
      );
    }
    return (
      <div className="space-y-2 rounded-md border p-3">
        <p className="text-sm font-medium">
          {t("aiSuggestion")} · {t("aiGradeSuggestedScore")}: {formatScore(s.suggestedScore)} /{" "}
          {formatScore(maxMarks)} · {t(confidenceKey)}
        </p>
        <p className="text-sm text-muted-foreground" dir="auto">
          {s.feedback || t("aiGradeEmptyAnswer")}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => handleAccept(s)}>
            {t("approve")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setPhase({
                kind: "editing",
                suggestion: s,
                score: String(s.suggestedScore),
                feedback: s.feedback,
              })
            }
          >
            {t("edit")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setPhase({ kind: "idle" })}>
            {t("reject")}
          </Button>
        </div>
      </div>
    );
  }

  if (phase.kind === "accepted") {
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">{t("aiGradeApplied")}</p>
        <Button size="sm" variant="outline" onClick={() => setPhase({ kind: "idle" })}>
          {t("aiSuggest")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Button
        variant="outline"
        disabled={phase.kind === "loading" || blank}
        title={blank ? t("aiGradeEmptyAnswer") : undefined}
        onClick={handleSuggest}
      >
        {phase.kind === "loading" ? t("aiWorking") : t("aiSuggest")}
      </Button>
      {phase.kind === "error" && (
        <p className="text-xs text-destructive">{phase.message}</p>
      )}
    </div>
  );
}

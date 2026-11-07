import { useQuery } from "@tanstack/react-query";
import { listReportQuestionsD1 } from "@/server/d1-report";
import { useI18n } from "@/lib/i18n";
import { Panel, Pill, Empty } from "@/components/ui-kit";

/**
 * Per-question breakdown for the assessment report.
 *
 * SELF-CONTAINED, REMOVABLE SLICE — the report page imports only this
 * component, so deleting that import + JSX block removes this whole
 * feature. Nothing else in the report page references this file.
 *
 * Reads the EXISTING `answers` table (response / max_marks / auto_score /
 * final_score / review_status) written by the take page and the grading
 * page. Effective score = final_score ?? auto_score (teacher-final-word).
 *
 * DEFINITIONS (stated so the numbers are unambiguous):
 * - Effective score per answer = final_score ?? auto_score.
 * - "Answered" = rows present for that question. "Graded" = answers
 *   with a non-null effective score. Averages use graded answers only.
 * - "Full credit" = graded answers whose effective score >= the
 *   question's marks (questions.marks, verified on main HEAD).
 * - Success rate shown = full-credit share of GRADED answers, plus the
 *   average score %; ungraded answers never count as failures.
 */
type QuestionRow = {
  id: string;
  position: number;
  type: string;
  prompt: string;
  marks: number;
};

type AnswerRow = {
  question_id: string;
  auto_score: number | null;
  final_score: number | null;
};

function formatPct(value: number | null, lang: "ar" | "en"): string {
  if (value === null) return "—";
  return (
    new Intl.NumberFormat(lang === "ar" ? "ar-EG" : "en-GB", {
      maximumFractionDigits: 1,
    }).format(value) + "%"
  );
}

export function AssessmentReportQuestions({ assessmentId }: { assessmentId: string }) {
  const { t, lang } = useI18n();

  // D1 (Phase 2b): one owner-checked server call. It returns questions
  // + answers for the caller's own assessment only — question_keys is
  // never selected. An empty-submissions assessment yields empty
  // answers, which renders the same "no submissions" state as before.
  const dataQuery = useQuery({
    queryKey: ["assessment-report-questions", assessmentId],
    queryFn: async () => {
      const data = await listReportQuestionsD1({ data: { assessmentId } });
      return {
        questions: data.questions.map((q): QuestionRow => ({
          id: q.id,
          position: q.position,
          type: q.type,
          prompt: q.prompt,
          marks: q.marks,
        })),
        answers: data.answers as AnswerRow[],
        hasSubmissions: data.submissionCount > 0,
      };
    },
  });

  if (dataQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">{t("loading")}</p>;
  }
  if (dataQuery.isError) {
    return <Empty>{t("errorGeneric")}</Empty>;
  }
  if (!dataQuery.data?.hasSubmissions) {
    return <Empty>{t("reportNoSubmissions")}</Empty>;
  }

  const questions = dataQuery.data?.questions ?? [];
  const answers = dataQuery.data?.answers ?? [];
  if (questions.length === 0) {
    return <Empty>{t("reportNoQuestions")}</Empty>;
  }

  const rows = questions.map((q, index) => {
    const marks = Number(q.marks) || 0;
    const qAnswers = answers.filter((a) => a.question_id === q.id);
    const graded = qAnswers
      .map((a) => a.final_score ?? a.auto_score)
      .filter((s): s is number => s !== null);
    const avgPct =
      graded.length > 0 && marks > 0
        ? graded.reduce((sum, s) => sum + (Number(s) / marks) * 100, 0) / graded.length
        : null;
    const fullCreditPct =
      graded.length > 0
        ? (graded.filter((s) => Number(s) >= marks).length / graded.length) * 100
        : null;
    return {
      q,
      index,
      answered: qAnswers.length,
      gradedCount: graded.length,
      avgPct,
      fullCreditPct,
    };
  });

  return (
    <Panel>
      <h2 className="mb-4 text-lg font-bold">{t("reportPerQuestion")}</h2>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b text-start text-muted-foreground">
              <th className="py-2 pe-3 text-start font-medium">{t("reportQuestion")}</th>
              <th className="py-2 pe-3 text-start font-medium">{t("reportAnswered")}</th>
              <th className="py-2 pe-3 text-start font-medium">{t("reportGraded")}</th>
              <th className="py-2 pe-3 text-start font-medium">{t("reportAvgScore")}</th>
              <th className="py-2 text-start font-medium">{t("reportFullCredit")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ q, index, answered, gradedCount, avgPct, fullCreditPct }) => (
              <tr key={q.id} className="border-b last:border-0">
                <td className="py-3 pe-3">
                  <span className="me-2 text-muted-foreground">{index + 1}.</span>
                  <span className="line-clamp-2">{q.prompt || "—"}</span>
                  <span className="mt-1 block">
                    <Pill>{t(`q_${q.type}` as never)}</Pill>
                    <span className="ms-2 text-xs text-muted-foreground">
                      {t("marks")}: {marksDisplay(q.marks)}
                    </span>
                  </span>
                </td>
                <td className="py-3 pe-3">{answered}</td>
                <td className="py-3 pe-3">{gradedCount}</td>
                <td className="py-3 pe-3">{formatPct(avgPct, lang)}</td>
                <td className="py-3">
                  {formatPct(fullCreditPct, lang)}
                  {fullCreditPct !== null ? (
                    <span className="mt-1 block h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                      <span
                        className="block h-full rounded-full bg-primary"
                        style={{ width: `${Math.min(100, Math.max(0, fullCreditPct))}%` }}
                      />
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function marksDisplay(marks: number): string {
  return String(Number(marks) || 0);
}

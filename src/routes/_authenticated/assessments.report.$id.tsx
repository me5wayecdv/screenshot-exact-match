import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { getAssessmentReportD1, listReportQuestionsD1 } from "@/server/d1-report";
import { useI18n, formatDate, translateError } from "@/lib/i18n";
import { useMe } from "@/lib/session";
import { PageHeader, Panel, Pill, Empty, statusTone } from "@/components/ui-kit";
import { AssessmentReportQuestions } from "@/components/assessment-report-questions";
import { IntegritySummary } from "@/components/integrity-summary";
import { WhatsAppReportSection } from "@/components/whatsapp-report-section";
import { gradesToCsv, questionsToCsv } from "@/lib/lms-export";
import { latestSubmittedPerStudent } from "@/lib/exam-attempt";

/**
 * Per-assessment report — available to teachers and tutors; the D1
 * server functions limit assessment and result reads to the
 * assessment owner (teacher_id = caller in SQL, admins exempt).
 *
 * Stats use only assessments / assessment_assignments / submissions.
 * The per-question breakdown (<AssessmentReportQuestions />) reads the
 * EXISTING `answers` table; deleting that import + JSX block removes
 * only the breakdown, the stats above keep working.
 *
 * SHARING: the owner reads everything. There is no colleague access:
 * only the assessment's own teacher can open this page, and the
 * WhatsApp send section is owner-only by the same rule.
 * A non-owner still gets "not found" (the server throws NOT_FOUND,
 * which this page maps to null below, never to a distinguishable
 * forbidden state).
 */
export const Route = createFileRoute("/_authenticated/assessments/report/$id")({
  component: AssessmentReportPage,
});

type SubmissionRow = {
  id: string;
  student_id: string;
  status: string;
  final_score: number | null;
  total_possible: number | null;
  attempt_number: number;
};

function pct(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return (numerator / denominator) * 100;
}

function formatPct(value: number | null, lang: "ar" | "en"): string {
  if (value === null) return "—";
  return (
    new Intl.NumberFormat(lang === "ar" ? "ar-EG" : "en-GB", {
      maximumFractionDigits: 1,
    }).format(value) + "%"
  );
}

function AssessmentReportPage() {
  const { id } = Route.useParams();
  const { t, lang } = useI18n();
  const { data: me, isLoading: meLoading } = useMe();

  // Legacy `teacher` rows map to `school_teacher` in useMe; include tutors
  // because they own assessments and have the same owner-scoped result access.
  const role = me?.role as string | undefined;
  const isTeacher = role === "teacher" || role === "school_teacher" || role === "tutor";

  // D1 (Phase 2b): one owner-checked server call returns the
  // assessment, its assignments, its submissions, and student names.
  // A NOT_FOUND from the server (missing assessment OR another
  // teacher's) maps to null here, so the page shows "not found" —
  // never a distinguishable forbidden state. Transport errors still
  // surface via isError.
  const assessmentQuery = useQuery({
    queryKey: ["assessment-report", id],
    enabled: !!me && isTeacher,
    queryFn: async () => {
      try {
        return await getAssessmentReportD1({ data: { assessmentId: id } });
      } catch (e) {
        if (e instanceof Error && e.message.includes("NOT_FOUND")) return null;
        throw e;
      }
    },
  });

  const report = assessmentQuery.data ?? null;
  const assessment = report?.assessment ?? null;
  // Ownership is enforced server-side (teacher_id = caller in SQL);
  // the page no longer re-derives it from a client-visible row.
  const isOwner = !!assessment;
  const canView = isOwner;

  // Stats are derived synchronously from the single report payload
  // (same shape as the old stats query: assignments, submissions,
  // names). No second round-trip.
  const statsQuery = {
    data: report
      ? {
          assignments: report.assignments,
          submissions: report.submissions as SubmissionRow[],
          names: report.names,
        }
      : undefined,
    isLoading: assessmentQuery.isLoading,
    isError: false,
  };

  if (meLoading || assessmentQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">{t("loading")}</p>;
  }

  if (!me || !isTeacher) {
    return <Empty>{t("reportAccessDenied")}</Empty>;
  }

  if (assessmentQuery.isError) {
    return <Empty>{t("errorGeneric")}</Empty>;
  }

  if (!assessment) {
    return <Empty>{t("notFound")}</Empty>;
  }

  if (!canView) {
    return <Empty>{t("reportAccessDenied")}</Empty>;
  }

  const assignments = statsQuery.data?.assignments ?? [];
  const submissions = statsQuery.data?.submissions ?? [];
  const names = statsQuery.data?.names ?? {};
  const assignedCount = assignments.length;
  // §6: stats count each student once, on their latest submitted attempt.
  // Drafts never count, and an older released attempt must not double-count
  // once a newer attempt exists. The integrity list below still shows every
  // attempt, since each attempt has its own integrity events.
  const statsRows = latestSubmittedPerStudent(submissions);
  const submittedCount = statsRows.length;
  const participation = pct(submittedCount, assignedCount);
  const ungradedCount = statsRows.filter((s) => s.status === "awaiting_review").length;
  const released = statsRows.filter(
    (s) => s.status === "released" && s.final_score !== null && Number(s.total_possible) > 0,
  );
  const averageReleasedPct =
    released.length > 0
      ? released.reduce(
          (sum, s) => sum + (Number(s.final_score) / Number(s.total_possible)) * 100,
          0,
        ) / released.length
      : null;

  function downloadCsv(filename: string, csv: string) {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // LMS export (Phase 7): questions WITHOUT keys, and released grades.
  // The D1 server function is owner-checked, so a colleague exports
  // nothing from someone else's assessment (NOT_FOUND, not data).
  async function exportQuestions() {
    try {
      const data = await listReportQuestionsD1({ data: { assessmentId: id } });
      downloadCsv(
        `${assessment?.title ?? "assessment"}-questions.csv`,
        questionsToCsv(
          data.questions.map((q) => ({
            prompt: q.prompt,
            type: q.type,
            options: q.options,
            objective: q.objective ?? "",
            marks: Number(q.marks),
            difficulty: q.difficulty ?? "medium",
          })),
        ),
      );
    } catch (error) {
      toast.error(translateError(error, lang));
    }
  }

  function exportGrades() {
    downloadCsv(
      `${assessment?.title ?? "assessment"}-grades.csv`,
      gradesToCsv(
        statsRows.map((s) => ({
          studentName: names[s.student_id] ?? "—",
          assessmentTitle: assessment?.title ?? "",
          finalScore: s.final_score,
          totalPossible: s.total_possible,
          status: s.status,
        })),
      ),
    );
  }

  return (
    <div>
      <PageHeader
        title={assessment.title}
        subtitle={
          <>
            <Pill t={statusTone[assessment.status] ?? "neutral"}>
              {t(`st_${assessment.status}` as never)}
            </Pill>
            {assessment.due_at ? (
              <span className="ms-3">
                {t("dueAt")}: {formatDate(assessment.due_at, lang)}
              </span>
            ) : null}
          </>
        }
        actions={
          <Link
            to="/assessments"
            className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent"
          >
            {t("back")}
          </Link>
        }
      />

      {statsQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">{t("loading")}</p>
      ) : statsQuery.isError ? (
        <Empty>{t("errorGeneric")}</Empty>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Panel>
              <p className="text-sm text-muted-foreground">{t("reportAssigned")}</p>
              <p className="mt-1 text-3xl font-bold">{assignedCount}</p>
            </Panel>
            <Panel>
              <p className="text-sm text-muted-foreground">{t("reportSubmitted")}</p>
              <p className="mt-1 text-3xl font-bold">{submittedCount}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("reportParticipation")}: {formatPct(participation, lang)}
              </p>
            </Panel>
            <Panel>
              <p className="text-sm text-muted-foreground">{t("reportAverageReleased")}</p>
              <p className="mt-1 text-3xl font-bold">{formatPct(averageReleasedPct, lang)}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("reportReleased")}: {released.length}
              </p>
            </Panel>
            <Panel>
              <p className="text-sm text-muted-foreground">{t("reportUngraded")}</p>
              <p className="mt-1 text-3xl font-bold">{ungradedCount}</p>
            </Panel>
          </div>

          {submissions.length === 0 ? (
            <div className="mt-6">
              <Empty>{t("reportNoSubmissions")}</Empty>
            </div>
          ) : null}

          {submissions.length > 0 && (
            <div className="mt-8 space-y-4">
              <h2 className="text-lg font-semibold">{t("integrityReportHeading")}</h2>
              {submissions.map((s) => (
                <IntegritySummary
                  key={s.id}
                  submissionId={s.id}
                  assessmentId={id}
                  title={names[s.student_id] ?? t("student_")}
                />
              ))}
            </div>
          )}

          {/* Per-question breakdown from the answers table. Removing
              this block (plus the import at the top) drops only the
              breakdown; the stats above keep working. */}
          <div className="mt-8">
            <AssessmentReportQuestions assessmentId={id} />
          </div>
          {/* WhatsApp parent sends, one row per RELEASED submission.
              `released` is already computed above (status === "released"
              with a non-null score); the section renders nothing when
              it is empty. Owner-only: colleagues never send on
              someone else's assessment. */}
          {isOwner && <WhatsAppReportSection submissions={released} />}

          <div className="mt-8">
            <Panel>
              <h2 className="mb-4 text-lg font-bold">{t("reportExport")}</h2>
              <p className="mb-3 text-sm text-muted-foreground">{t("reportExportNote")}</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent"
                  onClick={() => void exportQuestions()}
                >
                  {t("reportExportQuestions")}
                </button>
                <button
                  type="button"
                  className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent"
                  onClick={exportGrades}
                >
                  {t("reportExportGrades")}
                </button>
              </div>
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}

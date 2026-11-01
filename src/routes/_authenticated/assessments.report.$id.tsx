import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useI18n, formatDate, translateError } from "@/lib/i18n";
import { useMe } from "@/lib/session";
import { PageHeader, Panel, Pill, Empty, statusTone } from "@/components/ui-kit";
import { AssessmentReportQuestions } from "@/components/assessment-report-questions";
import { IntegritySummary } from "@/components/integrity-summary";
import { WhatsAppReportSection } from "@/components/whatsapp-report-section";
import { gradesToCsv, questionsToCsv } from "@/lib/lms-export";
import { latestSubmittedPerStudent } from "@/lib/exam-attempt";

/**
 * Per-assessment report — available to teachers and tutors; RLS limits
 * assessment and result reads to the assessment owner.
 *
 * Stats use only assessments / assessment_assignments / submissions.
 * The per-question breakdown (<AssessmentReportQuestions />) reads the
 * EXISTING `answers` table; deleting that import + JSX block removes
 * only the breakdown, the stats above keep working.
 *
 * SHARING: the owner reads everything. There is no colleague access:
 * only the assessment's own teacher can open this page, and the
 * WhatsApp send section is owner-only by the same rule.
 * A non-owner still gets "not found".
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

  const assessmentQuery = useQuery({
    queryKey: ["assessment-report", id],
    enabled: !!me && isTeacher,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("assessments")
        .select("id, title, status, due_at, teacher_id")
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const assessment = assessmentQuery.data ?? null;
  // Ownership: RLS restricts the assessment read to the teacher's own
  // rows, and page access mirrors that rule client-side.
  const isOwner = !assessment || assessment.teacher_id === me?.id;
  const canView = isOwner;

  const statsQuery = useQuery({
    queryKey: ["assessment-report-stats", id],
    enabled: !!assessment && canView,
    queryFn: async () => {
      const [
        { data: assignments, error: assignmentsError },
        { data: submissions, error: submissionsError },
      ] = await Promise.all([
        supabase.from("assessment_assignments").select("student_id").eq("assessment_id", id),
        supabase
          .from("submissions")
          .select("id, student_id, status, final_score, total_possible, attempt_number")
          .eq("assessment_id", id),
      ]);
      if (assignmentsError) throw assignmentsError;
      if (submissionsError) throw submissionsError;
      const studentIds = [...new Set((submissions ?? []).map((s) => s.student_id))];
      let names: Record<string, string> = {};
      if (studentIds.length > 0) {
        const { data: profiles } = await supabase
          .from("profiles")
          .select("id, full_name")
          .in("id", studentIds);
        names = Object.fromEntries((profiles ?? []).map((p) => [p.id, p.full_name || "—"]));
      }
      return {
        assignments: assignments ?? [],
        submissions: (submissions ?? []) as SubmissionRow[],
        names,
      };
    },
  });

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
  // Both fetch through RLS, so a colleague exports only what they can read.
  async function exportQuestions() {
    const { data, error } = await supabase
      .from("questions")
      .select("prompt, type, options, objective, marks, difficulty")
      .eq("assessment_id", id)
      .order("position");
    if (error) {
      toast.error(translateError(error, lang));
      return;
    }
    downloadCsv(
      `${assessment?.title ?? "assessment"}-questions.csv`,
      questionsToCsv(
        (data ?? []).map((q) => ({
          prompt: q.prompt,
          type: q.type,
          options: Array.isArray(q.options) ? (q.options as string[]) : [],
          objective: q.objective ?? "",
          marks: Number(q.marks),
          difficulty: q.difficulty ?? "medium",
        })),
      ),
    );
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

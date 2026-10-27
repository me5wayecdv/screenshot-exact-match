import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useI18n, formatDate } from "@/lib/i18n";
import { useMe } from "@/lib/session";
import { PageHeader, Panel, Empty } from "@/components/ui-kit";
import { formatAuditDetails } from "@/lib/audit-format";

export const Route = createFileRoute("/_authenticated/audit")({
  component: AuditPage,
});

type AuditRow = {
  id: number;
  action: string;
  entity_id: string | null;
  details: unknown;
  created_at: string;
};

function AuditPage() {
  const { t, lang } = useI18n();
  const { data: me } = useMe();
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["audit-log", me?.id],
    queryFn: async () => {
      if (!me) return [];
      const { data, error } = await supabase
        .from("audit_log")
        .select("id, action, entity_id, details, created_at")
        .eq("actor_id", me.id)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as AuditRow[];
    },
    enabled: !!me,
  });

  if (!me) return null;
  if (me.role === "student") return <Empty>{t("auditTeacherOnly")}</Empty>;

  const actionLabels: Record<string, string> = {
    review_answer: t("auditActionReviewAnswer"),
    release: t("auditActionRelease"),
    assessment_status: t("auditActionAssessmentStatus"),
    ai_suggestion: t("auditActionAiSuggestion"),
    handwritten_grade: t("auditActionHandwrittenGrade"),
    handwritten_grade_deleted: t("auditActionHandwrittenGradeDeleted"),
  };
  const detailLabels: Record<string, string> = {
    decision: t("auditDecision"),
    score: t("auditScore"),
    previous_final: t("auditPrevious"),
    ai_score: t("auditAiScore"),
    from: t("auditFrom"),
    to: t("auditTo"),
    final_score: t("auditFinalScore"),
    max_marks: t("auditMaxMarks"),
    assessment_id: t("auditAssessment"),
    question_id: t("auditQuestion"),
  };

  return (
    <>
      <PageHeader title={t("auditHistory")} subtitle={t("auditSubtitle")} />
      <Panel>
        {!isLoading && rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("auditEmpty")}</p>
        ) : (
          <ul className="space-y-4">
            {rows.map((row) => (
              <li key={row.id} className="border-b pb-4 last:border-0 last:pb-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-semibold">{actionLabels[row.action] ?? row.action}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatDate(row.created_at, lang)}
                  </span>
                </div>
                {row.entity_id && (
                  <p className="mt-1 text-xs text-muted-foreground" dir="ltr">
                    {row.entity_id}
                  </p>
                )}
                <dl className="mt-2 space-y-1 text-sm">
                  {formatAuditDetails(row.details, detailLabels).map((line) => (
                    <div key={line.label} className="flex gap-2">
                      <dt className="text-muted-foreground">{line.label}:</dt>
                      <dd className="break-all">{line.value}</dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}

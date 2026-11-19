import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  ClipboardCheck,
  FileQuestion,
  GraduationCap,
  MessageSquareText,
  TrendingUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty, PageHeader, Panel } from "@/components/ui-kit";
import { useI18n } from "@/lib/i18n";
import { useMe } from "@/lib/session";
import { getTeacherAssistantOverview } from "@/server/teacher-assistant";

export const Route = createFileRoute("/_authenticated/assistant")({
  head: () => ({
    meta: [
      { title: "Teacher assistant · Qayyimni" },
      {
        name: "description",
        content: "A practical assistant for lesson planning and assessment review.",
      },
    ],
  }),
  component: TeacherAssistantPage,
});

function TeacherAssistantPage() {
  const { t } = useI18n();
  const { data: me, isLoading: meLoading } = useMe();
  const teacher = me?.role === "school_teacher" || me?.role === "tutor";

  const overview = useQuery({
    queryKey: ["teacher-assistant-overview", me?.id],
    enabled: !!me && teacher,
    queryFn: () => getTeacherAssistantOverview({ data: {} }),
    staleTime: 60_000,
  });

  if (meLoading) return <p className="text-muted-foreground">{t("loading")}</p>;
  if (!me || !teacher) return <Empty>{t("assistantTeacherOnly")}</Empty>;

  const overviewData = overview.data?.ok ? overview.data : null;
  const configured = overviewData?.configured ?? false;
  const summary = overviewData?.summary;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={t("assistantTitle")}
        subtitle={t("assistantSubtitle")}
        actions={
          <>
            <Button asChild variant="outline">
              <Link to="/assessments/generate">
                <FileQuestion aria-hidden />
                {t("assistantBuildAssessment")}
              </Link>
            </Button>
            <Button asChild>
              <Link to="/grading">
                <ClipboardCheck aria-hidden />
                {t("assistantOpenGrading")}
              </Link>
            </Button>
          </>
        }
      />

      <section
        aria-label={t("assistantWorkspaceSummary")}
        className="mb-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-5"
      >
        {[
          { label: t("assistantAssessments"), value: summary?.assessments },
          { label: t("assistantDrafts"), value: summary?.drafts },
          { label: t("assistantPending"), value: summary?.pendingReviews },
          { label: t("assistantReleased"), value: summary?.releasedResults },
          {
            label: t("assistantAverageReleased"),
            value: summary
              ? summary.averageReleasedPercent === null
                ? "—"
                : `${summary.averageReleasedPercent}%`
              : undefined,
          },
        ].map((card) => (
          <Panel key={card.label} className="p-4">
            <p className="text-xs text-muted-foreground">{card.label}</p>
            <p className="mt-2 font-display text-2xl font-bold text-primary">
              {overview.isLoading ? "—" : (card.value ?? "—")}
            </p>
          </Panel>
        ))}
      </section>
      <p className="mb-5 text-xs leading-5 text-muted-foreground">{t("assistantAveragePrivacy")}</p>

      {overviewData && !configured && (
        <div
          role="status"
          className="mb-5 rounded-md border border-warning/50 bg-warning/15 p-4 text-sm leading-6 text-warning-foreground"
        >
          {t("assistantNotConfigured")}
        </div>
      )}
      {overview.data && !overview.data.ok && overview.data.code === "UNAUTHORIZED" ? (
        <div
          role="status"
          className="mb-5 rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive"
        >
          {t("assistantTeacherOnly")}
        </div>
      ) : null}
      {overview.isError ||
      (overview.data && !overview.data.ok && overview.data.code === "DB_ERROR") ? (
        <div
          role="status"
          className="mb-5 rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive"
        >
          {t("assistantDataError")}
        </div>
      ) : null}

      <div className="grid items-start gap-5 sm:grid-cols-2">
        <Panel>
          <div className="flex items-center gap-2">
            <GraduationCap className="size-4 text-primary" aria-hidden />
            <h2 className="font-semibold">{t("assistantTools")}</h2>
          </div>
          <div className="mt-4 space-y-2">
            <Link to="/assessments/generate" className="assistant-tool-link">
              <FileQuestion className="size-4" aria-hidden />
              <span>{t("assistantBuildAssessment")}</span>
            </Link>
            <Link to="/grading" className="assistant-tool-link">
              <MessageSquareText className="size-4" aria-hidden />
              <span>{t("assistantOpenGrading")}</span>
            </Link>
            <Link to="/analytics" className="assistant-tool-link">
              <TrendingUp className="size-4" aria-hidden />
              <span>{t("assistantOpenAnalytics")}</span>
            </Link>
          </div>
        </Panel>
        <Panel className="border-dashed bg-transparent shadow-none">
          <p className="text-sm font-semibold">{t("assistantReminderTitle")}</p>
          <p className="mt-2 text-xs leading-6 text-muted-foreground">
            {t("assistantReminderBody")}
          </p>
        </Panel>
      </div>
    </div>
  );
}

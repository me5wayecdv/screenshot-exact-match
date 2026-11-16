import { Link } from "@tanstack/react-router";
import type { StudentNextStep } from "@/lib/student-next-step";
import { useI18n } from "@/lib/i18n";
import { Hero } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";

export function StudentNextStepHero({
  step,
  waitingName,
}: {
  step: StudentNextStep;
  waitingName?: string | undefined;
}) {
  const { t } = useI18n();
  const kind = step.kind;
  const assessment = step.assessment;
  const body =
    kind === "loading"
      ? t("loading")
      : kind === "error"
        ? t("assessmentsLoadFailed")
        : kind === "in_progress"
          ? t("heroStudentActive", { title: assessment!.title })
          : kind === "available"
            ? t("heroStudentAvailable", { title: assessment!.title })
            : kind === "awaiting_review"
              ? t("heroStudentReview", { title: assessment!.title })
              : kind === "released"
                ? t("heroStudentReleased", { title: assessment!.title })
                : kind === "assigned"
                  ? t("heroStudentAssigned")
                  : kind === "pending"
                    ? waitingName
                      ? t("waitingApprovalBody", { name: waitingName })
                      : t("waitingApprovalBodyNoName")
                    : kind === "join"
                      ? t("noTeacherLinked")
                      : t("heroStudentIdle");
  const canTake = kind === "available" || kind === "in_progress";
  const showAssignments = ["awaiting_review", "released", "assigned", "idle", "error"].includes(
    kind,
  );
  return (
    <Hero
      kicker={t("heroKicker")}
      title={kind === "pending" ? t("waitingApprovalTitle") : t("studentHomeTitle")}
      body={body}
      actions={
        canTake && assessment ? (
          <Button asChild size="lg" className="lift">
            <Link to="/assessments/take/$id" params={{ id: assessment.id }}>
              {t(kind === "in_progress" ? "continueAttempt" : "startAssessment")}
            </Link>
          </Button>
        ) : showAssignments ? (
          <Button asChild size="lg" className="lift" variant="secondary">
            <a href="#student-assessments">{t("myAssessments")}</a>
          </Button>
        ) : kind === "join" ? (
          <Button asChild size="lg" className="lift" variant="secondary">
            <a href="#join">{t("joinTeacher")}</a>
          </Button>
        ) : undefined
      }
      hint={canTake ? t("heroStudentHint") : undefined}
    />
  );
}

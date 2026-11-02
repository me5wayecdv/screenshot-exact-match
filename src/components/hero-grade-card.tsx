import { Check, ClipboardCheck, FileText, PenLine } from "lucide-react";
import { useI18n } from "@/lib/i18n";

/**
 * A small, invented classroom example for the landing page—not sample student data.
 * It shows the real review workflow: response, rubric, suggested mark, then
 * teacher approval. No auto-grading claim or decorative AI glow.
 */
export function HeroGradeCard() {
  const { t } = useI18n();
  const rubric = [
    [t("demoCriterion1"), t("demoCriterion1Score")],
    [t("demoCriterion2"), t("demoCriterion2Score")],
    [t("demoCriterion3"), t("demoCriterion3Score")],
  ];

  return (
    <div className="relative mx-auto w-full max-w-md pb-8">
      {/* A single beam outline behind the card: depth without rotation. */}
      <div className="absolute inset-x-4 top-5 bottom-4 rounded-xl bg-gradient-to-br from-primary/20 via-(--beam-violet)/15 to-accent/25 blur-[2px]" />
      <article className="relative overflow-hidden rounded-lg border bg-card shadow-lift">
        <header className="flex items-center justify-between gap-4 border-b px-5 py-4">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">{t("demoAssessment")}</p>
            <h2 className="mt-1 text-base font-semibold leading-snug text-foreground">
              {t("demoQuestion")}
            </h2>
          </div>
          <span className="shrink-0 rounded border bg-background px-2 py-1 font-display text-xs font-semibold text-muted-foreground">
            {t("demoQuestionNumber")}
          </span>
        </header>

        <section className="px-5 py-4">
          <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
            <FileText className="size-3.5" aria-hidden />
            {t("demoAnswerTitle")}
          </div>
          <p className="mt-2 border-s-2 border-accent ps-3 text-sm leading-7 text-foreground">
            {t("demoAnswerText")}
          </p>
          <span className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-primary">
            <PenLine className="size-3.5" aria-hidden />
            {t("demoEvidence")}
          </span>
        </section>

        <section className="mx-5 overflow-hidden rounded-md border bg-background">
          <div className="flex items-center justify-between border-b bg-muted/60 px-3 py-2 text-xs font-semibold">
            <span>{t("demoRubric")}</span>
            <span className="text-muted-foreground">{t("demoTotal")}</span>
          </div>
          <ul className="divide-y px-3">
            {rubric.map(([criterion, score]) => (
              <li key={criterion} className="flex items-center justify-between gap-3 py-2 text-xs">
                <span className="text-muted-foreground">{criterion}</span>
                <span dir="ltr" className="shrink-0 font-display font-semibold tabular-nums">
                  {score}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="mx-5 mb-5 mt-4 rounded-md border border-dashed border-primary/30 bg-secondary/50 p-3.5">
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-xs font-semibold text-primary">
              <ClipboardCheck className="size-4" aria-hidden />
              {t("demoSuggest")}
            </span>
            <span
              dir="ltr"
              className="rounded border bg-card px-2 py-1 font-display text-sm font-bold text-foreground"
            >
              {t("demoScore")}
            </span>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {t("demoSuggestNote")}
          </p>
        </section>
      </article>

      <div className="animate-stamp absolute -bottom-0 end-4 flex items-center gap-2 rounded-lg border border-accent/60 bg-card/95 px-3.5 py-2 text-foreground shadow-glow backdrop-blur">
        <span className="grid size-5 place-items-center rounded-md bg-gradient-to-br from-primary to-(--beam-violet) text-primary-foreground">
          <Check className="size-3" strokeWidth={3} />
        </span>
        <span className="font-display text-xs font-bold">{t("demoApproved")}</span>
      </div>
    </div>
  );
}

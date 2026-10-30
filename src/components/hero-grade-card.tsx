import { Check, Sparkles } from "lucide-react";
import { useI18n } from "@/lib/i18n";

/**
 * Landing-page illustration of the product promise: the AI suggests a score,
 * the teacher stamps it approved. Purely decorative (no real student data);
 * the answer text is drawn as skeleton lines so it reads in any language.
 */
export function HeroGradeCard() {
  const { t } = useI18n();
  const lines = ["w-full", "w-11/12", "w-full", "w-3/5"];
  return (
    <div className="relative mx-auto w-full max-w-md pb-8" aria-hidden>
      {/* the sheet underneath */}
      <div className="absolute -inset-x-2 top-5 bottom-6 rotate-3 rounded-xl border bg-primary/10" />
      <article className="relative rounded-xl border bg-card p-6 shadow-lift">
        <div className="flex items-center justify-between">
          <span className="rounded-full bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground">
            {t("demoQuestion")}
          </span>
          <span className="flex gap-1">
            <i className="size-2 rounded-full bg-border" />
            <i className="size-2 rounded-full bg-border" />
          </span>
        </div>

        <div className="mt-5 space-y-3">
          {lines.map((w, i) => (
            <div key={i} className={`h-2.5 rounded-full bg-foreground/10 ${w}`} />
          ))}
        </div>

        {/* the suggestion: dashed = not final */}
        <div className="mt-6 rounded-lg border border-dashed border-accent bg-accent-soft p-4">
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-sm font-semibold text-accent-foreground">
              <Sparkles className="size-4" />
              {t("demoSuggest")}
            </span>
            <span className="rounded-md border border-dashed border-accent-foreground/40 px-2 py-0.5 font-display text-sm font-bold text-accent-foreground">
              {t("demoScore")}
            </span>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-accent-foreground/80">
            {t("demoSuggestNote")}
          </p>
        </div>
      </article>

      {/* the teacher's last word: solid saffron, stamped on */}
      <div className="animate-stamp absolute -bottom-0 end-4 flex -rotate-2 items-center gap-2.5 rounded-lg bg-accent px-4 py-2.5 text-accent-foreground shadow-lift">
        <span className="grid size-6 place-items-center rounded-full bg-sidebar text-sidebar-foreground">
          <Check className="size-3.5" strokeWidth={3} />
        </span>
        <span className="font-display text-sm font-bold">{t("demoApproved")}</span>
        <span className="font-display text-lg font-bold">{t("demoScore")}</span>
      </div>
    </div>
  );
}

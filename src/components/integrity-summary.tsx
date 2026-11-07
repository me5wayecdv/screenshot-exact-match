import { useQuery } from "@tanstack/react-query";
import { getIntegritySummaryD1 } from "@/server/d1-report";
import { useI18n } from "@/lib/i18n";
import { Panel, Pill } from "@/components/ui-kit";

/**
 * Per-submission integrity summary for the GRADING and REPORT pages
 * (teacher-only pages). Self-contained: it fetches its own events,
 * per-question times, and (when assessmentId is given) teacher position
 * order so per-question times list in the same order as the grading page.
 *
 * NEUTRAL WORDING ONLY. This component never writes scores, never blocks
 * release, and never accuses: a flag means "worth a look", nothing more.
 * On any read error (including RLS denial) it renders nothing — the
 * summary is supplementary and must never block grading.
 */

/** Flag when tab-switches EXCEED this number (i.e. 4+ switches flag). */
export const SWITCH_FLAG_THRESHOLD = 3;

export type IntegrityEventRow = {
  event_type: string;
  question_id: string | null;
  created_at: string;
};

export interface PerQuestionTime {
  question_id: string;
  seconds: number;
}

export interface IntegritySummaryData {
  tabSwitches: number;
  windowBlurs: number;
  totalTimeSeconds: number;
  perQuestion: PerQuestionTime[];
  hasData: boolean;
}

/** Pure count helper (kept separate for testability). */
export function summarizeIntegrityEvents(events: IntegrityEventRow[]): {
  tabSwitches: number;
  windowBlurs: number;
} {
  return {
    tabSwitches: events.filter((e) => e.event_type === "tab_hidden").length,
    windowBlurs: events.filter((e) => e.event_type === "window_blur").length,
  };
}

/** mm:ss, rendered ltr so it reads the same in RTL and LTR layouts. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function useIntegritySummary(submissionId: string | undefined, assessmentId?: string) {
  return useQuery({
    queryKey: ["integrity-summary", submissionId, assessmentId ?? null],
    enabled: !!submissionId,
    queryFn: async (): Promise<IntegritySummaryData> => {
      // D1 (Phase 2b): the server checks the submission's assessment
      // belongs to the caller before returning anything. Counting and
      // ordering are unchanged (see summarizeIntegrityEvents above and
      // the server's per-question position sort).
      const data = await getIntegritySummaryD1({
        data: { submissionId: submissionId!, assessmentId },
      });
      return {
        tabSwitches: data.tabSwitches,
        windowBlurs: data.windowBlurs,
        totalTimeSeconds: data.totalTimeSeconds,
        perQuestion: data.perQuestion,
        hasData: data.hasData,
      };
    },
  });
}

export function IntegritySummary(props: {
  submissionId: string;
  assessmentId?: string;
  /** Heading override (report page passes the student name). */
  title?: string;
}) {
  const { t, lang } = useI18n();
  const { data, isLoading, isError } = useIntegritySummary(props.submissionId, props.assessmentId);
  if (isLoading) return <p className="text-sm text-muted-foreground">{t("loading")}</p>;
  // Supplementary panel: never block grading/report on a read failure.
  if (isError || !data) return null;

  const flagged = data.tabSwitches > SWITCH_FLAG_THRESHOLD;
  return (
    <Panel className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">{props.title ?? t("integrityTitle")}</h3>
        {flagged && <Pill t="warning">{t("integrityFlagged")}</Pill>}
      </div>
      <p className="text-sm text-muted-foreground">{t("integrityNote")}</p>
      {!data.hasData ? (
        <p className="text-sm text-muted-foreground">{t("integrityNoData")}</p>
      ) : (
        <>
          <dl className="grid gap-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">{t("integrityTabSwitches")}</dt>
              <dd className="font-semibold" dir="ltr">
                {new Intl.NumberFormat(lang === "ar" ? "ar-EG" : "en-GB").format(data.tabSwitches)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("integrityWindowBlurs")}</dt>
              <dd className="font-semibold" dir="ltr">
                {new Intl.NumberFormat(lang === "ar" ? "ar-EG" : "en-GB").format(data.windowBlurs)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("integrityTotalTime")}</dt>
              <dd className="font-semibold" dir="ltr">
                {formatDuration(data.totalTimeSeconds)}
              </dd>
            </div>
          </dl>
          {data.perQuestion.length > 0 && (
            <div className="space-y-1 text-sm">
              <p className="text-muted-foreground">{t("integrityPerQuestionTime")}</p>
              <ul className="space-y-1">
                {data.perQuestion.map((p, i) => (
                  <li key={p.question_id} className="flex items-center justify-between gap-2">
                    <span>
                      {t("question")} {i + 1}
                    </span>
                    <span dir="ltr" className="font-medium">
                      {formatDuration(p.seconds)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

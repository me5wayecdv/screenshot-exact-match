/**
 * WhatsAppReportSection — per-student send rows for the per-assessment
 * report page. Rendered ONLY for released submissions (the caller filters
 * them); each row shows the student, the released score, and a
 * <WhatsAppSendButton /> which carries its own gating hints and the
 * latest audit status from public.whatsapp_sends.
 *
 * Props mirror the report page's existing SubmissionRow shape
 * (id, student_id, status, final_score, total_possible) so the caller
 * can pass its `released` array directly. Student names come from a
 * profiles read (teacher-visible under the existing "read own profile"
 * policy); a missing name renders "—", never a crash.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useI18n } from "@/lib/i18n";
import { Panel } from "@/components/ui-kit";
import { WhatsAppSendButton } from "./whatsapp-send-button";

export type ReportSubmissionRow = {
  id: string;
  student_id: string;
  status: string;
  final_score: number | null;
  total_possible: number | null;
};

export function WhatsAppReportSection({
  submissions,
}: {
  /** Released submissions only (caller filters: status === "released"). */
  submissions: ReportSubmissionRow[];
}) {
  const { t } = useI18n();
  const studentIds = [...new Set(submissions.map((s) => s.student_id))];
  const namesQuery = useQuery({
    queryKey: ["whatsapp-report-names", studentIds.join(",")],
    enabled: studentIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name")
        .in("id", studentIds);
      if (error) throw error;
      return new Map((data ?? []).map((p) => [p.id, p.full_name || "—"]));
    },
  });
  const names = namesQuery.data ?? new Map<string, string>();

  if (submissions.length === 0) return null;

  return (
    <Panel className="mt-8">
      <h2 className="mb-3 font-semibold">{t("whatsappReportTitle")}</h2>
      <p className="mb-4 text-sm text-muted-foreground">{t("whatsappReportHint")}</p>
      <ul className="divide-y">
        {submissions.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <span className="text-sm">
              <span className="font-medium">{names.get(s.student_id) ?? "—"}</span>
              <span className="text-muted-foreground">
                {" "}
                · {t("finalScore")}: {s.final_score ?? "—"}/{s.total_possible ?? "—"}
              </span>
            </span>
            <WhatsAppSendButton submissionId={s.id} studentId={s.student_id} />
          </li>
        ))}
      </ul>
    </Panel>
  );
}

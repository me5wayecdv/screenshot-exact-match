/**
 * WhatsAppSendButton — manual "send result to parent" for ONE released
 * submission. Teacher-final-word: the button is only rendered for
 * released submissions by its callers (grading released list, report
 * section).
 *
 * SENDING STAYS OFF in the pilot (D1 port, Phase 2b): the configured
 * gate always answers false, so this component renders the
 * "WhatsApp not connected" hint and never reaches a send. The gating
 * states below are preserved for when sending is switched on:
 *  1. WhatsApp not configured on the server -> "WhatsApp not connected"
 *     hint, button disabled. (No token is ever exposed to decide this;
 *     the server function answers only true/false.)
 *  2. No parent_phone on the student profile -> hint to add the number.
 *  3. Phone present but whatsapp_consent false -> hint to get consent.
 *  4. Ready -> enabled button. After a send, the latest audit row from
 *     whatsapp_sends is shown (sent / failed + error text).
 *
 * Contact reads are server-checked (self or approved linked teacher);
 * audit reads are owner-checked (the submission's assessment must
 * belong to the caller). No WhatsApp API call exists in this path.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useI18n, translateError } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui-kit";
import {
  getParentContactD1,
  getWhatsAppConfiguredD1,
  listWhatsAppSendsD1,
  sendWhatsAppReportD1,
} from "@/server/d1-report";
import type { WhatsAppSendRow } from "@/lib/whatsapp";

export function WhatsAppSendButton({
  submissionId,
  studentId,
}: {
  submissionId: string;
  studentId: string;
}) {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  const configuredQuery = useQuery({
    queryKey: ["whatsapp-configured"],
    queryFn: async () => getWhatsAppConfiguredD1({ data: {} }),
    staleTime: 60_000,
  });
  const contactQuery = useQuery({
    queryKey: ["whatsapp-contact", studentId],
    queryFn: async () => getParentContactD1({ data: { studentId } }),
  });
  const sendsQuery = useQuery({
    queryKey: ["whatsapp-sends", submissionId],
    queryFn: async () => {
      const rows = await listWhatsAppSendsD1({ data: { submissionId } });
      return rows as unknown as WhatsAppSendRow[];
    },
  });

  const configured = configuredQuery.data?.configured;
  const phone = contactQuery.data?.parent_phone ?? null;
  const consent = contactQuery.data?.whatsapp_consent ?? false;
  const last = sendsQuery.data?.[0] ?? null;

  async function send() {
    setBusy(true);
    try {
      // Sending is OFF in the pilot: the server always answers
      // skipped/not_configured and performs no send. This branch is
      // unreachable while the configured gate above is false; it
      // exists so a stale enabled button can never send.
      const result = await sendWhatsAppReportD1({ data: { submissionId, trigger: "manual" } });
      if (result.status === "skipped") toast.message(t("whatsappSkipped"));
    } catch (e) {
      toast.error(translateError(e, lang));
    } finally {
      setBusy(false);
      await qc.invalidateQueries({ queryKey: ["whatsapp-sends", submissionId] });
    }
  }

  // Loading either gate: render the button disabled rather than flashing
  // a wrong hint for one frame.
  if (configuredQuery.isLoading || contactQuery.isLoading) {
    return (
      <Button variant="outline" size="sm" disabled>
        {t("loading")}
      </Button>
    );
  }

  if (configured === false) {
    return <p className="text-xs text-muted-foreground">{t("whatsappNotConnected")}</p>;
  }
  if (!phone) {
    return <p className="text-xs text-muted-foreground">{t("whatsappNoParentPhone")}</p>;
  }
  if (!consent) {
    return <p className="text-xs text-muted-foreground">{t("whatsappNoConsent")}</p>;
  }

  return (
    <div className="space-y-1.5">
      <Button variant="outline" size="sm" onClick={send} disabled={busy}>
        {busy ? t("saving") : t("whatsappSendToParent")}
      </Button>
      {last ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Pill
            t={last.status === "sent" ? "success" : last.status === "failed" ? "danger" : "neutral"}
          >
            {t(`whatsapp_${last.status}` as never)}
          </Pill>
          {last.error ? (
            <span className="max-w-xs truncate" title={last.error}>
              {last.error}
            </span>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

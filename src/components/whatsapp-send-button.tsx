/**
 * WhatsAppSendButton — manual "send result to parent" for ONE released
 * submission. Teacher-final-word: the button is only rendered for
 * released submissions by its callers (grading released list, report
 * section); the server function re-checks released status anyway.
 *
 * Gating states, in order (never a silent failure):
 *  1. WhatsApp env not set on the server  -> "WhatsApp not connected"
 *     hint, button disabled. (No token is ever exposed to decide this;
 *     the server function answers only true/false.)
 *  2. No parent_phone on the student profile -> hint to add the number.
 *  3. Phone present but whatsapp_consent false -> hint to get consent.
 *  4. Ready -> enabled button. After a send, the latest audit row from
 *     public.whatsapp_sends is shown (sent / failed + error text).
 *
 * A failed send is VISIBLE: the audit row (status + error) is rendered
 * under the button, and the button stays enabled for retry. Manual
 * resends are allowed and each creates a new audit row.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useI18n, translateError } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui-kit";
import { sendWhatsAppReport, getWhatsAppConfigured } from "@/lib/whatsapp.functions";
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
    queryFn: async () => getWhatsAppConfigured(),
    staleTime: 60_000,
  });
  const contactQuery = useQuery({
    queryKey: ["whatsapp-contact", studentId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("parent_phone, whatsapp_consent")
        .eq("id", studentId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
  const sendsQuery = useQuery({
    queryKey: ["whatsapp-sends", submissionId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("whatsapp_sends")
        .select("id, submission_id, sent_at, status, trigger, message_id, error")
        .eq("submission_id", submissionId)
        .order("sent_at", { ascending: false })
        .limit(1);
      if (error) throw error;
      return (data ?? []) as unknown as WhatsAppSendRow[];
    },
  });

  const configured = configuredQuery.data?.configured;
  const phone = contactQuery.data?.parent_phone ?? null;
  const consent = contactQuery.data?.whatsapp_consent ?? false;
  const last = sendsQuery.data?.[0] ?? null;

  async function send() {
    setBusy(true);
    try {
      const result = await sendWhatsAppReport({ data: { submissionId, trigger: "manual" } });
      if (result.ok && result.status === "sent") toast.success(t("whatsappSent"));
      else if (result.ok) toast.message(t("whatsappSkipped"));
      else if (result.status === "not_released") toast.error(t("whatsappNotReleased"));
      else
        toast.error(
          result.error ? translateError(new Error(result.error), lang) : t("errorGeneric"),
        );
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

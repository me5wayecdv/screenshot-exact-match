/**
 * WhatsAppAutoSendToggle — per-assessment auto-send switch.
 *
 * LOCATION DECISION: assessment settings, i.e. the builder's MetaEditor
 * (src/routes/_authenticated/assessments/$id.tsx). The toggle lives next
 * to the other assessment settings (title / subject / due date), NOT on
 * the grading page, because it is a property of the assessment, set once
 * by its owner — the grading page only ever shows the CONSEQUENCE (the
 * auto-send attempt after release + the audit status).
 *
 * Behaviour: default OFF (column default false). When ON, the grading
 * page's release() calls sendWhatsAppReport({ trigger: "auto" }) after a
 * successful release; the server function re-checks the flag, so a stale
 * client can never auto-send for an assessment whose toggle was turned
 * off. When OFF, release sends nothing and shows no WhatsApp UI — the
 * teacher can still send manually from the report page.
 *
 * Writes via the browser Supabase client; the existing "teacher manages
 * assessments" policy (owner + school_teacher/tutor role) already allows
 * the owner to update their own assessment row. No new policy needed.
 */
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useI18n, translateError } from "@/lib/i18n";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

export function WhatsAppAutoSendToggle({
  assessmentId,
  initialValue,
}: {
  assessmentId: string;
  initialValue: boolean;
}) {
  const { t, lang } = useI18n();
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);

  async function toggle(on: boolean) {
    setValue(on);
    setBusy(true);
    const { error } = await supabase
      .from("assessments")
      .update({ auto_whatsapp_send: on })
      .eq("id", assessmentId);
    setBusy(false);
    if (error) {
      setValue(!on);
      return void toast.error(translateError(error, lang));
    }
    toast.success(t("save"));
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Checkbox
          id="wa-auto-send"
          checked={value}
          disabled={busy}
          onCheckedChange={(v) => void toggle(!!v)}
        />
        <Label htmlFor="wa-auto-send">{t("whatsappAutoSend")}</Label>
      </div>
      <p className="text-xs text-muted-foreground">{t("whatsappAutoSendHint")}</p>
    </div>
  );
}

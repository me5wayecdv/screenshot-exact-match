/**
 * ParentContactForm — parent phone (E.164) + WhatsApp consent, on a
 * student profile row. RTL Arabic-first; phone input is dir="ltr".
 *
 * Who may save (enforced by RLS, not by this component):
 * - The student themself: existing "update own profile" policy.
 * - A linked teacher: the NEW "teacher updates linked student parent
 *   contact" policy in this slice's migration (is_teacher_of pattern,
 *   same as the existing "read own profile" policy). The form only ever
 *   sends these two columns.
 *
 * Use it in TWO places (see NOTES.md insertion instructions):
 * - /students (teacher editing a linked student) — pass that student's id
 *   and the profile row's current values.
 * - /dashboard StudentHome (student editing their own contact) — pass
 *   me.id; the coordinator wires the initial values from a profiles
 *   query (useMe does not currently return parent fields).
 *
 * No new route. No token anywhere in this file.
 */
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useI18n, translateError } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { isValidEgyptianMobile, normalizePhoneInput } from "@/lib/whatsapp";

export function ParentContactForm({
  studentId,
  initialPhone,
  initialConsent,
  onSaved,
}: {
  studentId: string;
  initialPhone: string | null;
  initialConsent: boolean;
  onSaved?: () => void;
}) {
  const { t, lang } = useI18n();
  const [phone, setPhone] = useState(initialPhone ?? "");
  const [consent, setConsent] = useState(initialConsent);
  const [busy, setBusy] = useState(false);
  const [formatError, setFormatError] = useState(false);
  const [requiredError, setRequiredError] = useState(false);

  async function save() {
    const cleaned = normalizePhoneInput(phone);
    // Parent phone is REQUIRED (product decision 2026-10-31) and must be
    // an Egyptian mobile: +20 followed by 010/011/012/015. Local forms
    // (01012345678) are normalized by normalizePhoneInput. The DB CHECK
    // constraint enforces the same rule.
    if (cleaned === "") {
      setRequiredError(true);
      setFormatError(false);
      return;
    }
    if (!isValidEgyptianMobile(cleaned)) {
      setFormatError(true);
      setRequiredError(false);
      return;
    }
    setFormatError(false);
    setRequiredError(false);
    setBusy(true);
    const { error } = await supabase
      .from("profiles")
      .update({ parent_phone: cleaned, whatsapp_consent: consent })
      .eq("id", studentId);
    setBusy(false);
    if (error) return void toast.error(translateError(error, lang));
    toast.success(t("save"));
    onSaved?.();
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor={`parent-phone-${studentId}`}>{t("parentPhone")}</Label>
        <Input
          id={`parent-phone-${studentId}`}
          dir="ltr"
          inputMode="tel"
          placeholder="+20…"
          value={phone}
          maxLength={16}
          required
          aria-required="true"
          onChange={(e) => {
            setPhone(e.target.value);
            setFormatError(false);
            setRequiredError(false);
          }}
        />
        {requiredError ? (
          <p className="text-xs text-destructive">{t("parentPhoneRequired")}</p>
        ) : formatError ? (
          <p className="text-xs text-destructive">{t("parentPhoneInvalid")}</p>
        ) : null}
        <p className="text-xs text-muted-foreground">{t("parentPhoneHint")}</p>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id={`wa-consent-${studentId}`}
          checked={consent}
          onCheckedChange={(v) => setConsent(!!v)}
        />
        <label htmlFor={`wa-consent-${studentId}`} className="text-sm">
          {t("whatsappConsent")}
        </label>
      </div>
      <p className="text-xs text-muted-foreground">{t("whatsappConsentHint")}</p>
      <Button onClick={save} disabled={busy}>
        {busy ? t("saving") : t("save")}
      </Button>
    </div>
  );
}

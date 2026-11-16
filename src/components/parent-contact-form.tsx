/**
 * ParentContactForm — parent phone (E.164) + WhatsApp consent, on a
 * student profile row. RTL Arabic-first; phone input is dir="ltr".
 *
 * Who may save (enforced server-side by D1, not by this component):
 * - The student themself.
 * - An approved linked teacher (teacher_students status = 'approved'
 *   — the D1 equivalent of the old "teacher updates linked student
 *   parent contact" policy). The form only ever sends these two
 *   columns, and the server re-validates the phone format.
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
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { updateParentContactD1 } from "@/server/d1-report";
import { useI18n, translateError } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { isValidEgyptianMobile, normalizePhoneInput } from "@/lib/whatsapp";

type ParentContactProps = {
  studentId: string;
  initialPhone: string | null;
  initialConsent: boolean;
  onSaved?: () => void;
};

// A different student is a different draft, even when this form is reused.
export function ParentContactForm(props: ParentContactProps) {
  return <ParentContactEditor key={props.studentId} {...props} />;
}

function ParentContactEditor({
  studentId,
  initialPhone,
  initialConsent,
  onSaved,
}: ParentContactProps) {
  const { t, lang } = useI18n();
  // Null means untouched: late profile data may fill that field. Once
  // edited, each field keeps its own draft until the server echoes it.
  const [phoneDraft, setPhone] = useState<{ value: string; saved: boolean } | null>(null);
  const [consentDraft, setConsent] = useState<{ value: boolean; saved: boolean } | null>(null);
  const phone = phoneDraft?.value ?? initialPhone ?? "";
  const consent = consentDraft?.value ?? initialConsent;
  const [busy, setBusy] = useState(false);
  const [formatError, setFormatError] = useState(false);
  const [requiredError, setRequiredError] = useState(false);

  useEffect(() => {
    if (phoneDraft?.saved && phoneDraft.value === (initialPhone ?? "")) setPhone(null);
    if (consentDraft?.saved && consentDraft.value === initialConsent) setConsent(null);
  }, [phoneDraft, consentDraft, initialPhone, initialConsent]);

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
    try {
      await updateParentContactD1({
        data: { studentId, phone: cleaned, consent },
      });
    } catch (error) {
      setBusy(false);
      return void toast.error(translateError(error, lang));
    }
    // A save may finish after another keystroke. Normalize only the
    // submitted draft, never replace a newer edit with the old response.
    setPhone((current) => (current?.value === phone ? { value: cleaned, saved: true } : current));
    setConsent((current) =>
      current?.value === consent ? { value: consent, saved: true } : current,
    );
    setBusy(false);
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
            setPhone({ value: e.target.value, saved: false });
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
          onCheckedChange={(v) => setConsent({ value: !!v, saved: false })}
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

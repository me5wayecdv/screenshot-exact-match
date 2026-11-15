import { useI18n } from "@/lib/i18n";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

/** Sending is not wired. Never offer a switch that promises a silent send. */
export function WhatsAppAutoSendToggle(_props: { assessmentId: string; initialValue: boolean }) {
  const { t } = useI18n();
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Checkbox id="wa-auto-send" checked={false} disabled />
        <Label htmlFor="wa-auto-send">{t("whatsappAutoSend")}</Label>
      </div>
      <p className="text-xs text-muted-foreground">{t("whatsappNotConnected")}</p>
    </div>
  );
}

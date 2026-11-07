import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { consumePasswordResetD1 } from "@/server/d1-auth-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Brand } from "@/components/Brand";
import { useI18n, translateError } from "@/lib/i18n";

export const Route = createFileRoute("/reset-password")({
  head: () => ({
    meta: [
      { title: "Reset password · Qemmini" },
      { name: "description", content: "Set a new password for your Qemmini account." },
      { property: "og:title", content: "Reset password · Qemmini" },
      { property: "og:description", content: "Set a new password." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ResetPassword,
});

function ResetPassword() {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const search = Route.useSearch() as { token?: string };
  const [token, setToken] = useState(search.token ?? "");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await consumePasswordResetD1({ data: { token: token.trim(), newPassword: pw } });
      toast.success(t("passwordUpdated"));
      navigate({ to: "/auth" });
    } catch (err) {
      toast.error(translateError(err, lang));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm space-y-4 rounded-lg border bg-card p-6 shadow-soft"
      >
        <Brand className="text-primary" />
        <div className="space-y-1.5">
          <Label htmlFor="token">{lang === "ar" ? "رمز الاستعادة" : "Recovery token"}</Label>
          <Input
            id="token"
            dir="ltr"
            required
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={
              lang === "ar" ? "الصقه من رسالة الاستعادة" : "Paste from the recovery message"
            }
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pw">{t("newPassword")}</Label>
          <Input
            id="pw"
            type="password"
            dir="ltr"
            minLength={8}
            required
            value={pw}
            onChange={(e) => setPw(e.target.value)}
          />
        </div>
        <Button className="w-full" disabled={busy}>
          {t("updatePassword")}
        </Button>
        <p className="text-xs leading-5 text-muted-foreground">
          {lang === "ar"
            ? "الرابط صالح لساعة واحدة فقط، ويُستخدم مرة واحدة، وبعد تعيين كلمة السر الجديدة بتتلغي كل الجلسات القديمة."
            : "The link is valid for one hour, single-use, and setting a new password signs out all old sessions."}
        </p>
      </form>
    </div>
  );
}

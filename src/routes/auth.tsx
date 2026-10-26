import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Brand, LangToggle } from "@/components/Brand";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n, translateError } from "@/lib/i18n";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in · Qemmini" },
      { name: "description", content: "Sign in or create a Qemmini account." },
      { property: "og:title", content: "Sign in · Qemmini" },
      { property: "og:description", content: "Access your Qemmini account." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AuthPage,
});

type Mode = "signin" | "signup" | "forgot";

function AuthPage() {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<"school_teacher" | "tutor" | "student">("school_teacher");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) navigate({ to: "/dashboard", replace: true });
    });
  }, [navigate]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        navigate({ to: "/dashboard", replace: true });
      } else if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin + "/dashboard", data: { full_name: name, role } },
        });
        if (error) throw error;
        if (data.session) navigate({ to: "/dashboard", replace: true });
        else toast.success(t("checkEmail"));
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin + "/reset-password" });
        if (error) throw error;
        toast.success(t("resetSent"));
      }
    } catch (err) {
      toast.error(translateError(err, lang));
    } finally {
      setBusy(false);
    }
  }

  async function google() {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin + "/auth" },
    });
    if (error) toast.error(translateError(error, lang));
    // On success Supabase redirects to /auth, and the effect above sends
    // signed-in users on to /dashboard.
  }

  return (
    <div className="grid min-h-screen md:grid-cols-2">
      <aside className="paper-grid hidden flex-col justify-between bg-sidebar p-10 text-sidebar-foreground md:flex">
        <Brand />
        <div>
          <h2 className="text-3xl font-bold leading-snug">{t("heroTitle")}</h2>
          <p className="mt-4 opacity-80">{t("tagline")}</p>
        </div>
        <span className="text-sm opacity-60">© Qemmini</span>
      </aside>
      <main className="flex flex-col p-6">
        <div className="flex justify-between">
          <Link to="/" className="md:invisible"><Brand className="text-primary" /></Link>
          <LangToggle />
        </div>
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center">
          <h1 className="mb-6 text-2xl font-bold">{mode === "signup" ? t("signUp") : mode === "forgot" ? t("forgot") : t("signIn")}</h1>
          <form onSubmit={onSubmit} className="space-y-4">
            {mode === "signup" && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="name">{t("fullName")}</Label>
                  <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
                </div>
                <fieldset className="space-y-1.5">
                  <legend className="text-sm font-medium">{t("iAm")}</legend>
                  <div className="grid grid-cols-3 gap-2">
                    {(["school_teacher", "tutor", "student"] as const).map((r) => (
                      <button
                        type="button"
                        key={r}
                        aria-pressed={role === r}
                        onClick={() => setRole(r)}
                        className={`rounded-md border px-3 py-2 text-sm font-medium transition-colors ${role === r ? "border-primary bg-secondary text-primary" : "hover:bg-muted"}`}
                      >
                        {t(r)}
                      </button>
                    ))}
                  </div>
                </fieldset>
              </>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="email">{t("email")}</Label>
              <Input id="email" type="email" dir="ltr" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            {mode !== "forgot" && (
              <div className="space-y-1.5">
                <Label htmlFor="password">{t("password")}</Label>
                <Input id="password" type="password" dir="ltr" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
            )}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? t("loading") : mode === "signup" ? t("signUp") : mode === "forgot" ? t("sendReset") : t("signIn")}
            </Button>
          </form>
          {mode !== "forgot" && (
            <>
              <div className="my-4 text-center text-xs text-muted-foreground">{t("or")}</div>
              <Button variant="outline" className="w-full" onClick={google}>{t("google")}</Button>
              {mode === "signup" && <p className="mt-2 text-xs text-muted-foreground">{lang === "ar" ? "حسابات Google الجديدة تُنشأ كحسابات طلاب." : "New Google accounts are created as student accounts."}</p>}
            </>
          )}
          <div className="mt-6 space-y-2 text-center text-sm">
            {mode === "signin" && (
              <>
                <button className="text-primary hover:underline" onClick={() => setMode("forgot")}>{t("forgot")}</button>
                <p>{t("noAccount")} <button className="font-medium text-primary hover:underline" onClick={() => setMode("signup")}>{t("signUp")}</button></p>
              </>
            )}
            {mode !== "signin" && (
              <p>{t("haveAccount")} <button className="font-medium text-primary hover:underline" onClick={() => setMode("signin")}>{t("signIn")}</button></p>
            )}
          </div>
          <footer className="mx-auto mt-8 w-full max-w-sm pb-2 text-center text-xs text-muted-foreground">
            <Link to="/terms" className="hover:underline">{t("terms")}</Link>
            {" · "}
            <Link to="/privacy" className="hover:underline">{t("privacy")}</Link>
          </footer>
        </div>
      </main>
    </div>
  );
}

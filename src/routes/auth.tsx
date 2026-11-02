import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { ArrowUpLeft, Check, ClipboardCheck, ClipboardList } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Brand, LangToggle } from "@/components/Brand";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n, translateError } from "@/lib/i18n";
import { isValidEgyptianMobile, normalizePhoneInput } from "@/lib/whatsapp";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in · Qayyimni" },
      { name: "description", content: "Sign in or create a Qayyimni account." },
      { property: "og:title", content: "Sign in · Qayyimni" },
      { property: "og:description", content: "Access your Qayyimni account." },
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
  const [parentPhone, setParentPhone] = useState("");
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
        // Parent phone is required for student accounts and must be an
        // Egyptian mobile; the signup trigger stores it only when valid.
        const cleanedPhone = normalizePhoneInput(parentPhone);
        if (role === "student" && !isValidEgyptianMobile(cleanedPhone)) {
          toast.error(t("parentPhoneInvalid"));
          return;
        }
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: window.location.origin + "/dashboard",
            data: {
              full_name: name,
              role,
              ...(role === "student" ? { parent_phone: cleanedPhone } : {}),
            },
          },
        });
        if (error) throw error;
        if (data.session) navigate({ to: "/dashboard", replace: true });
        else toast.success(t("checkEmail"));
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: window.location.origin + "/reset-password",
        });
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

  const modeTitle = mode === "signup" ? t("signUp") : mode === "forgot" ? t("forgot") : t("signIn");
  const sideItems = [
    { icon: ClipboardList, label: t("feature1") },
    { icon: ClipboardCheck, label: t("feature2") },
    { icon: Check, label: t("feature3") },
  ];

  return (
    <div className="auth-page grid md:grid-cols-[0.92fr_1.08fr]">
      <aside className="auth-aside hidden flex-col justify-between p-8 text-sidebar-foreground md:flex md:p-10 lg:p-14">
        <Link to="/" className="relative z-10 w-fit rounded-sm">
          <Brand onDark />
        </Link>
        <div className="relative z-10 my-12 max-w-xl">
          <p className="section-kicker section-kicker-light">{t("tagline")}</p>
          <h2 className="mt-5 text-3xl font-bold leading-[1.35] lg:text-4xl">{t("heroTitle")}</h2>
          <p className="mt-5 max-w-lg text-sm leading-7 text-sidebar-foreground/70">
            {t("brandPromise")}
          </p>
          <ul className="mt-9 space-y-4">
            {sideItems.map(({ icon: Icon, label }, index) => (
              <li
                key={label}
                className="flex items-center gap-3 text-sm text-sidebar-foreground/85"
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-sm border border-sidebar-border bg-sidebar-accent">
                  <Icon className="size-4 text-accent" aria-hidden />
                </span>
                <span className="font-display text-xs font-bold text-accent">0{index + 1}</span>
                <span>{label}</span>
              </li>
            ))}
          </ul>
        </div>
        <span dir="ltr" className="relative z-10 text-xs text-sidebar-foreground/45">
          © Qayyimni · {new Date().getFullYear()}
        </span>
      </aside>

      <main className="auth-main flex min-h-screen flex-col p-5 sm:p-8 md:p-10 lg:p-14">
        <div className="flex items-center justify-between">
          <Link to="/" className="rounded-sm md:invisible" aria-label={t("brand")}>
            <Brand className="text-primary" />
          </Link>
          <LangToggle className="ms-auto" />
        </div>

        <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center py-8">
          <div className="auth-card p-5 sm:p-7 md:p-8">
            <p className="section-kicker">{t("brand")}</p>
            <h1 className="mt-3 text-2xl font-bold md:text-3xl">{modeTitle}</h1>
            <div className="mb-6 mt-5 h-px bg-border" />

            <form onSubmit={onSubmit} className="space-y-4">
              {mode === "signup" && (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="name">{t("fullName")}</Label>
                    <Input
                      id="name"
                      required
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      maxLength={100}
                      autoComplete="name"
                    />
                  </div>
                  <fieldset className="space-y-2">
                    <legend className="text-sm font-medium">{t("iAm")}</legend>
                    {/* Stacked on phones: three Arabic role labels in one row
                        are unreadable below ~360px. */}
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                      {(["school_teacher", "tutor", "student"] as const).map((r) => (
                        <button
                          type="button"
                          key={r}
                          aria-pressed={role === r}
                          onClick={() => setRole(r)}
                          className="auth-mode-button min-h-10 rounded-sm border px-2 py-2 text-xs font-medium transition-colors hover:bg-muted sm:text-sm"
                        >
                          {t(r)}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                </>
              )}
              {mode === "signup" && role === "student" && (
                <div className="space-y-1.5">
                  <Label htmlFor="parent-phone">{t("parentPhone")}</Label>
                  <Input
                    id="parent-phone"
                    dir="ltr"
                    inputMode="tel"
                    required
                    aria-required="true"
                    placeholder="010…"
                    maxLength={16}
                    autoComplete="tel"
                    value={parentPhone}
                    onChange={(e) => setParentPhone(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">{t("parentPhoneHint")}</p>
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="email">{t("email")}</Label>
                <Input
                  id="email"
                  type="email"
                  dir="ltr"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              {mode !== "forgot" && (
                <div className="space-y-1.5">
                  <Label htmlFor="password">{t("password")}</Label>
                  <Input
                    id="password"
                    type="password"
                    dir="ltr"
                    required
                    minLength={8}
                    autoComplete={mode === "signup" ? "new-password" : "current-password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
              )}
              <Button type="submit" className="mt-2 h-11 w-full" disabled={busy}>
                {busy
                  ? t("loading")
                  : mode === "signup"
                    ? t("signUp")
                    : mode === "forgot"
                      ? t("sendReset")
                      : t("signIn")}
              </Button>
            </form>

            {mode !== "forgot" && (
              <>
                <div className="my-4 flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="h-px flex-1 bg-border" />
                  <span>{t("or")}</span>
                  <span className="h-px flex-1 bg-border" />
                </div>
                <Button type="button" variant="outline" className="h-11 w-full" onClick={google}>
                  {t("google")}
                </Button>
                {mode === "signup" && (
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    {lang === "ar"
                      ? "حسابات Google الجديدة تُنشأ كحسابات طلاب."
                      : "New Google accounts are created as student accounts."}
                  </p>
                )}
              </>
            )}

            <div className="mt-6 space-y-3 text-center text-sm">
              {mode === "signin" && (
                <>
                  <button
                    type="button"
                    className="text-primary hover:underline"
                    onClick={() => setMode("forgot")}
                  >
                    {t("forgot")}
                  </button>
                  <p>
                    {t("noAccount")}{" "}
                    <button
                      type="button"
                      className="font-medium text-primary hover:underline"
                      onClick={() => setMode("signup")}
                    >
                      {t("signUp")}
                    </button>
                  </p>
                </>
              )}
              {mode !== "signin" && (
                <p>
                  {t("haveAccount")}{" "}
                  <button
                    type="button"
                    className="font-medium text-primary hover:underline"
                    onClick={() => setMode("signin")}
                  >
                    {t("signIn")}
                  </button>
                </p>
              )}
            </div>
          </div>

          <footer className="mt-6 pb-2 text-center text-xs text-muted-foreground">
            <Link to="/terms" className="hover:text-foreground hover:underline">
              {t("terms")}
            </Link>
            {" · "}
            <Link to="/privacy" className="hover:text-foreground hover:underline">
              {t("privacy")}
            </Link>
            <Link
              to="/"
              className="mx-3 inline-flex items-center gap-1 hover:text-foreground hover:underline"
            >
              <ArrowUpLeft className="size-3" aria-hidden />
              {t("brand")}
            </Link>
          </footer>
        </div>
      </main>
    </div>
  );
}

import { createFileRoute, Link } from "@tanstack/react-router";
import { ClipboardList, Sparkles, LineChart } from "lucide-react";
import { Brand, LangToggle } from "@/components/Brand";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Qemmini · قَيِّمني — AI assessment for teachers & students" },
      {
        name: "description",
        content:
          "Build assessments, auto-grade objective questions and review AI grading suggestions for written answers. Arabic-first.",
      },
      { property: "og:title", content: "Qemmini · قَيِّمني" },
      {
        property: "og:description",
        content:
          "AI-powered assessment and learning platform. The teacher always has the final word.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Landing,
});

function Landing() {
  const { t } = useI18n();
  const features = [
    { icon: ClipboardList, title: t("feature1"), body: t("feature1b") },
    { icon: Sparkles, title: t("feature2"), body: t("feature2b") },
    { icon: LineChart, title: t("feature3"), body: t("feature3b") },
  ];
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Brand className="text-primary" />
        <div className="flex items-center gap-2">
          <LangToggle />
          <Button asChild variant="outline">
            <Link to="/auth">{t("signIn")}</Link>
          </Button>
        </div>
      </header>
      <section className="paper-grid border-y">
        <div className="mx-auto max-w-6xl px-6 py-24">
          <p className="mb-4 inline-block rounded-full bg-secondary px-3 py-1 text-sm font-medium text-secondary-foreground">
            {t("tagline")}
          </p>
          <h1 className="max-w-3xl text-4xl font-bold leading-tight text-primary md:text-6xl">
            {t("heroTitle")}
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-muted-foreground">{t("heroBody")}</p>
          <div className="mt-10">
            <Button asChild size="lg" className="h-12 px-8 text-base">
              <Link to="/auth">{t("getStarted")}</Link>
            </Button>
          </div>
        </div>
      </section>
      <section className="mx-auto grid max-w-6xl gap-6 px-6 py-20 md:grid-cols-3">
        {features.map((f) => (
          <div key={f.title} className="rounded-lg border bg-card p-6 shadow-soft">
            <f.icon className="mb-4 h-6 w-6 text-primary" aria-hidden />
            <h2 className="text-lg font-semibold">{f.title}</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{f.body}</p>
          </div>
        ))}
      </section>
      <footer className="border-t py-8 text-center text-sm text-muted-foreground">
        <p>© {new Date().getFullYear()} Qemmini</p>
        <nav className="mt-2 flex justify-center gap-4">
          <Link to="/terms" className="hover:underline">
            {t("terms")}
          </Link>
          <Link to="/privacy" className="hover:underline">
            {t("privacy")}
          </Link>
        </nav>
      </footer>
    </div>
  );
}

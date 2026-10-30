import { createFileRoute, Link } from "@tanstack/react-router";
import { ClipboardList, Sparkles, LineChart } from "lucide-react";
import { Brand, BrandMark, LangToggle, TwoDots } from "@/components/Brand";
import { HeroGradeCard } from "@/components/hero-grade-card";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Qemmini · قِمّيني — AI assessment for teachers & students" },
      {
        name: "description",
        content:
          "Build assessments, auto-grade objective questions and review AI grading suggestions for written answers. Arabic-first.",
      },
      { property: "og:title", content: "Qemmini · قِمّيني" },
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

      <section className="dots-pattern border-y">
        <div className="mx-auto grid max-w-6xl items-center gap-14 px-6 py-20 md:grid-cols-[1.15fr_1fr] md:py-28">
          <div>
            <p className="mb-5 inline-flex items-center gap-2.5 rounded-full bg-secondary px-3.5 py-1.5 text-sm font-medium text-secondary-foreground">
              <TwoDots />
              {t("tagline")}
            </p>
            <h1 className="max-w-3xl text-4xl font-bold leading-[1.25] text-primary md:text-5xl lg:text-6xl lg:leading-[1.2]">
              {t("heroTitle")}
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground">
              {t("heroBody")}
            </p>
            <div className="mt-10">
              <Button asChild size="lg" className="h-12 px-8 text-base">
                <Link to="/auth">{t("getStarted")}</Link>
              </Button>
            </div>
          </div>
          <HeroGradeCard />
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-6 px-6 py-20 md:grid-cols-3">
        {features.map((f, i) => (
          <div
            key={f.title}
            className="group rounded-lg border bg-card p-6 shadow-soft transition-shadow hover:shadow-lift"
          >
            <div className="mb-5 flex items-center justify-between">
              <span className="grid size-11 place-items-center rounded-lg bg-secondary text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                <f.icon className="size-5" aria-hidden />
              </span>
              <span className="font-display text-sm font-semibold text-muted-foreground/60">
                {(i + 1).toString().padStart(2, "0")}
              </span>
            </div>
            <h2 className="text-lg font-semibold">{f.title}</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{f.body}</p>
          </div>
        ))}
      </section>

      <section className="dots-pattern-light bg-sidebar text-sidebar-foreground">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-6 px-6 py-20 text-center">
          <BrandMark onDark className="size-16" />
          <h2 className="text-3xl font-bold md:text-4xl">{t("brandPromise")}</h2>
          <p className="max-w-xl text-lg leading-relaxed opacity-80">{t("brandPromiseBody")}</p>
          <Button
            asChild
            size="lg"
            className="mt-2 h-12 bg-accent px-8 text-base text-accent-foreground hover:bg-accent/90"
          >
            <Link to="/auth">{t("getStarted")}</Link>
          </Button>
        </div>
      </section>

      <footer className="border-t py-8 text-center text-sm text-muted-foreground">
        <p dir="ltr">© {new Date().getFullYear()} Qemmini</p>
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

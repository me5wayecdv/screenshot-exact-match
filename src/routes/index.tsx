import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, ClipboardCheck, ClipboardList, LineChart } from "lucide-react";
import { Brand, LangToggle } from "@/components/Brand";
import { HeroGradeCard } from "@/components/hero-grade-card";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Qayyimni · قَيّمني — Assessment review for teachers" },
      {
        name: "description",
        content:
          "Build classroom assessments, review grading evidence, and approve results before students see them.",
      },
      { property: "og:title", content: "Qayyimni · قَيّمني" },
      {
        property: "og:description",
        content: "A teacher's workspace for assessment and answer review.",
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
    { icon: ClipboardCheck, title: t("feature2"), body: t("feature2b") },
    { icon: LineChart, title: t("feature3"), body: t("feature3b") },
  ];

  return (
    <div className="landing-page min-h-screen">
      <header className="landing-header mx-auto flex max-w-7xl items-center justify-between px-5 py-4 md:px-8">
        <Link to="/" aria-label={t("brand")} className="rounded-sm">
          <Brand className="text-primary" />
        </Link>
        <nav className="hidden items-center gap-8 text-sm font-medium text-muted-foreground md:flex">
          <a href="#workflow" className="transition-colors hover:text-foreground">
            {t("workflowTitle")}
          </a>
          <a href="#product" className="transition-colors hover:text-foreground">
            {t("feature2")}
          </a>
        </nav>
        <div className="flex items-center gap-2">
          <LangToggle />
          <Button asChild variant="outline" className="hidden sm:inline-flex">
            <Link to="/auth">{t("signIn")}</Link>
          </Button>
        </div>
      </header>

      <main>
        <section className="mx-auto max-w-7xl px-4 pb-12 md:px-8 md:pb-16">
          <div className="landing-hero grid items-center gap-9 px-6 py-10 md:grid-cols-[1.04fr_0.96fr] md:gap-10 md:px-12 md:py-14 lg:px-16">
            <div className="landing-hero-copy relative z-10">
              <p className="mb-5 flex items-center gap-2 text-sm font-semibold text-accent">
                <span className="landing-rule" aria-hidden />
                {t("heroEyebrow")}
              </p>
              <h1 className="max-w-2xl text-4xl font-bold leading-[1.25] text-sidebar-foreground md:text-5xl lg:text-6xl">
                {t("heroTitle")}
              </h1>
              <p className="mt-6 max-w-xl text-base leading-8 text-sidebar-foreground/75 md:text-lg">
                {t("heroBody")}
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Button
                  asChild
                  size="lg"
                  className="h-12 gap-2 bg-accent px-5 text-accent-foreground hover:bg-accent/90"
                >
                  <Link to="/auth">
                    {t("getStarted")}
                    <ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />
                  </Link>
                </Button>
                <span className="text-sm text-sidebar-foreground/65">{t("brandPromise")}</span>
              </div>
              <div className="mt-10 flex flex-wrap gap-x-6 gap-y-2 border-t border-sidebar-border pt-5 text-xs font-medium text-sidebar-foreground/65">
                <span>{t("heroReviewNote")}</span>
                <span>{t("heroReleaseNote")}</span>
              </div>
            </div>
            <div className="landing-demo relative z-10 mx-auto w-full max-w-md">
              <HeroGradeCard />
            </div>
            <span className="landing-hero-index" aria-hidden>
              01
            </span>
          </div>
        </section>

        <section
          id="workflow"
          className="mx-auto max-w-7xl scroll-mt-8 px-5 py-12 md:px-8 md:py-16"
        >
          <div className="mb-8 flex flex-col justify-between gap-3 border-b pb-6 md:flex-row md:items-end">
            <div>
              <p className="section-kicker">{t("workflowKicker")}</p>
              <h2 className="mt-2 text-3xl font-bold md:text-4xl">{t("workflowTitle")}</h2>
            </div>
            <p className="max-w-md text-sm leading-7 text-muted-foreground">{t("workflowIntro")}</p>
          </div>
          <div className="grid md:grid-cols-3 md:divide-x md:rtl:divide-x-reverse">
            {[t("step1Label"), t("step2Label"), t("step3Label")].map((label, index) => {
              const detail = [t("step1Body"), t("step2Body"), t("step3Body")][index];
              return (
                <article
                  key={label}
                  className="workflow-step border-b py-6 md:border-b-0 md:px-7 md:py-4 first:md:ps-0 last:md:pe-0"
                >
                  <span className="font-display text-sm font-bold text-primary">0{index + 1}</span>
                  <h3 className="mt-4 text-xl font-semibold">{label}</h3>
                  <p className="mt-3 max-w-sm text-sm leading-7 text-muted-foreground">{detail}</p>
                </article>
              );
            })}
          </div>
        </section>

        <section id="product" className="mx-auto max-w-7xl scroll-mt-8 px-5 py-12 md:px-8 md:py-16">
          <div className="mb-8 max-w-2xl">
            <p className="section-kicker">{t("featuresKicker")}</p>
            <h2 className="mt-2 text-3xl font-bold md:text-4xl">{t("featuresTitle")}</h2>
          </div>
          <div className="grid border-y md:grid-cols-3 md:divide-x md:rtl:divide-x-reverse">
            {features.map((feature, index) => (
              <article
                key={feature.title}
                className="feature-panel border-b p-5 md:border-b-0 md:p-7"
              >
                <div className="flex items-center justify-between">
                  <feature.icon className="size-5 text-primary" aria-hidden />
                  <span className="font-display text-xs font-semibold text-muted-foreground">
                    0{index + 1}
                  </span>
                </div>
                <h3 className="mt-7 text-lg font-semibold leading-snug">{feature.title}</h3>
                <p className="mt-3 text-sm leading-7 text-muted-foreground">{feature.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-4 pb-14 md:px-8 md:pb-20">
          <div className="landing-close flex flex-col justify-between gap-6 px-6 py-8 md:flex-row md:items-center md:px-10 md:py-10">
            <div className="max-w-2xl">
              <p className="section-kicker section-kicker-light">{t("brand")}</p>
              <h2 className="mt-3 text-2xl font-bold leading-snug text-sidebar-foreground md:text-3xl">
                {t("closingTitle")}
              </h2>
              <p className="mt-3 text-sm leading-7 text-sidebar-foreground/70">
                {t("closingBody")}
              </p>
            </div>
            <Button
              asChild
              size="lg"
              className="h-12 shrink-0 gap-2 bg-accent px-5 text-accent-foreground hover:bg-accent/90"
            >
              <Link to="/auth">
                {t("getStarted")}
                <ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />
              </Link>
            </Button>
          </div>
        </section>
      </main>

      <footer className="landing-footer border-t">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-5 py-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between md:px-8">
          <Brand className="text-foreground" />
          <div className="flex items-center gap-5">
            <Link to="/terms" className="hover:text-foreground hover:underline">
              {t("terms")}
            </Link>
            <Link to="/privacy" className="hover:text-foreground hover:underline">
              {t("privacy")}
            </Link>
            <span dir="ltr">© {new Date().getFullYear()}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

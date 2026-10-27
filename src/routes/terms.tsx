import { createFileRoute, Link } from "@tanstack/react-router";
import { Brand, LangToggle } from "@/components/Brand";
import { useI18n } from "@/lib/i18n";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: "Terms · Qemmini" },
      {
        name: "description",
        content: "Terms of use for the Qemmini assessment and learning platform.",
      },
      { property: "og:title", content: "Terms · Qemmini" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: TermsPage,
});

function TermsPage() {
  const { t } = useI18n();
  const sections = [
    { title: t("termsAccountsTitle"), body: t("termsAccountsBody") },
    { title: t("termsRolesTitle"), body: t("termsRolesBody") },
    { title: t("termsContentTitle"), body: t("termsContentBody") },
    { title: t("termsAiTitle"), body: t("termsAiBody") },
    { title: t("termsFairUseTitle"), body: t("termsFairUseBody") },
    { title: t("termsAvailabilityTitle"), body: t("termsAvailabilityBody") },
    { title: t("termsChangesTitle"), body: t("termsChangesBody") },
    { title: t("contactTitle"), body: t("contactBody") },
  ];
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Brand className="text-primary" />
        <LangToggle />
      </header>
      <main className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="text-3xl font-bold text-primary">{t("termsTitle")}</h1>
        <p className="mt-4 leading-relaxed text-muted-foreground">{t("termsIntro")}</p>
        {sections.map((s) => (
          <section key={s.title} className="mt-8">
            <h2 className="text-lg font-semibold">{s.title}</h2>
            <p className="mt-2 leading-relaxed text-muted-foreground">{s.body}</p>
          </section>
        ))}
      </main>
      <footer className="border-t py-8 text-center text-sm text-muted-foreground">
        <p>© {new Date().getFullYear()} Qemmini</p>
        <nav className="mt-2 flex justify-center gap-4">
          <Link to="/" className="hover:underline">
            {t("backHome")}
          </Link>
          <Link to="/privacy" className="hover:underline">
            {t("privacy")}
          </Link>
        </nav>
      </footer>
    </div>
  );
}

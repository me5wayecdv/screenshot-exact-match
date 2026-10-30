import { createFileRoute, Link } from "@tanstack/react-router";
import { Brand, LangToggle } from "@/components/Brand";
import { useI18n } from "@/lib/i18n";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy · Qayyimni" },
      {
        name: "description",
        content: "How Qayyimni collects, uses and protects account and student data.",
      },
      { property: "og:title", content: "Privacy · Qayyimni" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: PrivacyPage,
});

function PrivacyPage() {
  const { t } = useI18n();
  const sections = [
    { title: t("privacyCollectTitle"), body: t("privacyCollectBody") },
    { title: t("privacyUseTitle"), body: t("privacyUseBody") },
    { title: t("privacySharingTitle"), body: t("privacySharingBody") },
    { title: t("privacyStudentTitle"), body: t("privacyStudentBody") },
    { title: t("privacyRetentionTitle"), body: t("privacyRetentionBody") },
    { title: t("privacySecurityTitle"), body: t("privacySecurityBody") },
    { title: t("privacyRightsTitle"), body: t("privacyRightsBody") },
    { title: t("privacyChangesTitle"), body: t("privacyChangesBody") },
    { title: t("contactTitle"), body: t("contactBody") },
  ];
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Brand className="text-primary" />
        <LangToggle />
      </header>
      <main className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="text-3xl font-bold text-primary">{t("privacyTitle")}</h1>
        <p className="mt-4 leading-relaxed text-muted-foreground">{t("privacyIntro")}</p>
        {sections.map((s) => (
          <section key={s.title} className="mt-8">
            <h2 className="text-lg font-semibold">{s.title}</h2>
            <p className="mt-2 leading-relaxed text-muted-foreground">{s.body}</p>
          </section>
        ))}
      </main>
      <footer className="border-t py-8 text-center text-sm text-muted-foreground">
        <p>© {new Date().getFullYear()} Qayyimni</p>
        <nav className="mt-2 flex justify-center gap-4">
          <Link to="/" className="hover:underline">
            {t("backHome")}
          </Link>
          <Link to="/terms" className="hover:underline">
            {t("terms")}
          </Link>
        </nav>
      </footer>
    </div>
  );
}

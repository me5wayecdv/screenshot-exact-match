import { useI18n } from "@/lib/i18n";

export function Brand({ className = "" }: { className?: string }) {
  const { t } = useI18n();
  return (
    <span className={`inline-flex items-center gap-2 font-display text-xl font-bold ${className}`}>
      <span
        aria-hidden
        className="grid h-8 w-8 place-items-center rounded-md bg-accent text-accent-foreground"
      >
        ق
      </span>
      {t("brand")}
    </span>
  );
}

export function LangToggle({ className = "" }: { className?: string }) {
  const { t, lang, setLang } = useI18n();
  return (
    <button
      type="button"
      onClick={() => setLang(lang === "ar" ? "en" : "ar")}
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted ${className}`}
    >
      {t("language")}
    </button>
  );
}

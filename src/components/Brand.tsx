import { useI18n } from "@/lib/i18n";

/**
 * The Qayyimni mark: a geometric ق whose two dots tell the product story.
 * The first dot (right, where Arabic reading starts) is the suggestion; the
 * second, saffron dot is the teacher's last word. See docs/brand.md.
 *
 * Colours come from the design tokens in styles.css, so the mark follows the
 * theme. `onDark` swaps to the cream tile for deep-teal surfaces (sidebar,
 * auth panel). The static SVG/PNG exports live in public/brand/.
 */
export function BrandMark({
  className = "",
  onDark = false,
  tile = true,
}: {
  className?: string;
  /** Use on deep-teal surfaces: cream tile, teal dot. */
  onDark?: boolean;
  /** `false` draws the bare glyph in currentColor (single colour). */
  tile?: boolean;
}) {
  const glyph = tile ? (onDark ? "stroke-sidebar" : "stroke-background") : "stroke-current";
  const firstDot = tile ? (onDark ? "fill-primary" : "fill-background") : "fill-current";
  const lastDot = tile ? "fill-accent" : "fill-current";
  return (
    <svg
      viewBox="0 0 64 64"
      aria-hidden
      focusable="false"
      className={`h-8 w-8 shrink-0 ${className}`}
    >
      {tile && (
        <rect
          width="64"
          height="64"
          rx="16"
          className={onDark ? "fill-background" : "fill-primary"}
        />
      )}
      <g
        transform="translate(4 -1.5)"
        fill="none"
        strokeWidth="5.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={glyph}
      >
        <circle cx="37" cy="31.5" r="8.6" />
        <path d="M45.6 31.5V37.5a17.5 17.5 0 0 1-35 0V31" />
      </g>
      <g transform="translate(4 -1.5)">
        <circle cx="31.5" cy="13.2" r="3.5" className={lastDot} />
        <circle cx="43.5" cy="13.2" r="3.5" className={firstDot} />
      </g>
    </svg>
  );
}

/**
 * The two dots on their own: the brand's signature motif. First dot is the
 * suggestion, the saffron one is the teacher's last word. Use sparingly, as a
 * bullet or section marker, not as decoration everywhere.
 */
export function TwoDots({ className = "" }: { className?: string }) {
  return (
    <span aria-hidden className={`inline-flex shrink-0 items-center gap-1 ${className}`}>
      <i className="size-2 rounded-full bg-primary" />
      <i className="size-2 rounded-full bg-accent" />
    </span>
  );
}

export function Brand({
  className = "",
  onDark = false,
}: {
  className?: string;
  /** Set on deep-teal surfaces so the mark uses its cream-tile variant. */
  onDark?: boolean;
}) {
  const { t, lang } = useI18n();
  return (
    <span
      lang={lang}
      dir={lang === "ar" ? "rtl" : "ltr"}
      className={`inline-flex items-center gap-2.5 font-display text-xl font-bold tracking-normal ${className}`}
    >
      <BrandMark onDark={onDark} />
      <span>{t("brand")}</span>
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

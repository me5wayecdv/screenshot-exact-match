import { useId } from "react";

import { useI18n } from "@/lib/i18n";

/**
 * The Qayyimni mark: a geometric ق whose two dots tell the product story.
 * The first dot (right, where Arabic reading starts) is the suggestion; the
 * second, cyan "signal" dot is the teacher's last word. The tile is the
 * brand beam (indigo → violet) so the mark reads as technology, not paper.
 * See docs/brand.md.
 *
 * Colours come from the design tokens in styles.css, so the mark follows the
 * theme. `onDark` swaps to the white tile for dark surfaces (sidebar,
 * auth panel). The static SVG/PNG exports live in public/brand/.
 */
export function BrandMark({
  className = "",
  onDark = false,
  tile = true,
}: {
  className?: string;
  /** Use on dark surfaces: white tile, teal dot. */
  onDark?: boolean;
  /** `false` draws the bare glyph in currentColor (single colour). */
  tile?: boolean;
}) {
  // Unique gradient id per instance: several marks can share a page.
  const gradientId = useId();
  const glyph = tile ? "stroke-white" : "stroke-current";
  const firstDot = tile ? "fill-white" : "fill-current";
  const lastDot = tile ? "fill-accent" : "fill-current";
  return (
    <svg
      viewBox="0 0 64 64"
      aria-hidden
      focusable="false"
      className={`h-8 w-8 shrink-0 ${className}`}
    >
      {tile && (
        <>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="var(--color-primary)" />
              <stop offset="100%" stopColor="var(--beam-violet, var(--color-primary))" />
            </linearGradient>
          </defs>
          <rect width="64" height="64" rx="18" fill={`url(#${gradientId})`} />
        </>
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
  /** Set on dark surfaces so the mark uses its white-tile variant. */
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

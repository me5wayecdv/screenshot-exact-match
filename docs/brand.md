# Qayyimni brand guide · دليل الهوية

Arabic-first. Every rule below works right-to-left first and mirrors for English.

## The idea

The Arabic name is **قَيّمني** (Qayyimni), with a fatha on ق. It means “evaluate me”: students ask it; teachers answer it. Use this spelling consistently; do not use the older **قِمّيني** form.

The product promise is one line: **الكلمة الأخيرة للمعلّم** — _the teacher has the last word_. AI suggests, the teacher decides, nothing is released until they approve.

The identity is built on the one detail of ق that tells that story: **its two dots** — now read as a _signal pair_, which is also the visual metaphor of the product.

- the **first dot** (right, where Arabic reading starts) is the suggestion
- the **second, bronze dot** is the teacher's last word

That pair is the signature. It appears in the logo and as a bullet (`<TwoDots />`).

The look is deliberately **quiet**: graphite surfaces, hairline borders, one deep teal
for the product's voice, bronze for the teacher's decision, and nothing else. No
gradients as decoration, no glow, no glassmorphism, no oversized radii. Depth is a 1px
border and one hairline shadow. Restraint is the brand: a real product, not a demo.

## Logo

| File (`public/brand/`)                                                                   | Use                                                   |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `logo-ar.svg`, `logo-en.svg`                                                             | Default lockups on light backgrounds                  |
| `logo-ar-on-dark.svg`, `logo-en-on-dark.svg`                                             | On Deep Ocean / photos darker than 40% luminance      |
| `mark.svg`, `mark-on-dark.svg`, `mark-saffron.svg`                                       | Mark only (app icons, avatars, small spaces)          |
| `mark-glyph.svg`                                                                         | One-colour glyph, no tile (stamps, watermarks, print) |
| `wordmark-ar.svg`, `wordmark-en.svg`                                                     | Editable live-text wordmarks, `currentColor`          |
| `favicon.svg`, `/favicon.ico`, `apple-touch-icon.png`, `icon-maskable.svg`, `icon-*.png` | Browser and device icons (heavier stroke at 16px)     |
| `og-image.svg`, `og-image.png`                                                           | Source SVG and social share image, 1200×630           |

- Arabic lockups use the correctly vocalized live wordmark **قَيّمني**; English uses **Qayyimni**. SVG wordmarks keep the text editable; the app uses `<Brand />` so language and direction stay in sync. In the Arabic lockup the mark sits on the **right**; in English, on the **left**.
- In the app use `<Brand />` and `<BrandMark />` from `src/components/Brand.tsx`. Pass `onDark` on deep-teal surfaces (sidebar, auth panel).
- **Clear space:** at least the width of one dot (≈ 1/9 of the tile) on every side. **Minimum size:** 16 px for the mark, 96 px wide for a lockup.
- **Don't:** recolour the dots, stretch, rotate, add extra shadows or outlines, place the gradient tile on a photo without a scrim, or letter-space the Arabic.

## Colour

Tokens live in `src/styles.css` (OKLCH). Hex is for design tools and static assets.

| Name                | Token                                       | Approx. hex                       | Role                                                    |
| ------------------- | ------------------------------------------- | --------------------------------- | ------------------------------------------------------- |
| **Canvas** · شاشة   | `--background`                              | `#F9F9F7`                         | Warm near-white page canvas                             |
| **White** · أبيض    | `--card`                                    | `#FFFFFF`                         | Cards, forms, popovers                                  |
| **Graphite** · فحمي | `--foreground` / `--sidebar`                | `#1B1E22` / `#171A1D`             | Text (15.9 : 1) and dark surfaces                       |
| **Ink** · حبر أخضر  | `--primary`                                 | `#1F4F4F`                         | The product's voice: buttons, links, headings (9.2 : 1) |
| **Bronze** · نحاس   | `--accent`                                  | `#C9A46B`                         | The teacher's decision; fill only, under 5% of a screen |
| **Bronze Ink**      | `--accent-foreground`                       | `#39230F`                         | Text on bronze (6.3 : 1)                                |
| **Halo**            | `--secondary`                               | `#EDF3F3`                         | Tints, quiet fills                                      |
| Clay / Pine / Amber | `--destructive` / `--success` / `--warning` | `#AC312E` / `#1B6A4C` / `#A67537` | Status only                                             |

**Rules**

1. **Bronze is never text on Canvas** (2.2 : 1). It is a fill, a 2 px rule, or a dot — nothing else.
2. **One accent per view.** If bronze marks the primary action, nothing else on that screen is bronze.
3. **No gradients as decoration, no glow, no blur.** A surface may be flat, bordered, or tinted at ≤10% — those are the three options.
4. Balance ≈ 70% Canvas + White, 20% Graphite and Ink, 10% everything else.
5. Contrast is checked, not eyeballed: body text ≥ 4.5 : 1, large text ≥ 3 : 1. `--warning-foreground` is a dark ink because it is used as text on amber tints.

## Typography

| Role    | Family                   | Weights  | Notes                                         |
| ------- | ------------------------ | -------- | --------------------------------------------- |
| Display | **Readex Pro**           | 600, 700 | Headlines, wordmark. Warm, open forms         |
| Body/UI | **IBM Plex Sans Arabic** | 400–600  | Text, forms, tables. Excellent Latin pairing  |
| Data    | **IBM Plex Mono**        | 500, 600 | Figures, kickers, chips — the "console" voice |

- Arabic line-height **1.25** on headlines, **1.7** on body. Arabic needs more air than Latin.
- **Never letter-space Arabic** (`:lang(ar)` resets tracking). Headlines use `text-wrap: balance`.
- Wrap mixed-direction snippets (`© 2026 Qayyimni`, numbers with units) in `dir="ltr"`.

## Shape and motion

- Radius 6 px (`--radius`). Nothing larger than 10 px except a dark hero panel (12 px). Squared-off is the point: it separates a product from a template.
- **Borders over shadows.** `border` (1 px, `--border`) is the default separator; `shadow-soft` is a hairline and optional; `shadow-lift` belongs to popovers and sheets only.
- **Numbers** are set in IBM Plex Mono with tabular figures (`.figures`), so columns of marks line up.
- **Motion:** 120–200 ms colour and border transitions. Nothing moves, spins, bounces or scales on load. All animation is disabled under `prefers-reduced-motion`.

## Voice

Calm, exact, on the teacher's side. Short sentences. Say what the product does, then who decides.

| Do                                                | Don't                          |
| ------------------------------------------------- | ------------------------------ |
| «يقترح الذكاء الاصطناعي، ويعتمد المعلّم»          | «تصحيح آلي بالكامل»            |
| "AI suggests, the teacher decides."               | "Fully automated grading."     |
| Name the state: _suggested · approved · released_ | Hype: "revolutionary", "magic" |

Arabic first, Modern Standard with warm register. Egyptian-dialect words only in friendly microcopy, never in grades, rules or legal text.

## Regenerating assets

The SVGs in `public/brand/` are the source of truth. The mark geometry is in `src/components/Brand.tsx` (64×64 grid: loop `r=8.6` at `37,31.5`, basin `r=17.5`, stroke 5.5, dots `r=3.5`). If the mark changes, update the component and the SVGs together, then re-export the PNG and `.ico` files from `favicon.svg` and `mark.svg`.

Before shipping publicly, set absolute URLs for `og:image` and `twitter:image` in `src/routes/__root.tsx` once the production domain is known: some link scrapers ignore relative image URLs.

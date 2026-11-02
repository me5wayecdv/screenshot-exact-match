# Qayyimni brand guide · دليل الهوية

Arabic-first. Every rule below works right-to-left first and mirrors for English.

## The idea

The Arabic name is **قَيّمني** (Qayyimni), with a fatha on ق. It means “evaluate me”: students ask it; teachers answer it. Use this spelling consistently; do not use the older **قِمّيني** form.

The product promise is one line: **الكلمة الأخيرة للمعلّم** — _the teacher has the last word_. AI suggests, the teacher decides, nothing is released until they approve.

The identity is built on the one detail of ق that tells that story: **its two dots** — now read as a _signal pair_, which is also the visual metaphor of the product.

- the **first dot** (right, where Arabic reading starts) is the suggestion
- the **second, cyan signal dot** is the teacher's last word

That pair is the signature. It appears in the logo, as a bullet (`<TwoDots />`), and in the interface as the **beam** (cyan → violet → indigo).

The overall look is **technology-education, not paper**: a calm console that carries learning data between a teacher and a student. Fine grid meshes, soft glass surfaces, one beam gradient, mono numerals for figures.

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

| Name                 | Token                                       | Approx. hex                       | Role                                                    |
| -------------------- | ------------------------------------------- | --------------------------------- | ------------------------------------------------------- |
| **Canvas** · شاشة    | `--background`                              | `#F6F7FB`                         | Cool near-white page canvas                             |
| **White** · أبيض     | `--card`                                    | `#FFFFFF`                         | Cards, forms, popovers                                  |
| **Ink** · حبر نص     | `--foreground`                              | `#181B2D`                         | Text (15.9 : 1 on Canvas)                               |
| **Signal** · إشارة   | `--primary`                                 | `#515DDF`                         | The product's voice: buttons, links, headings (5.3 : 1) |
| **Node** · عقدة      | `--sidebar`                                 | `#13162E`                         | Console surfaces, sidebar, auth panel                   |
| **Beam Cyan** · شعاع | `--accent`                                  | `#0DCFDF`                         | Live data, suggestions, highlights (9.3 : 1 on Node)    |
| **Beam Violet**      | `--beam-violet`                             | `#9B61EA`                         | Second beam stop only — gradients, never text           |
| **Signal Deep**      | `--accent-foreground`                       | `#001E2E`                         | Text on cyan (9.0 : 1)                                  |
| **Halo**             | `--secondary`                               | `#E8ECFF`                         | Tints, pills, quiet fills                               |
| Clay / Mint / Amber  | `--destructive` / `--success` / `--warning` | `#D73240` / `#008559` / `#EBAE42` | Status only                                             |

**Rules**

1. **Cyan is a signal, never body text on white.** It belongs on Node/dark surfaces, or as a fill with Signal Deep on it.
2. **Cyan means "live".** Suggestions, in-progress, just-arrived. Released and approved states use Mint; warnings use Amber.
3. **One beam per view.** A single gradient (cyan → violet → indigo) marks the primary surface; do not repeat it on every card.
4. Balance ≈ 70% Canvas + White, 20% Node and Signal, 10% everything else. Gradients stay under 15% of the screen.
5. Contrast is checked, not eyeballed: body text ≥ 4.5 : 1, large text ≥ 3 : 1. Numerals are set in **IBM Plex Mono** so tables line up.

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

- Radius 12 px (`--radius`); the mark's tile is a 28% squircle. Cards use `shadow-soft`; the hero and hover use `shadow-glow` (a coloured, not grey, glow).
- **Texture:** `grid-mesh` — a 32 px fine mesh at 7% indigo. One mesh surface per screen; dark surfaces draw their own mesh inside the beam.
- **Beam:** `linear-gradient(cyan → violet → indigo)`. It appears as the hero spine, the active-nav bar, and the landing rule. Nothing else.
- **Motion:** approval drops in with a small overshoot (`animate-stamp`). Everything else is 120–200 ms colour/shadow transitions. All animation is disabled under `prefers-reduced-motion`.

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

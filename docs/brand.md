# Qayyimni brand guide · دليل الهوية

Arabic-first. Every rule below works right-to-left first and mirrors for English.

## The idea

The Arabic name is **قَيّمني** (Qayyimni), with a fatha on ق. It means “evaluate me”: students ask it; teachers answer it. Use this spelling consistently; do not use the older **قِمّيني** form.

The product promise is one line: **الكلمة الأخيرة للمعلّم** — _the teacher has the last word_. AI suggests, the teacher decides, nothing is released until they approve.

The identity is built on the one detail of ق that tells that story: **its two dots.**

- the **first dot** (right, where Arabic reading starts) is the suggestion
- the **second, saffron dot** is the teacher's last word

That pair of dots is the signature. It appears in the logo, as a bullet (`<TwoDots />`), as the background pattern, and in the hero illustration (dashed suggestion → solid saffron stamp).

## Logo

| File (`public/brand/`)                                              | Use                                                   |
| ------------------------------------------------------------------- | ----------------------------------------------------- |
| `logo-ar.svg`, `logo-en.svg`                                        | Default lockups on light backgrounds                  |
| `logo-ar-on-dark.svg`, `logo-en-on-dark.svg`                        | On Deep Teal / photos darker than 40% luminance       |
| `mark.svg`, `mark-on-dark.svg`, `mark-saffron.svg`                  | Mark only (app icons, avatars, small spaces)          |
| `mark-glyph.svg`                                                    | One-colour glyph, no tile (stamps, watermarks, print) |
| `wordmark-ar.svg`, `wordmark-en.svg`                                | Editable live-text wordmarks, `currentColor`          |
| `favicon.svg`, `/favicon.ico`, `apple-touch-icon.png`, `icon-*.png` | Browser and device icons (heavier stroke at 16px)     |
| `og-image.svg`, `og-image.png`                                      | Source SVG and social share image, 1200×630           |

- Arabic lockups use the correctly vocalized live wordmark **قَيّمني**; English uses **Qayyimni**. SVG wordmarks keep the text editable; the app uses `<Brand />` so language and direction stay in sync. In the Arabic lockup the mark sits on the **right**; in English, on the **left**.
- In the app use `<Brand />` and `<BrandMark />` from `src/components/Brand.tsx`. Pass `onDark` on deep-teal surfaces (sidebar, auth panel).
- **Clear space:** at least the width of one dot (≈ 1/9 of the tile) on every side. **Minimum size:** 16 px for the mark, 96 px wide for a lockup.
- **Don't:** recolour the dots, put the white-tile mark on Papyrus without a border, stretch, rotate, add shadows or outlines, place the saffron tile on Saffron, or letter-space the Arabic.

## Colour

Tokens live in `src/styles.css` (OKLCH). Hex is for design tools and static assets.

| Name                      | Token                                    | Hex                               | Role                                                 |
| ------------------------- | ---------------------------------------- | --------------------------------- | ---------------------------------------------------- |
| **Papyrus** · بردي        | `--background`                           | `#FCF9F3`                         | Canvas. Warm paper, never pure white                 |
| **Ink** · حبر             | `--foreground`                           | `#0B2425`                         | Text (15.5 : 1 on Papyrus)                           |
| **Ink Teal** · أخضر الحبر | `--primary`                              | `#00595A`                         | The brand colour: buttons, links, headings (7.8 : 1) |
| **Deep Teal** · أخضر عميق | `--sidebar`                              | `#023537`                         | Dark surfaces, sidebar, auth panel                   |
| **Saffron** · زعفران      | `--accent`                               | `#F2AF48`                         | The teacher's mark: approval, highlights             |
| **Saffron Ink**           | `--accent-foreground`                    | `#38200A`                         | Text on Saffron (8.0 : 1)                            |
| **Mist**                  | `--secondary`                            | `#DEF0EC`                         | Tints, pills, quiet fills                            |
| Clay / Leaf / Nile        | `--destructive` / `--success` / `--info` | `#CC342D` / `#258651` / `#347A9F` | Status only                                          |

**Rules**

1. **Saffron is a fill, never text on paper.** On Papyrus it is only 1.8 : 1. Put Saffron Ink on it, or use it for dots and stamps.
2. **Saffron means "teacher decided".** Use it for approved, released and final states. Dashed or tinted (`--accent-soft`) means "AI suggestion, not final". Don't spend it on decoration.
3. Ratio ≈ 70% Papyrus, 20% Ink Teal and Deep Teal, 10% everything else; Saffron under 5%.

## Typography

| Role    | Family                   | Weights  | Notes                                           |
| ------- | ------------------------ | -------- | ----------------------------------------------- |
| Display | **Readex Pro**           | 600, 700 | Headlines, wordmark, numerals. Warm, open forms |
| Body/UI | **IBM Plex Sans Arabic** | 400–600  | Text, forms, tables. Excellent Latin pairing    |

- Arabic line-height **1.25** on headlines, **1.7** on body. Arabic needs more air than Latin.
- **Never letter-space Arabic** (`:lang(ar)` resets tracking). Headlines use `text-wrap: balance`.
- Wrap mixed-direction snippets (`© 2026 Qayyimni`, numbers with units) in `dir="ltr"`.

## Shape and motion

- Radius 8 px (`--radius`); the mark's tile is a 25% squircle (`rx 16/64`). Cards use `shadow-soft`, hover and hero use `shadow-lift`.
- **Pattern:** `dots-pattern` (on Papyrus) and `dots-pattern-light` (on Deep Teal): pairs of dots on a staggered lattice, 7–8% opacity. One pattern surface per screen.
- **Motion:** the only signature animation is the **stamp** (`animate-stamp`): approval lands with a small overshoot. Everything else is 120–200 ms colour/shadow transitions. All animation is disabled under `prefers-reduced-motion`.

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

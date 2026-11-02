# UI rules: simple first, technical second

Two goals, in this order. If a screen can be simpler, it is — decoration never
buys complexity.

## Simple

1. **One decision per screen.** Every home screen opens with a `Hero`
   (`src/components/ui-kit.tsx`): a short line naming the _next_ action and
   exactly one primary button. Nothing competes with it.
2. **Four everyday destinations, everything else behind "More".**
   `src/routes/_authenticated/route.tsx` keeps `primary` (max 4) and
   `secondary`. Desktop shows `primary` + a `المزيد` toggle; phones use a bottom
   tab bar with the same four plus "More" — thumb-reachable, no scroll strip.
3. **Numbers are chips, not cards.** `StatChip` replaces the row of big tiles;
   stats stop competing with the action.
4. **Progressive disclosure for one-time things.** Optional data (parent phone)
   lives in a `<details>` block, not at the top of the page.
5. **Empty states say what to do.** `EmptyCard`: icon, one line, one button.
6. **Plain words, short sentences.** Arabic-first copy in `src/lib/i18n.tsx`;
   every new label goes in **both** languages.
7. **Touch first.** Interactive rows are ≥44px (`min-h-11`), bottom nav items
   3.25rem, and inputs stay 16px on phones so iOS never zooms.

## Technology, not paper

The product is a calm console for learning — `docs/brand.md`. Paper, ink,
highlighter, sticker and tilted-card metaphors are **not** used. The creative
layer lives in `src/styles.css` and is pure surface treatment, never layout:

| Class                      | Use                                                                     |
| -------------------------- | ----------------------------------------------------------------------- |
| `.console-hero`            | The dark indigo card: grid mesh, beam spine, soft glow. One per screen. |
| `.chip-glow`               | Live pill with a glowing dot — kickers and "just now" states. One only. |
| `.signal`                  | Cyan→indigo wash under one or two words. Never a whole line or heading. |
| `.grid-mesh`               | Fine 32px mesh on a light section. One per screen.                      |
| `.lift`                    | 2px hover lift + coloured glow on the _primary_ card only.              |
| `.stat-chip`               | Quiet number + label, mono numerals.                                    |
| `.tabbar` / `.tabbar-item` | Phone navigation.                                                       |
| `.empty-card`              | Empty state with an action.                                             |
| `.landing-rule`            | 24px beam rule used as a separator instead of another card.             |

Rules of taste: one beam gradient per view, at most one `chip-glow`, at most one
highlighted phrase, no gradients on text, no tilt/rotation, no paper textures.
Every animation must survive `prefers-reduced-motion` (handled globally).

## When adding a page

- Start from `Hero` (what do I do now?) → `StatChip` row (optional) → one list
  or form. If you need a third section, ask whether it belongs on another page.
- Reuse `Panel`, `Pill`, `EmptyCard`; never introduce a second card style.

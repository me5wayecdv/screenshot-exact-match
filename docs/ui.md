# UI rules: simple first, hand-made second

Two goals, in this order. If a screen can be simpler, it is — decoration never
buys complexity.

## Simple

1. **One decision per screen.** Every home screen opens with a `Hero`
   (`src/components/ui-kit.tsx`): a short line naming the *next* action and
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

## Hand-made, not glossy

The brand is paper, ink and a teacher's pencil (`docs/brand.md`). The creative
layer lives in `src/styles.css`:

| Class | Use |
| ----- | --- |
| `.ink-hero` | The dark "ink" card: dotted paper, saffron spine, soft lift. |
| `.marker` | Saffron highlighter behind one or two words — never a whole line. |
| `.sticker` | Slightly tilted badge for a single kicker. One per screen. |
| `.lift` | 2px hover lift on the *primary* action only. |
| `.stat-chip` | Quiet number + label. |
| `.tabbar` / `.tabbar-item` | Phone navigation. |
| `.empty-card` | Empty state with an action. |
| `.paper-band` | Dotted separation band instead of another card. |

Rules of taste: at most one sticker, at most one highlighted phrase, one
accent colour (saffron) per view; no gradients on text; no motion without
`prefers-reduced-motion` support (handled globally).

## When adding a page

- Start from `Hero` (what do I do now?) → `StatChip` row (optional) → one list
  or form. If you need a third section, ask whether it belongs on another page.
- Reuse `Panel`, `Pill`, `EmptyCard`; never introduce a second card style.

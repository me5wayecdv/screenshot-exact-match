# UI rules: simple first, quiet second

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

## Quiet, not decorative

Depth is a border. Colour is one accent. The creative layer lives in
`src/styles.css` and is pure surface treatment, never layout:

| Class                      | Use                                                                      |
| -------------------------- | ------------------------------------------------------------------------ |
| `.console-hero`            | The one dark graphite card on a page, with a 2 px bronze rule.           |
| `.chip-glow`               | Small bordered caption. One per screen.                                  |
| `.signal`                  | 2 px bronze underline under two words. Never a wash, never a whole line. |
| `.lift`                    | Border darkens on hover. No shadow, no movement.                         |
| `.stat-chip`               | Quiet number + label, mono figures.                                      |
| `.figures`                 | Tabular mono numerals for anything compared down a column.               |
| `.tabbar` / `.tabbar-item` | Phone navigation.                                                        |
| `.empty-card`              | Empty state with an action.                                              |
| `.nav-sheet`               | The "More" drawer.                                                       |

Banned, because they are what makes a site look machine-generated: multi-stop
gradients, coloured glows, glassmorphism / `backdrop-blur`, radii over 12 px,
letter-spaced uppercase kickers, emoji as icons, and hover movement. Arabic is
never letter-spaced.

## When adding a page

- Start from `Hero` (what do I do now?) → `StatChip` row (optional) → one list
  or form. If you need a third section, ask whether it belongs on another page.
- Reuse `Panel`, `Pill`, `EmptyCard`; never introduce a second card style.

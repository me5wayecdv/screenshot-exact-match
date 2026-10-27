/**
 * Uncertain-span markers for handwritten OCR (Phase 3).
 *
 * The handwritten OCR prompt asks the vision model to wrap text it
 * reads with difficulty in ⟦ ⟧ markers (fully unreadable parts are
 * already written as [غير واضح]). These markers are the MODEL's own
 * self-reported uncertainty — NOT a measured confidence score, and
 * the review UI must label them that way.
 *
 * Parsing rules (deliberately conservative):
 * - A span is uncertain only between a matched ⟦ ... ⟧ pair.
 * - An unclosed ⟦ (no later ⟧) is treated as plain text, so a stray
 *   marker can never swallow the rest of the answer.
 * - Empty ⟦⟧ pairs are dropped.
 */

export type TextSpan = { text: string; uncertain: boolean };

export function parseUncertainSpans(text: string): TextSpan[] {
  const spans: TextSpan[] = [];
  let rest = text;
  while (rest.length > 0) {
    const open = rest.indexOf("⟦");
    if (open === -1) {
      spans.push({ text: rest, uncertain: false });
      break;
    }
    const close = rest.indexOf("⟧", open + 1);
    if (close === -1) {
      // Unclosed marker: plain text, never swallow the remainder.
      spans.push({ text: rest, uncertain: false });
      break;
    }
    if (open > 0) spans.push({ text: rest.slice(0, open), uncertain: false });
    const inner = rest.slice(open + 1, close);
    if (inner) spans.push({ text: inner, uncertain: true });
    rest = rest.slice(close + 1);
  }
  return spans.filter((s) => s.text.length > 0);
}

export function countUncertainSpans(text: string): number {
  return parseUncertainSpans(text).filter((s) => s.uncertain).length;
}

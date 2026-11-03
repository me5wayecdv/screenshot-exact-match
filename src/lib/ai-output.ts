/**
 * Small display cleanup for generated prose. Do not use on OCR/transcription
 * results, where punctuation and diacritics may be part of the source material.
 *
 * Bold handling is deliberately narrow: only **...** spans whose content
 * contains at least one letter are unbolded. That keeps real markdown bold
 * ("**مهم**") working while never touching maths notation ("2**3",
 * "2**3 + 4**2") and never stripping tanween or other diacritics, so
 * طالبٌ and طالبٍ stay distinct and saved questions stay exact.
 */
export function cleanAiOutputText(text: string): string {
  return text
    .replace(/\*\*([^*]*[A-Za-z\u0600-\u06FF][^*]*)\*\*/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

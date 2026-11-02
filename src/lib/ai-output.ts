/**
 * Small display cleanup for generated prose. Do not use on OCR/transcription
 * results, where punctuation and diacritics may be part of the source material.
 */
export function cleanAiOutputText(text: string): string {
  return text
    .replace(/\*\*/g, "")
    .replace(/[\u064B-\u064D]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

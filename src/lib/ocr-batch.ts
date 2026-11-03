/**
 * OCR batch chunking (client side).
 *
 * The server accepts at most 12,000,000 data-URL chars per ocrSourceImages
 * call, but the client only caps each image (a 2.9 MB compressed blob is
 * ~3.9M chars as a data URL). Four dense pages therefore pass every
 * per-image check and still fail the whole batch with INVALID_INPUT,
 * losing all pages at once. Chunking packs pages greedily under a budget
 * below the server cap, so a batch never trips the aggregate limit. The
 * server already OCRs each image with its own vision call, so splitting
 * changes nothing about the extracted text — only how many calls it takes.
 */

/** Safe per-call budget: under the server's 12,000,000-char cap. */
export const OCR_BATCH_CHAR_BUDGET = 11_000_000;
/** Server cap on images per call (mirrors source-ocr.ts MAX_IMAGES). */
export const OCR_BATCH_MAX_IMAGES = 5;

/**
 * Split data URLs into chunks, each within `budget` chars and at most
 * `maxImages` items. Order is preserved. A single item over budget goes
 * alone in its own chunk (the server then rejects it on its own, exactly
 * as it would today — compression keeps real pages far below this).
 */
export function chunkDataUrls(
  dataUrls: string[],
  budget: number = OCR_BATCH_CHAR_BUDGET,
  maxImages: number = OCR_BATCH_MAX_IMAGES,
): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentChars = 0;
  for (const url of dataUrls) {
    const len = url.length;
    if (current.length > 0 && (current.length >= maxImages || currentChars + len > budget)) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(url);
    currentChars += len;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

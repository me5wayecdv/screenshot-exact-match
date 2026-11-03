import { describe, expect, it } from "vitest";
import { chunkDataUrls, OCR_BATCH_CHAR_BUDGET, OCR_BATCH_MAX_IMAGES } from "@/lib/ocr-batch";

const url = (chars: number) => "x".repeat(chars);
/** A dense compressed page: 2.9 MB blob ≈ 3.9M chars as a data URL. */
const DENSE_PAGE = 3_900_000;

describe("chunkDataUrls", () => {
  it("returns no chunks for no images", () => {
    expect(chunkDataUrls([])).toEqual([]);
  });

  it("keeps small batches in a single chunk", () => {
    const urls = [url(100), url(200), url(300)];
    expect(chunkDataUrls(urls)).toEqual([urls]);
  });

  it("splits four dense pages so no chunk trips the server cap", () => {
    const urls = [url(DENSE_PAGE), url(DENSE_PAGE), url(DENSE_PAGE), url(DENSE_PAGE)];
    const chunks = chunkDataUrls(urls);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(2);
    expect(chunks[1]).toHaveLength(2);
    for (const chunk of chunks) {
      const total = chunk.reduce((sum, u) => sum + u.length, 0);
      expect(total).toBeLessThanOrEqual(OCR_BATCH_CHAR_BUDGET);
    }
    expect(chunks.flat()).toEqual(urls);
  });

  it("preserves order across chunks", () => {
    const urls = [url(6_000_000), url(6_000_000), url(6_000_000)];
    expect(chunkDataUrls(urls)).toEqual([[urls[0]], [urls[1]], [urls[2]]]);
  });

  it("packs greedily up to the budget, not one per chunk", () => {
    const urls = [url(5_000_000), url(5_000_000), url(1_000_000)];
    expect(chunkDataUrls(urls)).toEqual([[urls[0], urls[1], urls[2]]]);
  });

  it("puts a single oversize item alone instead of dropping it", () => {
    const urls = [url(100), url(OCR_BATCH_CHAR_BUDGET + 1), url(100)];
    expect(chunkDataUrls(urls)).toEqual([[urls[0]], [urls[1]], [urls[2]]]);
  });

  it("respects the per-call image cap even for tiny images", () => {
    const urls = Array.from({ length: OCR_BATCH_MAX_IMAGES + 2 }, () => url(10));
    const chunks = chunkDataUrls(urls);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(OCR_BATCH_MAX_IMAGES);
  });
});

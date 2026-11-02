import { describe, expect, it } from "vitest";
import { getRtlColumnCropBounds } from "@/lib/ocr-image-layout";

describe("Arabic OCR column crops", () => {
  it("returns five full-height strips from right to left", () => {
    const strips = Array.from({ length: 5 }, (_, index) => getRtlColumnCropBounds(index));
    expect(strips[0]?.right).toBe(1);
    expect(strips[4]?.left).toBe(0);
    expect(strips.every((strip) => strip.top === 0 && strip.bottom === 1)).toBe(true);
    for (let index = 1; index < strips.length; index++) {
      expect(strips[index - 1]!.left).toBeGreaterThan(strips[index]!.left);
    }
  });

  it("overlaps neighboring strips to preserve text at column boundaries", () => {
    const strips = Array.from({ length: 5 }, (_, index) => getRtlColumnCropBounds(index));
    for (let index = 1; index < strips.length; index++) {
      expect(strips[index]!.right).toBeGreaterThan(strips[index - 1]!.left);
    }
  });

  it("rejects invalid layout indexes", () => {
    expect(() => getRtlColumnCropBounds(-1)).toThrow(RangeError);
    expect(() => getRtlColumnCropBounds(5)).toThrow(RangeError);
    expect(() => getRtlColumnCropBounds(0, 9)).toThrow(RangeError);
  });
});

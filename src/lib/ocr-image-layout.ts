export type NormalizedImageBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

/**
 * Return one of equally sized vertical text columns in Arabic reading order.
 * Index 0 is the rightmost strip. A small overlap protects glyphs near
 * column boundaries and makes OCR less sensitive to uneven separators.
 */
export function getRtlColumnCropBounds(
  index: number,
  columnCount = 5,
  overlap = 0.04,
): NormalizedImageBounds {
  if (!Number.isInteger(columnCount) || columnCount < 1 || columnCount > 8) {
    throw new RangeError("columnCount must be an integer from 1 to 8.");
  }
  if (!Number.isInteger(index) || index < 0 || index >= columnCount) {
    throw new RangeError("index must identify a column in the requested layout.");
  }
  if (!Number.isFinite(overlap) || overlap < 0 || overlap >= 1 / columnCount) {
    throw new RangeError("overlap must be non-negative and smaller than a column.");
  }

  const width = 1 / columnCount;
  const halfOverlap = overlap / 2;
  return {
    left: Math.max(0, 1 - (index + 1) * width - (index > 0 ? halfOverlap : 0)),
    top: 0,
    right: Math.min(1, 1 - index * width + (index < columnCount - 1 ? halfOverlap : 0)),
    bottom: 1,
  };
}

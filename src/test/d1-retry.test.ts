import { describe, expect, it, vi } from "vitest";
import { isD1Overload, retryD1Overload } from "@/server/d1-retry";

describe("D1 overload retry", () => {
  it("recognizes only overload-shaped errors", () => {
    expect(
      isD1Overload(
        new Error("D1 DB is overloaded. Too many resources consumed within a 10 second window"),
      ),
    ).toBe(true);
    expect(isD1Overload(new Error("UNIQUE constraint failed"))).toBe(false);
  });

  it("retries transient overloads with bounded exponential delays", async () => {
    vi.useFakeTimers();
    try {
      const operation = vi
        .fn()
        .mockRejectedValueOnce(new Error("D1 DB is overloaded"))
        .mockRejectedValueOnce(new Error("D1 DB is overloaded"))
        .mockResolvedValue("ok");
      const result = retryD1Overload(operation);
      await vi.advanceTimersByTimeAsync(200);
      await vi.advanceTimersByTimeAsync(400);
      await expect(result).resolves.toBe("ok");
      expect(operation).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry non-overload errors", async () => {
    const operation = vi.fn().mockRejectedValue(new Error("FORBIDDEN"));
    await expect(retryD1Overload(operation)).rejects.toThrow("FORBIDDEN");
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

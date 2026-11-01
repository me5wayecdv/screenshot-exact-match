import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { consumeAiRateQuota } from "@/server/ai-usage";

describe("consumeAiRateQuota", () => {
  it("reserves the requested weighted units through the atomic RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    const client = { rpc } as unknown as SupabaseClient;
    await expect(consumeAiRateQuota(client, 7)).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith("consume_ai_rate_quota", { _units: 7 });
  });

  it("fails closed when the database denies or cannot enforce quota", async () => {
    const denied = { rpc: vi.fn().mockResolvedValue({ data: false, error: null }) };
    const failed = { rpc: vi.fn().mockResolvedValue({ data: null, error: new Error("offline") }) };
    const throws = { rpc: vi.fn().mockRejectedValue(new Error("offline")) };
    await expect(consumeAiRateQuota(denied as unknown as SupabaseClient)).resolves.toBe(false);
    await expect(consumeAiRateQuota(failed as unknown as SupabaseClient)).resolves.toBe(false);
    await expect(consumeAiRateQuota(throws as unknown as SupabaseClient)).resolves.toBe(false);
  });

  it("rejects invalid or unbounded weights before an RPC call", async () => {
    const rpc = vi.fn();
    const client = { rpc } as unknown as SupabaseClient;
    for (const units of [0, -1, 1.5, 21, Number.NaN]) {
      await expect(consumeAiRateQuota(client, units)).resolves.toBe(false);
    }
    expect(rpc).not.toHaveBeenCalled();
  });
});

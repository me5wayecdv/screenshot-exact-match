/**
 * Regression test for the staging sign-up/sign-in failure:
 * "Pbkdf2 failed: iteration counts above 100000 are not supported
 * (requested 600000)."
 *
 * Cloudflare Workers WebCrypto caps PBKDF2 at 100,000 iterations, so
 * the production default in src/lib/cloudflare-auth.ts must never
 * exceed it. If anyone raises PBKDF2_ITERATIONS above the cap, this
 * test fails in CI instead of sign-up/sign-in failing live on Workers.
 *
 * Backward compatibility is by design, not by migration: the stored
 * hash format carries its own iteration count
 * (`pbkdf2-sha256$<iterations>$<salt>$<hash>`) and verifyPassword
 * always derives with the stored count, so hashes created at any
 * older count (including test hashes at 1,000) still verify.
 */
import { describe, expect, it } from "vitest";
import { hashPassword, PBKDF2_ITERATIONS, verifyPassword } from "@/lib/cloudflare-auth";

describe("PBKDF2 production iterations (Workers cap)", () => {
  it("production default is within the Workers WebCrypto cap of 100,000", () => {
    expect(PBKDF2_ITERATIONS).toBeGreaterThan(0);
    expect(PBKDF2_ITERATIONS).toBeLessThanOrEqual(100_000);
  });

  it("a hash created with the production default verifies and embeds that count", async () => {
    const stored = await hashPassword("correct-horse-battery", PBKDF2_ITERATIONS);
    expect(stored.startsWith(`pbkdf2-sha256$${PBKDF2_ITERATIONS}$`)).toBe(true);
    expect(await verifyPassword("correct-horse-battery", stored)).toBe(true);
    expect(await verifyPassword("wrong-password", stored)).toBe(false);
  });

  it("verification follows the stored iteration count (older/test hashes still verify)", async () => {
    const stored = await hashPassword("correct-horse-battery", 1000);
    expect(stored.startsWith("pbkdf2-sha256$1000$")).toBe(true);
    expect(await verifyPassword("correct-horse-battery", stored)).toBe(true);
  });
});

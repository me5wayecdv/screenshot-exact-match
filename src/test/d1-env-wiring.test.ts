/**
 * Regression test for the staging D1_NOT_WIRED bug (2026-11-04).
 *
 * Root cause: src/server/d1.ts loaded `cloudflare:workers` through
 * `new Function("return import(...)")`, which workerd rejects with
 * "Code generation from strings disallowed for this context" — the
 * catch swallowed it into null, so every server function failed with
 * D1_NOT_WIRED despite deployed bindings. The fix is a static import
 * of `cloudflare:workers` (aliased to an empty-env stub under vitest).
 *
 * These tests prove the wiring contract around that fix: with no
 * injected binding and an empty (binding-less) env, accessors fail
 * loudly with *_NOT_WIRED; with an injected binding they return it.
 * They do not (and cannot, outside a Worker) prove the real env
 * object — that half is proven by the workerd reproduction and by
 * the staging redeploy smoke test.
 */
import { describe, expect, it } from "vitest";
import {
  getD1,
  getD1Async,
  getPapersBucket,
  getSourcesBucket,
  getWorkerEnv,
  setD1Binding,
  setR2Bindings,
} from "@/server/d1";
import type { D1Database } from "@/server/d1-auth-store";

const fakeDb = {
  prepare: () => {
    throw new Error("unused in wiring tests");
  },
} as unknown as D1Database;

describe("D1/R2 env wiring", () => {
  it("fails loudly with D1_NOT_WIRED when nothing is injected and env has no DB", async () => {
    setD1Binding(null);
    await expect(getD1Async()).rejects.toThrow("D1_NOT_WIRED");
    expect(() => getD1()).toThrow("D1_NOT_WIRED");
  });

  it("fails loudly with R2_*_NOT_WIRED when no buckets are injected", async () => {
    setR2Bindings({});
    await expect(getPapersBucket()).rejects.toThrow("R2_PAPERS_NOT_WIRED");
    await expect(getSourcesBucket()).rejects.toThrow("R2_SOURCES_NOT_WIRED");
  });

  it("returns the injected binding when one is set", async () => {
    try {
      setD1Binding(fakeDb);
      await expect(getD1Async()).resolves.toBe(fakeDb);
      expect(getD1()).toBe(fakeDb);
    } finally {
      setD1Binding(null);
    }
  });

  it("exposes a (binding-less, under vitest) worker env object instead of crashing on import", async () => {
    const env = await getWorkerEnv();
    expect(env).toBeTypeOf("object");
    expect(env?.DB).toBeUndefined();
  });
});

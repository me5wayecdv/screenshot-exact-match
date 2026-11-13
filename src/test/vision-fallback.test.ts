/**
 * Regression tests for Deep Audit AI-F7: Gemini 503 fallback existed
 * on only 1 of 3 vision paths (source-ocr, 503-only). handwritten.ts
 * and paper-matching.ts returned the Gemini error outright, and
 * source-ocr.ts fell back on 503 only.
 *
 * Coverage:
 *   - Shared helper (attemptGeminiVision, stubbed runGemini — no
 *     fetch, no timers): retryable set, success passthrough,
 *     non-retryable surfacing, transport throws, abort handling.
 *   - One wiring test per path (stubbed fetch, real runGeminiQuery):
 *     Gemini 503 → configured Workers AI vision model runs and its
 *     result is returned. Plus success → no fallback call and
 *     400 → error surfaces with no fallback call on the other paths.
 *
 * Gemini 503s are retried twice inside runGeminiQuery (1s + 2s
 * delays), so the 503 wiring tests use fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  attemptGeminiVision,
  isRetryableVisionFailure,
  visionUpstreamHttpStatus,
  type GeminiVisionResult,
} from "@/server/vision-fallback";
import { callVisionOcr as callHandwrittenVisionOcr } from "@/server/handwritten";
import { callVisionOcr as callSourceVisionOcr } from "@/server/source-ocr";
import { callVisionMatch } from "@/server/paper-matching";

const IMAGE = "data:image/jpeg;base64,/9j/abc123";
const CF_BASE_URL = "https://api.cloudflare.com/client/v4/accounts/test-acct/v1";
const CF_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const GEMINI = { apiKey: "test-key", model: "gemini-2.5-flash" };

function signal() {
  return new AbortController().signal;
}

function stubRunGemini(result: GeminiVisionResult | Error) {
  return vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
}

function mockFetchSequence(responses: Array<{ status: number; body: unknown }>) {
  const fetchMock = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("No mocked response remains.");
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers: new Headers(),
      body: null,
      text: async () => (typeof next.body === "string" ? next.body : JSON.stringify(next.body)),
      json: async () => next.body,
    } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const gemini503 = () => ({ status: 503, body: { error: { message: "busy" } } });
const geminiOk = (text: string) => ({
  status: 200,
  body: { candidates: [{ content: { parts: [{ text }] } }] },
});
const cloudflareNativeOk = (responseText: string) => ({
  status: 200,
  body: { success: true, result: { response: responseText } },
});

describe("isRetryableVisionFailure / visionUpstreamHttpStatus", () => {
  it("parses the HTTP status out of a runGeminiQuery failure message", () => {
    expect(visionUpstreamHttpStatus("Vision provider is temporarily unavailable (HTTP 503).")).toBe(
      503,
    );
    expect(visionUpstreamHttpStatus("Vision provider returned HTTP 400.")).toBe(400);
    expect(visionUpstreamHttpStatus("Vision provider request failed.")).toBeNull();
  });

  it.each([429, 500, 502, 503, 504])("treats VISION_UPSTREAM HTTP %s as retryable", (status) => {
    expect(
      isRetryableVisionFailure({
        code: "VISION_UPSTREAM",
        message: `Vision provider returned HTTP ${status}.`,
      }),
    ).toBe(true);
  });

  it.each([400, 401, 403, 404])("treats VISION_UPSTREAM HTTP %s as NOT retryable", (status) => {
    expect(
      isRetryableVisionFailure({
        code: "VISION_UPSTREAM",
        message: `Vision provider returned HTTP ${status}.`,
      }),
    ).toBe(false);
  });

  it("treats non-upstream codes as NOT retryable even with a 503 in the message", () => {
    expect(
      isRetryableVisionFailure({
        code: "VISION_PARSE_FAILED",
        message: "Vision provider returned no text (HTTP 503).",
      }),
    ).toBe(false);
    expect(
      isRetryableVisionFailure({ code: "VISION_TIMEOUT", message: "Vision provider timed out." }),
    ).toBe(false);
  });
});

describe("attemptGeminiVision (shared helper)", () => {
  it("passes Gemini success through untouched", async () => {
    const runGemini = stubRunGemini({
      ok: true,
      text: "hello",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const attempt = await attemptGeminiVision({
      gemini: GEMINI,
      signal: signal(),
      imageDataUrl: IMAGE,
      prompt: "Transcribe.",
      runGemini,
    });
    expect(attempt).toEqual({
      outcome: "gemini",
      text: "hello",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(runGemini).toHaveBeenCalledWith(
      "test-key",
      "gemini-2.5-flash",
      expect.anything(),
      IMAGE,
      "Transcribe.",
    );
  });

  it.each([429, 500, 502, 503, 504])(
    "returns fallback for transient VISION_UPSTREAM HTTP %s",
    async (status) => {
      const attempt = await attemptGeminiVision({
        gemini: GEMINI,
        signal: signal(),
        imageDataUrl: IMAGE,
        prompt: "Transcribe.",
        runGemini: stubRunGemini({
          ok: false,
          code: "VISION_UPSTREAM",
          message:
            status === 503
              ? "Vision provider is temporarily unavailable (HTTP 503)."
              : `Vision provider returned HTTP ${status}.`,
        }),
      });
      expect(attempt).toEqual({ outcome: "fallback" });
    },
  );

  it("surfaces a 400 as an error without falling back", async () => {
    const attempt = await attemptGeminiVision({
      gemini: GEMINI,
      signal: signal(),
      imageDataUrl: IMAGE,
      prompt: "Transcribe.",
      runGemini: stubRunGemini({
        ok: false,
        code: "VISION_UPSTREAM",
        message: "Vision provider returned HTTP 400.",
      }),
    });
    expect(attempt).toEqual({
      outcome: "error",
      code: "VISION_UPSTREAM",
      message: "Vision provider returned HTTP 400.",
    });
  });

  it("surfaces an empty Gemini reply as an error without falling back", async () => {
    const attempt = await attemptGeminiVision({
      gemini: GEMINI,
      signal: signal(),
      imageDataUrl: IMAGE,
      prompt: "Transcribe.",
      runGemini: stubRunGemini({
        ok: false,
        code: "VISION_PARSE_FAILED",
        message: "Vision provider returned no text.",
      }),
    });
    expect(attempt).toEqual({
      outcome: "error",
      code: "VISION_PARSE_FAILED",
      message: "Vision provider returned no text.",
    });
  });

  it("falls back on a transport throw reaching Gemini", async () => {
    const attempt = await attemptGeminiVision({
      gemini: GEMINI,
      signal: signal(),
      imageDataUrl: IMAGE,
      prompt: "Transcribe.",
      runGemini: stubRunGemini(new TypeError("fetch failed")),
    });
    expect(attempt).toEqual({ outcome: "fallback" });
  });

  it("surfaces an abort as a timeout error without falling back", async () => {
    // What fetch actually throws on abort: an error named AbortError
    // (a DOMException in browsers). The helper classifies by name,
    // mirroring the call sites' own AbortError checks.
    const abortError = new Error("The operation was aborted.");
    abortError.name = "AbortError";
    const attempt = await attemptGeminiVision({
      gemini: GEMINI,
      signal: signal(),
      imageDataUrl: IMAGE,
      prompt: "Transcribe.",
      runGemini: stubRunGemini(abortError),
    });
    expect(attempt).toEqual({
      outcome: "error",
      code: "VISION_TIMEOUT",
      message: "Vision provider timed out.",
    });
  });
});

describe("vision fallback wiring (stubbed fetch, real runGeminiQuery)", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved["VISION_PROVIDER"] = process.env["VISION_PROVIDER"];
    saved["GEMINI_API_KEY"] = process.env["GEMINI_API_KEY"];
    saved["GEMINI_MODEL"] = process.env["GEMINI_MODEL"];
    process.env["VISION_PROVIDER"] = "gemini";
    process.env["GEMINI_API_KEY"] = "test-key";
    delete process.env["GEMINI_MODEL"];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("handwritten OCR: Gemini 503 falls back to the configured Workers AI model", async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetchSequence([
      gemini503(),
      gemini503(),
      gemini503(),
      cloudflareNativeOk("fallback transcription"),
    ]);
    const promise = callHandwrittenVisionOcr(
      { baseUrl: CF_BASE_URL, model: CF_MODEL, apiKey: "cf-key", visionModelExplicit: true },
      IMAGE,
    );
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({
      ok: true,
      text: "fallback transcription",
      provider: "cloudflare-native",
      model: CF_MODEL,
      usage: { inputTokens: null, outputTokens: null },
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const lastUrl = (fetchMock.mock.calls[3] as unknown as [string])[0];
    expect(lastUrl).toBe(
      "https://api.cloudflare.com/client/v4/accounts/test-acct/run/@cf/meta/llama-3.2-11b-vision-instruct",
    );
  });

  it("handwritten OCR: Gemini success does NOT call the fallback", async () => {
    const fetchMock = mockFetchSequence([geminiOk("gemini transcription")]);
    const result = await callHandwrittenVisionOcr(
      { baseUrl: CF_BASE_URL, model: CF_MODEL, apiKey: "cf-key", visionModelExplicit: true },
      IMAGE,
    );
    expect(result).toEqual({
      ok: true,
      text: "gemini transcription",
      provider: "gemini",
      model: "gemini-2.5-flash",
      usage: { inputTokens: null, outputTokens: null },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("handwritten OCR: Gemini 400 surfaces the error with NO fallback call", async () => {
    const fetchMock = mockFetchSequence([{ status: 400, body: { error: { message: "bad key" } } }]);
    const result = await callHandwrittenVisionOcr(
      { baseUrl: CF_BASE_URL, model: CF_MODEL, apiKey: "cf-key", visionModelExplicit: true },
      IMAGE,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("VISION_UPSTREAM");
      expect(result.message).toContain("400");
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("source OCR: Gemini 503 falls back to the configured Workers AI model", async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetchSequence([
      gemini503(),
      gemini503(),
      gemini503(),
      cloudflareNativeOk("source fallback text"),
    ]);
    const promise = callSourceVisionOcr(CF_BASE_URL, CF_MODEL, "cf-key", IMAGE);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({
      ok: true,
      text: "source fallback text",
      provider: "cloudflare-native",
      model: CF_MODEL,
      usage: { inputTokens: null, outputTokens: null },
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("source OCR: Gemini 500 (not just 503) also falls back", async () => {
    // runGeminiQuery retries 503 only, so a 500 answers after one fetch.
    const fetchMock = mockFetchSequence([
      { status: 500, body: { error: { message: "internal" } } },
      cloudflareNativeOk("source fallback after 500"),
    ]);
    const result = await callSourceVisionOcr(CF_BASE_URL, CF_MODEL, "cf-key", IMAGE);
    expect(result).toEqual({
      ok: true,
      text: "source fallback after 500",
      provider: "cloudflare-native",
      model: CF_MODEL,
      usage: { inputTokens: null, outputTokens: null },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("source OCR: Gemini 400 surfaces the error with NO fallback call", async () => {
    const fetchMock = mockFetchSequence([{ status: 400, body: { error: { message: "bad key" } } }]);
    const result = await callSourceVisionOcr(CF_BASE_URL, CF_MODEL, "cf-key", IMAGE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("VISION_UPSTREAM");
      expect(result.message).toContain("400");
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("paper matching: Gemini 503 falls back and the fallback reply is match-parsed", async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetchSequence([
      gemini503(),
      gemini503(),
      gemini503(),
      cloudflareNativeOk('{"text": "matched answer", "question_number": 2}'),
    ]);
    const promise = callVisionMatch(CF_BASE_URL, CF_MODEL, "cf-key", IMAGE);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({
      ok: true,
      text: "matched answer",
      questionNumber: 2,
      provider: "cloudflare-native",
      model: CF_MODEL,
      usage: { inputTokens: null, outputTokens: null },
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("paper matching: Gemini success does NOT call the fallback", async () => {
    const fetchMock = mockFetchSequence([
      geminiOk('{"text": "gemini answer", "question_number": 3}'),
    ]);
    const result = await callVisionMatch(CF_BASE_URL, CF_MODEL, "cf-key", IMAGE);
    expect(result).toEqual({
      ok: true,
      text: "gemini answer",
      questionNumber: 3,
      provider: "gemini",
      model: "gemini-2.5-flash",
      usage: { inputTokens: null, outputTokens: null },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

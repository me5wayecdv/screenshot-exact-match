import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveGeminiConfig, runGeminiQuery } from "@/server/handwritten";

const IMAGE_JPEG = "data:image/jpeg;base64,/9j/abc123";
const IMAGE_PNG = "data:image/png;base64,iVBORw0KGgo=";
const PROMPT = "Transcribe everything.";

function mockFetch(ok: boolean, body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => ({
    ok,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => body,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mockFetchSequence(responses: Array<{ status: number; body: unknown }>) {
  const fetchMock = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("No mocked Gemini response remains.");
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers: new Headers(),
      body: null,
      text: async () =>
        typeof next.body === "string" ? next.body : JSON.stringify(next.body),
      json: async () => next.body,
    } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function signal() {
  return new AbortController().signal;
}

describe("runGeminiQuery request shape", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("posts base64 inline data with the prompt to the generateContent endpoint", async () => {
    const fetchMock = mockFetch(true, {
      candidates: [{ content: { parts: [{ text: "hello" }] } }],
    });
    const result = await runGeminiQuery(
      "test-key",
      "gemini-2.5-flash",
      signal(),
      IMAGE_JPEG,
      PROMPT,
    );
    expect(result).toEqual({
      ok: true,
      text: "hello",
      usage: { inputTokens: null, outputTokens: null },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-key");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    const body = JSON.parse(init.body as string) as {
      contents: Array<{
        parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>;
      }>;
      generationConfig: { maxOutputTokens: number; temperature: number };
    };
    expect(body.contents[0]!.parts[0]!.text).toBe(PROMPT);
    // Base64 without the data-URL prefix, mime type from the prefix.
    expect(body.contents[0]!.parts[1]!.inlineData).toEqual({
      mimeType: "image/jpeg",
      data: "/9j/abc123",
    });
    expect(body.generationConfig).toEqual({ maxOutputTokens: 8192, temperature: 0 });
  });

  it("takes the mime type from the data-URL prefix", async () => {
    const fetchMock = mockFetch(true, {
      candidates: [{ content: { parts: [{ text: "x" }] } }],
    });
    await runGeminiQuery("test-key", "gemini-2.5-flash", signal(), IMAGE_PNG, PROMPT);
    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      contents: Array<{ parts: Array<{ inlineData?: { mimeType: string; data: string } }> }>;
    };
    expect(body.contents[0]!.parts[1]!.inlineData).toEqual({
      mimeType: "image/png",
      data: "iVBORw0KGgo=",
    });
  });

  it("joins text across response parts", async () => {
    mockFetch(true, {
      candidates: [{ content: { parts: [{ text: "first " }, { text: "second" }] } }],
    });
    const result = await runGeminiQuery(
      "test-key",
      "gemini-2.5-flash",
      signal(),
      IMAGE_JPEG,
      PROMPT,
    );
    expect(result).toEqual({
      ok: true,
      text: "first second",
      usage: { inputTokens: null, outputTokens: null },
    });
  });

  it("retries transient Gemini 503 responses before returning OCR text", async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetchSequence([
      {
        status: 503,
        body: { error: { status: "UNAVAILABLE", message: "high demand" } },
      },
      {
        status: 200,
        body: { candidates: [{ content: { parts: [{ text: "recovered" }] } }] },
      },
    ]);

    const resultPromise = runGeminiQuery(
      "test-key",
      "gemini-2.5-flash",
      signal(),
      IMAGE_JPEG,
      PROMPT,
    );
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toEqual({
      ok: true,
      text: "recovered",
      usage: { inputTokens: null, outputTokens: null },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops retrying after two transient Gemini 503 retries", async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetchSequence([
      { status: 503, body: { error: { message: "busy 1" } } },
      { status: 503, body: { error: { message: "busy 2" } } },
      { status: 503, body: { error: { message: "still busy" } } },
    ]);

    const resultPromise = runGeminiQuery(
      "test-key",
      "gemini-2.5-flash",
      signal(),
      IMAGE_JPEG,
      PROMPT,
    );
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("503");
      expect(result.message).not.toContain("still busy");
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("maps a non-OK response to VISION_UPSTREAM", async () => {
    mockFetch(false, { error: { message: "bad key" } }, 400);
    const result = await runGeminiQuery(
      "bad-key",
      "gemini-2.5-flash",
      signal(),
      IMAGE_JPEG,
      PROMPT,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("VISION_UPSTREAM");
      expect(result.message).toContain("400");
    }
  });

  it("maps empty candidates to VISION_PARSE_FAILED", async () => {
    mockFetch(true, { candidates: [] });
    const result = await runGeminiQuery(
      "test-key",
      "gemini-2.5-flash",
      signal(),
      IMAGE_JPEG,
      PROMPT,
    );
    expect(result).toEqual({
      ok: false,
      code: "VISION_PARSE_FAILED",
      message: "Vision provider returned no text.",
    });
  });
});

describe("resolveGeminiConfig gating", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved["VISION_PROVIDER"] = process.env["VISION_PROVIDER"];
    saved["GEMINI_API_KEY"] = process.env["GEMINI_API_KEY"];
    saved["GEMINI_MODEL"] = process.env["GEMINI_MODEL"];
    delete process.env["VISION_PROVIDER"];
    delete process.env["GEMINI_API_KEY"];
    delete process.env["GEMINI_MODEL"];
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("returns null without a key or without VISION_PROVIDER=gemini", () => {
    expect(resolveGeminiConfig()).toBeNull();
    process.env["GEMINI_API_KEY"] = "test-key";
    expect(resolveGeminiConfig()).toBeNull();
    delete process.env["GEMINI_API_KEY"];
    process.env["VISION_PROVIDER"] = "gemini";
    expect(resolveGeminiConfig()).toBeNull();
  });

  it("defaults to gemini-2.5-flash and honors GEMINI_MODEL", () => {
    process.env["VISION_PROVIDER"] = "gemini";
    process.env["GEMINI_API_KEY"] = "test-key";
    expect(resolveGeminiConfig()).toEqual({ apiKey: "test-key", model: "gemini-2.5-flash" });
    process.env["GEMINI_MODEL"] = "gemini-2.5-pro";
    expect(resolveGeminiConfig()).toEqual({ apiKey: "test-key", model: "gemini-2.5-pro" });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { runGeminiQuery } from "@/server/handwritten";
import {
  extractGeminiUsage,
  extractOpenAiUsage,
  openAiProvider,
} from "@/server/ai-usage";

describe("extractOpenAiUsage", () => {
  it("reads prompt_tokens and completion_tokens", () => {
    expect(
      extractOpenAiUsage({
        usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 },
      }),
    ).toEqual({ inputTokens: 120, outputTokens: 45 });
  });

  it("derives input from total minus completion when prompt_tokens is absent", () => {
    expect(extractOpenAiUsage({ usage: { completion_tokens: 45, total_tokens: 165 } })).toEqual({
      inputTokens: 120,
      outputTokens: 45,
    });
  });

  it("returns NULLs when usage is absent or non-numeric", () => {
    expect(extractOpenAiUsage({})).toEqual({ inputTokens: null, outputTokens: null });
    expect(
      extractOpenAiUsage({ usage: { prompt_tokens: "120", completion_tokens: null } }),
    ).toEqual({
      inputTokens: null,
      outputTokens: null,
    });
  });

  it("does not derive a negative input when total is smaller than completion", () => {
    expect(extractOpenAiUsage({ usage: { completion_tokens: 50, total_tokens: 40 } })).toEqual({
      inputTokens: null,
      outputTokens: 50,
    });
  });

  it("returns NULLs for a native-run shaped payload, which carries no usage", () => {
    expect(extractOpenAiUsage({ success: true, result: { response: "transcribed" } })).toEqual({
      inputTokens: null,
      outputTokens: null,
    });
  });
});

describe("extractGeminiUsage", () => {
  it("reads promptTokenCount and candidatesTokenCount from usageMetadata", () => {
    expect(
      extractGeminiUsage({ usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 80 } }),
    ).toEqual({ inputTokens: 300, outputTokens: 80 });
  });

  it("returns NULLs when usageMetadata is absent or partial", () => {
    expect(extractGeminiUsage({})).toEqual({ inputTokens: null, outputTokens: null });
    expect(extractGeminiUsage({ usageMetadata: { promptTokenCount: 300 } })).toEqual({
      inputTokens: 300,
      outputTokens: null,
    });
    expect(extractGeminiUsage({ usageMetadata: { promptTokenCount: "300" } })).toEqual({
      inputTokens: null,
      outputTokens: null,
    });
  });
});

describe("openAiProvider", () => {
  it("labels Cloudflare endpoints distinctly from generic compatible ones", () => {
    expect(openAiProvider("https://api.cloudflare.com/client/v4/accounts/x/ai/v1")).toBe(
      "cloudflare-openai",
    );
    expect(openAiProvider("http://localhost:11434/v1")).toBe("openai-compatible");
  });
});

describe("runGeminiQuery usage passthrough", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns usageMetadata token counts on the ok result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "hello" }] } }],
          usageMetadata: { promptTokenCount: 321, candidatesTokenCount: 54 },
        }),
      })),
    );
    const result = await runGeminiQuery(
      "test-key",
      "gemini-2.5-flash",
      new AbortController().signal,
      "data:image/jpeg;base64,/9j/abc123",
      "Transcribe everything.",
    );
    expect(result).toEqual({
      ok: true,
      text: "hello",
      usage: { inputTokens: 321, outputTokens: 54 },
    });
  });
});


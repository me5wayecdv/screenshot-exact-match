/**
 * Provider usage parsing shared by D1-backed AI flows.
 * Persistence and quota enforcement live in src/server/d1-quota.ts.
 */

export type AiTokenUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
};

const NULL_USAGE: AiTokenUsage = { inputTokens: null, outputTokens: null };

function asTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * OpenAI-compatible usage: { prompt_tokens, completion_tokens,
 * total_tokens }. prompt_tokens wins; when a provider reports only
 * total + completion, input is derived only when the arithmetic is sane.
 */
export function extractOpenAiUsage(payload: unknown): AiTokenUsage {
  const usage = asRecord(asRecord(payload)?.["usage"]);
  if (!usage) return { ...NULL_USAGE };
  const outputTokens = asTokenCount(usage["completion_tokens"]);
  let inputTokens = asTokenCount(usage["prompt_tokens"]);
  if (inputTokens === null) {
    const total = asTokenCount(usage["total_tokens"]);
    if (total !== null && outputTokens !== null && total >= outputTokens) {
      inputTokens = total - outputTokens;
    }
  }
  return { inputTokens, outputTokens };
}

/**
 * Gemini generateContent usageMetadata: { promptTokenCount,
 * candidatesTokenCount }. Absent fields stay NULL — never guessed.
 */
export function extractGeminiUsage(payload: unknown): AiTokenUsage {
  const meta = asRecord(asRecord(payload)?.["usageMetadata"]);
  if (!meta) return { ...NULL_USAGE };
  return {
    inputTokens: asTokenCount(meta["promptTokenCount"]),
    outputTokens: asTokenCount(meta["candidatesTokenCount"]),
  };
}

/** Provider label for OpenAI-compatible text calls. */
export function openAiProvider(baseUrl: string): string {
  return baseUrl.includes("api.cloudflare.com") ? "cloudflare-openai" : "openai-compatible";
}

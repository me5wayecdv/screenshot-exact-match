/**
 * AI usage measurement helpers.
 *
 * Billable call sites reserve weighted quota atomically through
 * src/server/d1-quota.ts (consumeAiQuota) before contacting a provider,
 * and log one row into the D1 ai_usage_events table with the acting
 * user's id, the kind of call, the provider/model actually used, and the
 * token counts the provider reported (NULL when the provider reports
 * none, e.g. Cloudflare native run responses). Nothing in the product
 * reads this table for limits or pricing; it exists so real unit cost
 * per teacher can be measured before tiers are locked.
 *
 * The Supabase era of this module (the client-based usage sink and the
 * consume_ai_rate_quota RPC) is gone: every call site now uses the D1
 * equivalents, so the dead Supabase exports were removed rather than
 * left to rot.
 */

export type AiUsageKind = "grade" | "generate" | "ocr" | "match" | "tutor" | "assistant";

export type AiTokenUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
};

export type AiUsageEvent = {
  kind: AiUsageKind;
  provider: string;
  model: string;
  usage: AiTokenUsage;
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
 * total + completion, input is derived (total = prompt + completion
 * under OpenAI semantics) only when the arithmetic is sane.
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

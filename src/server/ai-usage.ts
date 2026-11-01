/**
 * AI usage controls and measurement.
 *
 * Billable call sites reserve weighted quota atomically through
 * consume_ai_rate_quota before contacting a provider. Calls also log one
 * row into public.ai_usage_events with the
 * acting user's id, the kind of call, the provider/model actually used,
 * and the token counts the provider reported (NULL when the provider
 * reports none, e.g. Cloudflare native run responses). Nothing in the
 * product reads this table for limits or pricing; it exists so real
 * unit cost per teacher can be measured before tiers are locked.
 *
 * Logging is best-effort by construction: logAiUsage swallows every
 * error (bad env, network failure, RLS rejection) and never throws, so
 * a measurement failure can never fail a user-facing AI call. Call
 * sites await it (one small indexed insert) rather than floating it,
 * so the row is not lost when a Worker invocation ends.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

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

/** Everything a call site needs to attribute one call to its caller. */
export type AiUsageSink = {
  client: SupabaseClient;
  teacherId: string;
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

/** User-token client for logging, mirroring the authorize() call sites. */
export function createUsageClient(
  url: string,
  anonKey: string,
  accessToken: string,
): SupabaseClient {
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Atomically reserve weighted quota before a billable provider request.
 * Fail closed when the RPC is unavailable; the upstream AI must not run.
 */
export async function consumeAiRateQuota(client: SupabaseClient, units = 1): Promise<boolean> {
  try {
    if (!Number.isInteger(units) || units < 1 || units > 20) return false;
    const { data, error } = await client.rpc("consume_ai_rate_quota", { _units: units });
    return !error && data === true;
  } catch {
    // Fail closed: never call a billable provider when quota enforcement is unavailable.
    return false;
  }
}

export async function logAiUsage(
  client: SupabaseClient,
  teacherId: string,
  event: AiUsageEvent,
): Promise<void> {
  try {
    if (!teacherId) return;
    await client.from("ai_usage_events").insert({
      teacher_id: teacherId,
      kind: event.kind,
      provider: event.provider,
      model: event.model,
      input_tokens: event.usage.inputTokens,
      output_tokens: event.usage.outputTokens,
    });
  } catch {
    // Measurement only: never fail the user-facing call.
  }
}

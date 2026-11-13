/**
 * Shared Gemini → Workers AI vision fallback (Deep Audit AI-F7).
 *
 * Before this module, only source-ocr.ts fell back to the configured
 * Workers AI vision model when Gemini failed — and only on HTTP 503.
 * handwritten.ts and paper-matching.ts returned the Gemini error
 * outright (`if (!g.ok) return g;`), so a single-provider outage
 * failed the OCR even though a configured fallback model existed.
 *
 * All three vision paths now go through attemptGeminiVision() and
 * fall through to their existing configured-model code when it
 * returns `{ outcome: "fallback" }`. The fallback itself is NOT
 * re-implemented here: each call site keeps its own Cloudflare
 * native / OpenAI-compatible path (LLaVA, Moondream, Llama vision),
 * so provider/model plumbing (VISION_PROVIDER, GEMINI_API_KEY,
 * AI_VISION_MODEL) is unchanged and Gemini stays the primary.
 *
 * Retryable set — fall back only when the failure is plausibly
 * transient and the fallback model could succeed:
 *   - VISION_UPSTREAM with HTTP 429 / 500 / 502 / 503 / 504.
 *     (runGeminiQuery already retries 503 twice internally; this
 *     fires only after those retries are exhausted.)
 *   - A transport throw reaching Gemini (DNS/TLS/reset). The
 *     configured Workers AI endpoint is independent, so it may
 *     still be reachable.
 * Deliberately NOT retryable (error surfaces, no fallback call):
 *   - 400 / 401 / 403 and any other non-listed status: an auth or
 *     request error the fallback model would not fix, and falling
 *     back would hide a misconfiguration.
 *   - VISION_PARSE_FAILED (Gemini answered but with no text) and
 *     VISION_TIMEOUT (the caller's abort already fired — a fallback
 *     fetch on the same aborted signal could not run either).
 */

import type { AiTokenUsage } from "./ai-usage";
import type { GeminiConfig, OcrErrorCode } from "./handwritten";

/** Gemini vision result shape, as returned by runGeminiQuery. */
export type GeminiVisionResult =
  | { ok: true; text: string; usage: AiTokenUsage }
  | { ok: false; code: OcrErrorCode; message: string };

/** Injectable Gemini call — runGeminiQuery from ./handwritten in
 *  production; a stub in tests. Kept structural (not `typeof
 *  runGeminiQuery`) so this module has no runtime import from
 *  ./handwritten and cannot form an import cycle with it. */
export type GeminiVisionCall = (
  apiKey: string,
  model: string,
  signal: AbortSignal,
  imageDataUrl: string,
  prompt: string,
) => Promise<GeminiVisionResult>;

/** Transient upstream statuses worth falling back on. */
export const RETRYABLE_VISION_HTTP_STATUSES = [429, 500, 502, 503, 504] as const;

/** HTTP status embedded in a runGeminiQuery failure message
 *  ("... (HTTP 503)." / "Vision provider returned HTTP 400."), or
 *  null when the message carries no status. */
export function visionUpstreamHttpStatus(message: string): number | null {
  const match = /HTTP (\d{3})/.exec(message);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

/** True only for a transient upstream failure (see module header). */
export function isRetryableVisionFailure(failure: {
  code: OcrErrorCode;
  message: string;
}): boolean {
  if (failure.code !== "VISION_UPSTREAM") return false;
  const status = visionUpstreamHttpStatus(failure.message);
  return status !== null && (RETRYABLE_VISION_HTTP_STATUSES as readonly number[]).includes(status);
}

export type GeminiVisionAttempt =
  /** Gemini answered: use its text (provider "gemini"). */
  | { outcome: "gemini"; text: string; usage: AiTokenUsage }
  /** Retryable Gemini failure: run the configured fallback vision
   *  model (the call site's existing Cloudflare path). */
  | { outcome: "fallback" }
  /** Non-retryable Gemini failure: surface this error, do not fall back. */
  | { outcome: "error"; code: OcrErrorCode; message: string };

/** One Gemini vision attempt, classified for the caller. Never throws
 *  for provider failures; an AbortError surfaces as a VISION_TIMEOUT
 *  error outcome (the caller's signal is already aborted, so a
 *  fallback fetch could not run). */
export async function attemptGeminiVision(args: {
  gemini: GeminiConfig;
  signal: AbortSignal;
  imageDataUrl: string;
  prompt: string;
  runGemini: GeminiVisionCall;
}): Promise<GeminiVisionAttempt> {
  let result: GeminiVisionResult;
  try {
    result = await args.runGemini(
      args.gemini.apiKey,
      args.gemini.model,
      args.signal,
      args.imageDataUrl,
      args.prompt,
    );
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        outcome: "error",
        code: "VISION_TIMEOUT",
        message: "Vision provider timed out.",
      };
    }
    // Transport failure reaching Gemini (DNS/TLS/connection reset):
    // transient, and the fallback endpoint is independent.
    return { outcome: "fallback" };
  }
  if (result.ok) return { outcome: "gemini", text: result.text, usage: result.usage };
  if (isRetryableVisionFailure(result)) return { outcome: "fallback" };
  return { outcome: "error", code: result.code, message: result.message };
}

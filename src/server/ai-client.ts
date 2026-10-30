/**
 * Server-only provider-agnostic chat client for AI grading suggestions.
 *
 * The client speaks plain OpenAI-compatible POST /chat/completions — no
 * provider-specific SDK, no provider hardcoded anywhere. Point it at any
 * compatible provider with three server env vars (see docs/ai-models.md
 * for free/open options: OpenRouter free tier, Groq free tier, Hugging
 * Face Inference, or self-hosted Ollama):
 *   AI_BASE_URL  (required)  Base URL of the OpenAI-compatible API,
 *                             e.g. http://host:11434/v1 for Ollama.
 *   AI_MODEL     (required)  Model name, as the provider expects it.
 *                             No default is hardcoded: the deployer picks
 *                             the model via env, so a free/open model can
 *                             be used without a code change.
 *   AI_API_KEY   (required for hosted providers; optional for local
 *                 endpoints)  API key, sent as a Bearer token when set.
 *                 A self-hosted endpoint without auth works with the key
 *                 unset or set to any dummy value — no Authorization
 *                 header is sent when it is empty.
 *
 * Configuration is server environment ONLY — never expose these to the
 * client, never put them in a VITE_ variable, never hardcode a key.
 *
 * This file must only be imported from server code (src/server/ai-grade.ts).
 * It is never imported by a client component, so the key never reaches the
 * browser bundle.
 */

import { buildAiGradingPrompt, type AiGradingPromptInput } from "./ai-grading-prompt";
import { resolveAiConfig } from "./ai-config";
import { extractOpenAiUsage, logAiUsage, openAiProvider, type AiUsageSink } from "./ai-usage";

export type AiConfidence = "high" | "medium" | "low";

export type AiGradeSuggestion = {
  /** Suggested score, already clamped to [0, maxMarks]. */
  suggestedScore: number;
  /** Short Arabic feedback from the model. */
  feedback: string;
  confidence: AiConfidence;
};

export type AiClientError = {
  code: "AI_NOT_CONFIGURED" | "AI_ERROR";
  message: string;
};

function clampScore(value: number, maxMarks: number): number {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value * 100) / 100;
  return Math.min(Math.max(rounded, 0), maxMarks);
}

/** Tolerate models that wrap the JSON in ```json fences or extra prose. */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Model response did not contain a JSON object.");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

function parseSuggestion(raw: unknown, maxMarks: number): AiGradeSuggestion {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Model response was not a JSON object.");
  }
  const obj = raw as Record<string, unknown>;
  const scoreRaw = obj["suggested_score"] ?? obj["score"];
  const score = typeof scoreRaw === "number" ? scoreRaw : Number(scoreRaw);
  if (!Number.isFinite(score)) {
    throw new Error("Model response had no usable suggested_score.");
  }
  const feedback =
    typeof obj["feedback"] === "string"
      ? obj["feedback"]
      : typeof obj["explanation"] === "string"
        ? obj["explanation"]
        : "";
  const confidenceRaw = obj["confidence"];
  const confidence: AiConfidence =
    confidenceRaw === "high" || confidenceRaw === "low" ? confidenceRaw : "medium";
  return { suggestedScore: clampScore(score, maxMarks), feedback, confidence };
}

/**
 * Ask the provider for one grading suggestion. Returns a discriminated
 * result instead of throwing for expected failures, so the UI can show a
 * distinct "AI not configured" state rather than a generic error.
 * When `usage` is supplied, a successful call is logged for pilot cost
 * measurement (best-effort: logging never fails the suggestion).
 */
export async function suggestGradeWithAi(
  input: AiGradingPromptInput,
  usage?: AiUsageSink,
): Promise<{ ok: true; suggestion: AiGradeSuggestion } | { ok: false; error: AiClientError }> {
  const config = resolveAiConfig();
  if (!config) {
    return {
      ok: false,
      error: {
        code: "AI_NOT_CONFIGURED",
        message:
          "AI provider is not configured on the server (set AI_BASE_URL and AI_MODEL, plus AI_API_KEY for hosted providers).",
      },
    };
  }

  const { system, user } = buildAiGradingPrompt(input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    // No Authorization header when the key is empty (local endpoints
    // without auth, e.g. Ollama). No response_format is requested: it is
    // OpenAI-specific and would break other compatible endpoints; the
    // prompt demands JSON-only output and extractJson() tolerates fences.
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (config.apiKey) headers["authorization"] = `Bearer ${config.apiKey}`;
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers,
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) {
      // Do not leak the provider's body (it may echo request details).
      return {
        ok: false,
        error: {
          code: "AI_ERROR",
          message: `AI provider returned HTTP ${res.status}.`,
        },
      };
    }
    const payload = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
      usage?: unknown;
    };
    const content = payload.choices?.[0]?.message?.content ?? "";
    if (!content) {
      return {
        ok: false,
        error: { code: "AI_ERROR", message: "AI provider returned an empty response." },
      };
    }
    const suggestion = parseSuggestion(extractJson(content), input.maxMarks);
    if (usage) {
      await logAiUsage(usage.client, usage.teacherId, {
        kind: "grade",
        provider: openAiProvider(config.baseUrl),
        model: config.model,
        usage: extractOpenAiUsage(payload),
      });
    }
    return { ok: true, suggestion };
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "AI request timed out."
        : "AI request failed.";
    return { ok: false, error: { code: "AI_ERROR", message } };
  } finally {
    clearTimeout(timeout);
  }
}

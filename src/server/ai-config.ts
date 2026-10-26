/**
 * Shared provider-agnostic AI configuration (USP slices 1 + 2).
 *
 * The server speaks plain OpenAI-compatible POST /chat/completions — no
 * provider-specific SDK, no provider or model hardcoded. Both AI features
 * (grading suggestions, assessment generation) resolve their config here
 * so the env semantics can never drift between slices. See
 * docs/ai-models.md for free/open provider options.
 *
 * Server env only (never VITE_, never in the client bundle):
 *   AI_BASE_URL  (required)  Base URL of an OpenAI-compatible API.
 *   AI_MODEL     (required)  Model name, as the provider expects it.
 *   AI_API_KEY   (required for hosted providers; optional for local
 *                 endpoints)  Sent as a Bearer token when set. A local
 *                 endpoint without auth works with the key unset or set
 *                 to any dummy value — no Authorization header is sent
 *                 when it is empty.
 *
 * A provider counts as configured when a base URL and a model are set AND
 * either an API key is set OR the base URL is a local endpoint
 * (localhost / loopback). Hosted providers without a key are NOT
 * configured — callers surface the "AI not configured" state.
 */

/** Provider configuration, resolved from server env only. */
export type AiConfig = {
  baseUrl: string;
  model: string;
  apiKey: string;
};

export function isLocalBaseUrl(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "[::1]" ||
      host === "::1" ||
      host.startsWith("127.") ||
      host.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

export function resolveAiConfig(): AiConfig | null {
  const baseUrl = process.env.AI_BASE_URL?.trim().replace(/\/+$/, "");
  const model = process.env.AI_MODEL?.trim();
  const apiKey = process.env.AI_API_KEY?.trim() ?? "";
  if (!baseUrl || !model) return null;
  if (!apiKey && !isLocalBaseUrl(baseUrl)) return null;
  return { baseUrl, model, apiKey };
}

export function isAiConfigured(): boolean {
  return resolveAiConfig() !== null;
}

/** Optional operational ledger, no user IDs, prompts, replies or credentials.
 * Inactive until explicitly enabled AFTER its additive migration. Unknown
 * usage stays NULL, never zero or an invented dollar estimate.
 */
import { getD1Async } from "@/server/d1";
import { extractGeminiUsage, extractOpenAiUsage } from "./ai-usage";

export async function recordProviderAttempt(input: {
  id: string;
  url: string;
  init: RequestInit;
  startedAt: string;
  response?: Response;
  outcome: "response" | "network_error";
}): Promise<void> {
  if (process.env["AI_ATTEMPT_LOG_ENABLED"] !== "true") return;
  try {
    const endpoint = new URL(input.url);
    let model = "unknown";
    let body: Record<string, unknown> = {};
    try {
      body = typeof input.init.body === "string" ? JSON.parse(input.init.body) : {};
      const fromUrl = endpoint.pathname.match(/\/models\/([^/:]+):|\/run\/(.+)$/);
      model =
        typeof body["model"] === "string"
          ? body["model"]
          : (fromUrl?.[1] ?? fromUrl?.[2] ?? "unknown");
    } catch {
      /* Metadata is optional; never copy the request body. */
    }
    let usage = { inputTokens: null as number | null, outputTokens: null as number | null };
    if (input.response?.ok) {
      try {
        const payload: unknown = await input.response.clone().json();
        usage =
          endpoint.hostname === "generativelanguage.googleapis.com"
            ? extractGeminiUsage(payload)
            : extractOpenAiUsage(payload);
      } catch {
        /* Failed JSON can still be a paid attempt; keep NULL usage. */
      }
    }
    const db = await getD1Async();
    await db
      .prepare(
        "INSERT INTO ai_provider_attempts (id, started_at, provider, model, outcome, http_status, input_tokens, output_tokens, agreement_request) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        input.id,
        input.startedAt,
        endpoint.hostname,
        model.slice(0, 200),
        input.outcome,
        input.response?.status ?? null,
        usage.inputTokens,
        usage.outputTokens,
        body["prompt"] === "agree" ? 1 : 0,
      )
      .run();
  } catch {
    // Content-free signal: missing telemetry must not silently look complete.
    console.warn("AI_ATTEMPT_LOG_FAILED");
  }
}

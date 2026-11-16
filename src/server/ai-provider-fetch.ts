import { recordProviderAttempt } from "./ai-attempt-log";
/** Server-only guard for EVERY provider attempt, including retries and OCR fallbacks.
 * Product quota refunds never refund this budget: attempted work may be billed
 * even when the network times out or the model's reply is unusable.
 * No commercial quota or monetary allowance is implied by a request count.
 */
import { getD1Async } from "@/server/d1";
import type { D1Database } from "@/server/d1-auth-store";

export type AiProviderPolicy = { enabled: boolean; dailyRequests: number | null };

export function readAiProviderPolicy(env: Record<string, string | undefined>): AiProviderPolicy {
  const enabled = env["AI_REQUESTS_ENABLED"]?.trim().toLowerCase();
  if (enabled !== undefined && enabled !== "" && enabled !== "true" && enabled !== "false") {
    throw new Error("AI_PROVIDER_POLICY_INVALID");
  }
  const raw = env["AI_PROVIDER_DAILY_REQUEST_LIMIT"]?.trim();
  if (!raw) return { enabled: enabled !== "false", dailyRequests: null };
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error("AI_PROVIDER_POLICY_INVALID");
  }
  return { enabled: enabled !== "false", dailyRequests: Number(raw) };
}

/** One atomic SQLite UPSERT, not a read-then-write check. No per-user rows,
 * prompts, answers, images, tokens or credentials are stored in this counter.
 * UTC reset matches the existing daily technical quota. Invalid configuration,
 * missing migration, binding failure or an unexpected result all fail closed.
 */
export async function reserveProviderAttempt(
  db: D1Database,
  limit: number,
  now = new Date(),
): Promise<boolean> {
  if (!Number.isSafeInteger(limit) || limit <= 0 || !Number.isFinite(now.getTime())) return false;
  try {
    const day = now.toISOString().slice(0, 10);
    const result = (await db
      .prepare(
        "INSERT INTO ai_provider_daily_budget (day, request_count) VALUES (?, 1) " +
          "ON CONFLICT(day) DO UPDATE SET request_count = request_count + 1 " +
          "WHERE request_count < ?",
      )
      .bind(day, limit)
      .run()) as { meta?: { changes?: number } };
    return result?.meta?.changes === 1;
  } catch {
    return false;
  }
}

/** Disabled/configurable foundation: absent limit preserves current service.
 * AI_REQUESTS_ENABLED=false stops ALL AI network requests, no schema needed.
 * A configured daily limit requires the additive budget-table migration first.
 * All decisions happen before fetch, never after spending provider work.
 */
export async function aiProviderFetch(url: string, init: RequestInit): Promise<Response> {
  const policy = readAiProviderPolicy(process.env);
  if (!policy.enabled) throw new Error("AI_PROVIDER_PAUSED");
  if (init.signal?.aborted) throw new DOMException("Request aborted", "AbortError");
  if (policy.dailyRequests !== null) {
    if (policy.dailyRequests === 0) throw new Error("AI_PROVIDER_BUDGET_EXCEEDED");
    const db = await getD1Async();
    if (!(await reserveProviderAttempt(db, policy.dailyRequests))) {
      throw new Error("AI_PROVIDER_BUDGET_EXCEEDED");
    }
  }
  // Cancellation while D1 was reserving must not reach the network. Keep
  // the conservative reservation: never race a later request with a refund.
  if (init.signal?.aborted) throw new DOMException("Request aborted", "AbortError");
  const id = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  try {
    const response = await fetch(url, init);
    await recordProviderAttempt({ id, url, init, startedAt, response, outcome: "response" });
    return response;
  } catch (error) {
    await recordProviderAttempt({ id, url, init, startedAt, outcome: "network_error" });
    throw error;
  }
}

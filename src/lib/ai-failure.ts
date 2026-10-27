// Pure failure-taxonomy helpers for the AI server functions.
//
// Why this exists: the generation server function used to `throw` plain
// Errors whose message was the whole diagnosis ("AI_UPSTREAM"). In
// production a thrown server-fn error is re-serialised by the framework,
// so the real cause (which HTTP status the provider returned, and what it
// said) never reached the teacher — the button looked dead. Assessment
// generation now returns a discriminated `{ ok: false, code, detail }`
// result instead, and these helpers turn a provider response into a
// stable code plus a short, safe detail string.
//
// No server-only imports and no env reads here: pure and unit-testable.

export type AiFailureCode =
  | "AI_NOT_CONFIGURED"
  | "AI_AUTH"
  | "AI_RATE_LIMIT"
  | "AI_BAD_REQUEST"
  | "AI_UPSTREAM"
  | "AI_TIMEOUT"
  | "AI_EMPTY_REPLY"
  | "AI_PARSE_FAILED";

/** Generation failures = AI failures + the non-AI ones. */
export type GenerateFailureCode = AiFailureCode | "VALIDATION" | "NOT_TEACHER" | "DB_ERROR";

/**
 * Map an OpenAI-compatible provider HTTP status to a stable code.
 * 401/403 => the AI_API_KEY secret is wrong or lacks Workers AI permission;
 * 429   => provider quota/rate limit (Workers AI daily neurons);
 * 400/404/422 => the request itself is rejected (unknown model id, bad
 *               payload); everything else is treated as provider-side.
 */
export function classifyAiHttpStatus(status: number): AiFailureCode {
  if (status === 401 || status === 403) return "AI_AUTH";
  if (status === 429) return "AI_RATE_LIMIT";
  if (status === 400 || status === 404 || status === 405 || status === 422) return "AI_BAD_REQUEST";
  return "AI_UPSTREAM";
}

/**
 * Pull a short human-readable message out of a provider error body without
 * ever echoing request data. Handles the Cloudflare shape
 * ({ errors: [{ message }] }) and the OpenAI shape ({ error: { message } }).
 * Returns "" when nothing usable is present.
 */
export function describeProviderError(body: unknown, limit = 240): string {
  const pick = (v: unknown): string => (typeof v === "string" ? v : "");
  const field = (obj: unknown, key: string): unknown =>
    typeof obj === "object" && obj !== null ? (obj as Record<string, unknown>)[key] : undefined;
  let message = "";
  if (typeof body === "object" && body !== null) {
    const errors = field(body, "errors");
    if (Array.isArray(errors) && errors.length > 0) {
      const first: unknown = errors[0];
      message = pick(field(first, "message")) || pick(first);
    }
    if (!message) message = pick(field(field(body, "error"), "message"));
    if (!message) {
      message =
        pick(field(body, "error")) || pick(field(body, "message")) || pick(field(body, "detail"));
    }
  }
  if (!message && typeof body === "string") message = body;
  message = message.replace(/\s+/g, " ").trim();
  return message.length > limit ? `${message.slice(0, limit)}…` : message;
}

/** Turn an unknown thrown value into a short detail string (capped). */
export function describeThrown(error: unknown, limit = 240): string {
  const raw =
    error instanceof Error
      ? `${error.name === "Error" ? "" : `${error.name}: `}${error.message}`
      : typeof error === "string"
        ? error
        : "";
  const message = raw.replace(/\s+/g, " ").trim();
  return message.length > limit ? `${message.slice(0, limit)}…` : message;
}

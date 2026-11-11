/**
 * Server-only env-based feature flags.
 *
 * A flag is one line in FEATURE_FLAG_SPECS: a name, the env var that
 * controls it, and the values that count as "on". Nothing here changes
 * behavior by itself — a flag only takes effect where code calls
 * isEnabled(name). Do NOT import this from client code: it reads
 * process.env, which does not exist in the browser bundle.
 *
 * Adding a flag:
 *   1. Add one entry to FEATURE_FLAG_SPECS below.
 *   2. Set the var: secrets via `wrangler secret put <NAME>`,
 *      non-secret values in wrangler.jsonc `vars`.
 *   3. Gate the code path with isEnabled("flag-name") and keep the
 *      old path as the fallback until the flag is proven live.
 *
 * Boolean flags use the default on-values ("1", "true", "yes", "on").
 * Value-gated flags list their own values instead — see
 * "gemini-vision", which mirrors the existing VISION_PROVIDER gate
 * in src/server/handwritten.ts (resolveGeminiVision). That file still
 * reads the env var directly; switching it to isEnabled is a later,
 * mechanical step, not part of adding the helper.
 */

export type FeatureFlagName = "gemini-vision";

type FeatureFlagSpec = {
  /** Env var that controls the flag. */
  env: string;
  /**
   * Values that count as enabled (case-insensitive, trimmed).
   * Defaults to DEFAULT_ON_VALUES when omitted.
   */
  onValues?: readonly string[];
};

const DEFAULT_ON_VALUES = ["1", "true", "yes", "on"] as const;

export const FEATURE_FLAG_SPECS: Record<FeatureFlagName, FeatureFlagSpec> = {
  // Gemini vision OCR/grading is live only when VISION_PROVIDER is
  // exactly "gemini" (plus a GEMINI_API_KEY). Anything else — unset,
  // empty, "llama", … — means the Gemini vision path is off.
  "gemini-vision": { env: "VISION_PROVIDER", onValues: ["gemini"] },
};

function readEnv(name: string): string | undefined {
  if (typeof process === "undefined") return undefined;
  const value = process.env[name];
  return value === undefined ? undefined : value.trim();
}

/** True when the named flag's env var holds one of its "on" values. */
export function isEnabled(name: FeatureFlagName): boolean {
  const spec = FEATURE_FLAG_SPECS[name];
  const raw = readEnv(spec.env);
  if (raw === undefined || raw === "") return false;
  const onValues = spec.onValues ?? DEFAULT_ON_VALUES;
  return onValues.some((v) => v.toLowerCase() === raw.toLowerCase());
}

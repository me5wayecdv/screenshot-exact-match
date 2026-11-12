/**
 * Server functions for handwritten paper grading (OCR slice).
 *
 * These run ONLY on the server (TanStack Start server functions). The
 * client imports only the function stubs; the AI key and the image bytes
 * never ship anywhere except the provider call inside the handler.
 *
 * Flow (teacher-final-word, same as AI grading on /grading):
 *   1. Teacher uploads ONE paper photo for ONE question (client-side
 *      compressed to a JPEG data URL before it ever leaves the browser).
 *   2. ocrHandwrittenImage sends the photo to the provider as a
 *      multimodal chat completion and returns the transcribed text.
 *   3. The teacher REVIEWS and CORRECTS that text in the UI — Arabic
 *      handwriting OCR is approximate, so this step is mandatory, not
 *      optional. Nothing is graded from raw OCR output.
 *   4. Grading itself reuses the existing suggestGrade server function
 *      with the corrected text as the student answer. This file does NOT
 *      invent a second grading path.
 *   5. The teacher sets the final score; the /handwritten page saves it
 *      to public.handwritten_grades (see the migration). The photo itself
 *      is NOT stored in v1 — only extracted/corrected text + grades.
 *
 * Provider configuration (server env only, never VITE_):
 *   AI_BASE_URL     (required)  Same OpenAI-compatible endpoint as grading.
 *   AI_MODEL        (required)  Fallback model when AI_VISION_MODEL is unset.
 *   AI_VISION_MODEL (optional)  Vision-capable model for OCR. Set this when
 *                               AI_MODEL itself cannot read images; the UI
 *                               then shows a clear "model does not support
 *                               images" error instead of a silent failure.
 *   AI_API_KEY      (hosted providers) / optional for local endpoints.
 *
 * Auth model (D1 port, Phase 2b — mirrors src/server/ai-grade.ts):
 * the session is resolved server-side from the HttpOnly cookie by
 * requireCloudflareAuth; the client sends NO access token. The server
 * requires a teacher/admin role, and — when assessmentId is supplied —
 * requires that the assessment belongs to that teacher (admins
 * exempt). A student session, a missing session, or another teacher's
 * assessment all return UNAUTHORIZED and never reach the AI provider.
 * Quota and usage go through D1 (consumeAiQuota / logAiUsageEvent).
 * All pure vision helpers below (resolveVisionConfig,
 * resolveGeminiConfig, runImageToTextModel, runMoondreamQuery,
 * runGeminiQuery, textFromContent, stripDataUris,
 * extractTranscription, callVisionOcr) are UNCHANGED from the
 * Supabase original, so the provider behavior is identical.
 */

import { createServerFn } from "@tanstack/react-start";
import type { D1Database } from "@/server/d1-auth-store";
import { requireCloudflareAuth } from "@/server/d1-session";
import type { AuthSession } from "@/lib/cloudflare-auth";
import { consumeAiQuota, logAiUsageEvent, refundAiQuota } from "@/server/d1-quota";
import { isLocalBaseUrl } from "./ai-config";
import {
  extractGeminiUsage,
  extractOpenAiUsage,
  openAiProvider,
  type AiTokenUsage,
} from "./ai-usage";

export type VisionConfig = {
  baseUrl: string;
  model: string;
  apiKey: string;
  /** True when AI_VISION_MODEL (not the AI_MODEL fallback) is in use. */
  visionModelExplicit: boolean;
};

export function resolveVisionConfig(): VisionConfig | null {
  const baseUrl = process.env["AI_BASE_URL"]?.trim().replace(/\/+$/, "");
  const visionModel = process.env["AI_VISION_MODEL"]?.trim();
  const model = visionModel || process.env["AI_MODEL"]?.trim();
  const apiKey = process.env["AI_API_KEY"]?.trim() ?? "";
  if (!baseUrl || !model) return null;
  if (!apiKey && !isLocalBaseUrl(baseUrl)) return null;
  return { baseUrl, model, apiKey, visionModelExplicit: !!visionModel };
}

export function isVisionConfigured(): boolean {
  return resolveVisionConfig() !== null;
}

export type GeminiConfig = {
  apiKey: string;
  model: string;
};

/** Gemini vision, dormant unless explicitly switched on. The live
 *  Worker keeps the Cloudflare path unless VISION_PROVIDER is exactly
 *  "gemini" AND a GEMINI_API_KEY is present; with either missing this
 *  returns null and every call site falls through to Cloudflare.
 *  Added 2026-10-30 as code-only preparation for a later A/B test
 *  against Llama vision on the dense Arabic page; the key itself is
 *  never stored in code (Worker secret GEMINI_API_KEY). */
export function resolveGeminiConfig(): GeminiConfig | null {
  if (process.env["VISION_PROVIDER"]?.trim() !== "gemini") return null;
  const apiKey = process.env["GEMINI_API_KEY"]?.trim() ?? "";
  if (!apiKey) return null;
  const model = process.env["GEMINI_MODEL"]?.trim() || "gemini-2.5-flash";
  return { apiKey, model };
}

export type OcrRequest = {
  /** data:image/jpeg|png|webp;base64,... — client-compressed, one photo. */
  imageDataUrl: string;
  /** Optional: when supplied, ownership is verified server-side. */
  assessmentId?: string;
};

export type OcrErrorCode =
  | "INVALID_INPUT"
  | "UNAUTHORIZED"
  | "VISION_NOT_CONFIGURED"
  | "VISION_UNSUPPORTED"
  | "VISION_UPSTREAM"
  | "VISION_TIMEOUT"
  | "VISION_PARSE_FAILED"
  | "VISION_RATE_LIMIT";

export type OcrResult =
  { ok: true; text: string; model: string } | { ok: false; code: OcrErrorCode; message: string };

const TEACHER_ROLES = new Set(["school_teacher", "tutor", "admin"]);

/** Client-compressed JPEGs are ~1 MB; bound individual server inputs to 3 MB decoded. */
const MAX_DATA_URL_CHARS = 4_000_000;
const DATA_URL_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

function validateRequest(data: unknown): OcrRequest | { error: string } {
  if (typeof data !== "object" || data === null) return { error: "Request must be an object." };
  const d = data as Record<string, unknown>;
  const asString = (v: unknown) => (typeof v === "string" ? v : null);
  const imageDataUrl = asString(d["imageDataUrl"]);
  const assessmentId = asString(d["assessmentId"]) ?? undefined;
  if (!imageDataUrl || !DATA_URL_RE.test(imageDataUrl)) {
    return { error: "imageDataUrl must be a jpeg/png/webp data URL." };
  }
  if (imageDataUrl.length > MAX_DATA_URL_CHARS) {
    return { error: "Image is too large. Compress it before uploading." };
  }
  return { imageDataUrl, ...(assessmentId ? { assessmentId } : {}) };
}

/** Verify the caller is a teacher/admin and (when given) owns the assessment. */
async function authorize(
  db: D1Database,
  session: AuthSession,
  assessmentId: string | undefined,
): Promise<{ ok: true; userId: string } | { ok: false; message: string }> {
  // Defensive, mirroring src/lib/session.ts: legacy 'teacher' rows count as school_teacher.
  const role = (session.role as string) === "teacher" ? "school_teacher" : session.role;
  if (!TEACHER_ROLES.has(role)) {
    return { ok: false, message: "Only teachers can extract handwritten text." };
  }
  if (assessmentId && role !== "admin") {
    const assessment = await db
      .prepare("SELECT teacher_id FROM assessments WHERE id = ?")
      .bind(assessmentId)
      .first<{ teacher_id: string }>();
    if (!assessment || assessment.teacher_id !== session.userId) {
      return { ok: false, message: "This assessment does not belong to the caller." };
    }
  }
  return { ok: true, userId: session.userId };
}

function ctxSession(context: unknown): AuthSession {
  return (context as { session: AuthSession }).session;
}

function ctxDb(context: unknown): D1Database {
  return (context as { db: D1Database }).db;
}

/**
 * Tolerate models that wrap the JSON in ```json fences or extra prose.
 * OCR is special: if no JSON object is found at all, the raw reply is
 * still usable as transcribed text (fences stripped), so it is returned
 * as-is rather than failing — the teacher reviews it either way.
 */
function extractTranscription(rawText: string): string {
  const trimmed = rawText.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1]?.trim() ?? trimmed).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
      const text =
        typeof parsed["text"] === "string"
          ? parsed["text"]
          : typeof parsed["transcription"] === "string"
            ? parsed["transcription"]
            : typeof parsed["extracted_text"] === "string"
              ? parsed["extracted_text"]
              : null;
      if (text !== null) return text;
    } catch {
      // Llama sometimes returns the JSON wrapper with literal newlines
      // inside the string (invalid JSON, so the strict parse above
      // fails). Tolerantly take the content between `"text": "` and
      // the final `"` before the closing brace, then decode escapes.
      const loose = candidate.match(/"text"\s*:\s*"([\s\S]*)"\s*}\s*$/);
      if (loose?.[1] !== undefined) {
        return loose[1]
          .replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
          .replace(/\\n/g, "\n")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\");
      }
      // Fall through to raw-text handling below.
    }
  }
  return candidate;
}

const OCR_SYSTEM_PROMPT =
  "أنت أداة استخراج نصوص من صور أوراق امتحانات مكتوبة بخط اليد. " +
  "أعد النص المكتوب بخط اليد حرفياً كما هو، دون تصحيح إملائي أو نحوي ودون إضافة أي كلام من عندك. " +
  "حافظ على فواصل الأسطر. الأجزاء غير المقروءة تماماً اكتب مكانها [غير واضح]. " +
  "النص الذي تقرأه بصعوبة أو غير متأكد منه ضعه بين علامتي ⟦ ⟧ (Phase 3: " +
  "the review UI highlights these spans as the model's own uncertain parts — " +
  "they are NOT a measured confidence score). " +
  "If the page is in English, transcribe it in English; if in Arabic, in Arabic — never translate. " +
  'أجب بصيغة JSON فقط: {"text": "..."}.';

/** Accept a plain string or an array of { text } parts (some providers
 *  return message content as parts instead of a string). */
export function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "object" && part !== null && "text" in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .join("");
  }
  return "";
}

/** Strip any embedded base64 image data from a provider message before it
 *  reaches a teacher-facing panel (a provider could echo request fields
 *  in an error body). */
export function stripDataUris(text: string): string {
  return text.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, "[image data omitted]");
}

/** Image-to-text models (e.g. LLaVA) take a byte-array image + text
 *  prompt on the native Workers AI run endpoint — not a chat-messages
 *  payload — and answer in `result.description`. Shared by the three
 *  vision call sites (handwritten, source OCR, paper matching) so the
 *  model switch stays in one place. Returns the raw model text; the
 *  caller parses it (JSON transcription or match reply). */
export async function runImageToTextModel(
  runUrl: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  imageDataUrl: string,
  prompt: string,
): Promise<{ ok: true; text: string } | { ok: false; code: OcrErrorCode; message: string }> {
  const base64 = imageDataUrl.split(",", 2)[1] ?? "";
  const bytes = Buffer.from(base64, "base64");
  const res = await fetch(runUrl, {
    method: "POST",
    signal,
    headers,
    body: JSON.stringify({
      image: Array.from(bytes),
      prompt,
      // LLaVA's provider limit (observed live 2026-10-29: HTTP 400
      // "max_tokens must be <= 1024"). Transcriptions longer than
      // this are truncated by the provider, not by us.
      max_tokens: 1024,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return {
      ok: false,
      code: "VISION_UPSTREAM",
      message: `Vision provider returned HTTP ${res.status}: ${stripDataUris(body).slice(0, 500)}`,
    };
  }
  const json = (await res.json()) as {
    success?: boolean;
    result?: unknown;
    errors?: unknown;
  };
  if (json.success === false) {
    return {
      ok: false,
      code: "VISION_UPSTREAM",
      message: `Vision provider rejected the request: ${stripDataUris(JSON.stringify(json.errors ?? "")).slice(0, 500)}`,
    };
  }
  const result = json.result;
  const description =
    result && typeof result === "object" && "description" in result
      ? (result as { description?: unknown }).description
      : result;
  const text = textFromContent(description);
  if (!text.trim()) {
    return { ok: false, code: "VISION_PARSE_FAILED", message: "Vision provider returned no text." };
  }
  return { ok: true, text };
}

/** Moondream 3.1 on Workers AI takes a task-based payload — not chat
 *  messages and not the LLaVA shape. `task: "query"` with a byte-array
 *  image answers in `result.description` (falling back to `answer` /
 *  raw text). No license agreement is required for this model.
 *  Added for the 2026-10-29 A/B test against Llama 3.2 vision on the
 *  dense Arabic page; the model switch stays in AI_VISION_MODEL. */
export async function runMoondreamQuery(
  runUrl: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  imageDataUrl: string,
  prompt: string,
): Promise<{ ok: true; text: string } | { ok: false; code: OcrErrorCode; message: string }> {
  const base64 = imageDataUrl.split(",", 2)[1] ?? "";
  const bytes = Buffer.from(base64, "base64");
  const res = await fetch(runUrl, {
    method: "POST",
    signal,
    headers,
    body: JSON.stringify({
      task: "query",
      image: Array.from(bytes),
      prompt,
      max_tokens: 4000,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return {
      ok: false,
      code: "VISION_UPSTREAM",
      message: `Vision provider returned HTTP ${res.status}: ${stripDataUris(body).slice(0, 500)}`,
    };
  }
  const json = (await res.json()) as {
    success?: boolean;
    result?: unknown;
    errors?: unknown;
  };
  if (json.success === false) {
    return {
      ok: false,
      code: "VISION_UPSTREAM",
      message: `Vision provider rejected the request: ${stripDataUris(JSON.stringify(json.errors ?? "")).slice(0, 500)}`,
    };
  }
  const result = json.result;
  const described =
    result && typeof result === "object" && "description" in result
      ? (result as { description?: unknown }).description
      : result && typeof result === "object" && "answer" in result
        ? (result as { answer?: unknown }).answer
        : result;
  const text = textFromContent(described);
  if (!text.trim()) {
    return { ok: false, code: "VISION_PARSE_FAILED", message: "Vision provider returned no text." };
  }
  return { ok: true, text };
}

const GEMINI_503_RETRY_DELAYS_MS = [1_000, 2_000] as const;

function geminiRetryDelayMs(response: Response, fallbackMs: number): number {
  const retryAfter = response.headers.get("retry-after")?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const requestedMs = Number.isFinite(seconds)
      ? seconds * 1_000
      : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(requestedMs) && requestedMs > 0) {
      // Respect the provider's hint without letting one OCR request hang
      // for an unbounded period.
      return Math.min(5_000, requestedMs);
    }
  }
  return fallbackMs;
}

async function waitForGeminiRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new DOMException("The operation was aborted.", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

/** Gemini vision via the Developer API generateContent endpoint.
 *  Unlike the Cloudflare paths, the image travels as base64 inline
 *  data (not a byte array) alongside the text prompt. Response text
 *  comes from candidates[0].content.parts[].text, joined. Error
 *  conventions mirror the sibling helpers. Dormant: only called
 *  when resolveGeminiConfig() returns non-null. Transient HTTP 503s
 *  receive at most two bounded retries. */
export async function runGeminiQuery(
  apiKey: string,
  model: string,
  signal: AbortSignal,
  imageDataUrl: string,
  prompt: string,
): Promise<
  | { ok: true; text: string; usage: AiTokenUsage }
  | { ok: false; code: OcrErrorCode; message: string }
> {
  const comma = imageDataUrl.indexOf(",");
  const mimeMatch = /^data:([^;]+);base64,/.exec(imageDataUrl);
  const mimeType = mimeMatch ? mimeMatch[1] : "image/jpeg";
  const data = comma >= 0 ? imageDataUrl.slice(comma + 1) : "";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const requestInit: RequestInit = {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ text: prompt }, { inlineData: { mimeType, data } }],
        },
      ],
      generationConfig: { maxOutputTokens: 8192, temperature: 0 },
    }),
  };

  let res: Response;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url, requestInit);
    if (res.status !== 503 || attempt >= GEMINI_503_RETRY_DELAYS_MS.length) break;

    const delayMs = geminiRetryDelayMs(res, GEMINI_503_RETRY_DELAYS_MS[attempt]!);
    await res.body?.cancel().catch(() => undefined);
    await waitForGeminiRetry(delayMs, signal);
  }

  if (!res.ok) {
    // Do not return the provider's raw error payload to the browser. Keep a
    // stable status for UI handling without exposing vendor internals.
    return {
      ok: false,
      code: "VISION_UPSTREAM",
      message:
        res.status === 503
          ? "Vision provider is temporarily unavailable (HTTP 503)."
          : `Vision provider returned HTTP ${res.status}.`,
    };
  }
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
    usageMetadata?: unknown;
  };
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((part) => (typeof part.text === "string" ? part.text : "")).join("");
  if (!text.trim()) {
    return { ok: false, code: "VISION_PARSE_FAILED", message: "Vision provider returned no text." };
  }
  return { ok: true, text, usage: extractGeminiUsage(json) };
}

async function callVisionOcr(
  config: VisionConfig,
  imageDataUrl: string,
): Promise<
  | { ok: true; text: string; provider: string; model: string; usage: AiTokenUsage }
  | { ok: false; code: OcrErrorCode; message: string }
> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (config.apiKey) headers["authorization"] = `Bearer ${config.apiKey}`;
    // Gemini vision (dormant): only when VISION_PROVIDER=gemini and
    // GEMINI_API_KEY are set; otherwise falls through to Cloudflare.
    // A/B preparation 2026-10-30 — live behavior unchanged by default.
    const gemini = resolveGeminiConfig();
    if (gemini) {
      const g = await runGeminiQuery(
        gemini.apiKey,
        gemini.model,
        controller.signal,
        imageDataUrl,
        "Transcribe all text visible in this image completely and literally, " +
          "preserving headings, paragraphs and their order. Do not summarize, correct, or add anything. " +
          "Parts that are unreadable, write [unclear] in their place. " +
          "Return only the transcription, nothing else.",
      );
      if (!g.ok) return g;
      return {
        ok: true,
        text: extractTranscription(g.text),
        provider: "gemini",
        model: gemini.model,
        usage: g.usage,
      };
    }
    // Cloudflare's OpenAI-compatible endpoint is documented for TEXT
    // generation only — a vision model called through it is refused
    // (HTTP 403 observed live 2026-10-29). Vision models on Cloudflare
    // go through the native Workers AI run endpoint instead; other
    // providers keep the OpenAI-compatible path below.
    if (
      config.baseUrl.includes("api.cloudflare.com/client/v4/accounts/") &&
      /\/v1\/?$/.test(config.baseUrl)
    ) {
      const runBase = config.baseUrl.replace(/\/v1\/?$/, "");
      const runUrl = `${runBase}/run/${config.model}`;
      // Image-to-text models (LLaVA) cannot take the chat-messages
      // payload below. (2026-10-29: AI_VISION_MODEL was switched to
      // LLaVA because the Llama 3.2 vision model's Meta license
      // agreement could not be registered from this account's available
      // tokens; the chat path stays for a future switch-back.)
      if (config.model.includes("llava")) {
        const llava = await runImageToTextModel(
          runUrl,
          headers,
          controller.signal,
          imageDataUrl,
          "Transcribe all handwritten text visible in this image exactly, character for character. " +
            "Do not correct spelling or grammar and do not add any words of your own. " +
            "Keep line breaks. Parts that are completely unreadable, write [unclear] in their place. " +
            "Return only the transcription, nothing else.",
        );
        if (!llava.ok) return llava;
        return {
          ok: true,
          text: extractTranscription(llava.text),
          provider: "cloudflare-native",
          model: config.model,
          usage: { inputTokens: null, outputTokens: null },
        };
      }
      // Moondream takes a task payload, not chat messages. A/B test
      // 2026-10-29 against Llama vision on the dense Arabic page.
      if (config.model.includes("moondream")) {
        const moon = await runMoondreamQuery(
          runUrl,
          headers,
          controller.signal,
          imageDataUrl,
          "Transcribe all text visible in this image completely and literally, " +
            "preserving headings, paragraphs and their order. Do not summarize, correct, or add anything. " +
            "Parts that are unreadable, write [unclear] in their place. " +
            "Return only the transcription, nothing else.",
        );
        if (!moon.ok) return moon;
        return {
          ok: true,
          text: extractTranscription(moon.text),
          provider: "cloudflare-native",
          model: config.model,
          usage: { inputTokens: null, outputTokens: null },
        };
      }
      const visionInit = {
        method: "POST",
        signal: controller.signal,
        headers,
        body: JSON.stringify({
          messages: [
            { role: "system", content: OCR_SYSTEM_PROMPT },
            {
              role: "user",
              content: "استخرج النص المكتوب بخط اليد في هذه الصورة حرفياً.",
            },
          ],
          image: imageDataUrl,
          max_tokens: 4000,
        }),
      };
      let res = await fetch(runUrl, visionInit);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const lowered = body.toLowerCase();
        if (lowered.includes("model agreement") || lowered.includes("submit the prompt")) {
          // The documented agreement mechanism is a `prompt` (not a
          // chat message) submission to the run endpoint, sent with the
          // Worker's own Workers-AI-scoped key (config.apiKey). Every
          // earlier attempt used the chat-message form (Playground +
          // server native/compat agrees) and all failed; the prompt
          // form with the right token is the one combination never
          // tried. One attempt, then one vision retry; if the gate
          // still holds, fall back to the dashboard hint below.
          const agreeRes = await fetch(runUrl, {
            method: "POST",
            signal: controller.signal,
            headers,
            body: JSON.stringify({ prompt: "agree" }),
          }).catch(() => null);
          if (agreeRes && agreeRes.ok) {
            res = await fetch(runUrl, visionInit);
            if (!res.ok) {
              const retryBody = await res.text().catch(() => "");
              return {
                ok: false,
                code: "VISION_UPSTREAM",
                message: `Vision model license agreement required: submit the prompt 'agree' once for ${config.model} from the Cloudflare Workers AI Playground, then retry. Provider said: ${stripDataUris(retryBody).slice(0, 300)}`,
              };
            }
            // Retry succeeded: fall through to response parsing below.
          } else {
            return {
              ok: false,
              code: "VISION_UPSTREAM",
              message: `Vision model license agreement required: submit the prompt 'agree' once for ${config.model} from the Cloudflare Workers AI Playground, then retry. Provider said: ${stripDataUris(body).slice(0, 300)}`,
            };
          }
        } else if (
          res.status === 400 &&
          (lowered.includes("image") ||
            lowered.includes("vision") ||
            lowered.includes("multimodal") ||
            lowered.includes("unsupported"))
        ) {
          return {
            ok: false,
            code: "VISION_UNSUPPORTED",
            message: "The configured model does not support image input.",
          };
        } else {
          return {
            ok: false,
            code: "VISION_UPSTREAM",
            message: `Vision provider returned HTTP ${res.status}: ${stripDataUris(body).slice(0, 500)}`,
          };
        }
      }
      const json = (await res.json()) as {
        success?: boolean;
        result?: unknown;
        errors?: unknown;
      };
      if (json.success === false) {
        return {
          ok: false,
          code: "VISION_UPSTREAM",
          message: `Vision provider rejected the request: ${stripDataUris(JSON.stringify(json.errors ?? "")).slice(0, 500)}`,
        };
      }
      const result = json.result;
      const response =
        result && typeof result === "object" && "response" in result
          ? (result as { response?: unknown }).response
          : result;
      const rawText = textFromContent(response);
      if (!rawText.trim()) {
        return {
          ok: false,
          code: "VISION_PARSE_FAILED",
          message: "Vision provider returned no text.",
        };
      }
      return {
        ok: true,
        text: extractTranscription(rawText),
        provider: "cloudflare-native",
        model: config.model,
        usage: { inputTokens: null, outputTokens: null },
      };
    }
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers,
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        max_tokens: 4000,
        messages: [
          { role: "system", content: OCR_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: "استخرج النص المكتوب بخط اليد في هذه الصورة حرفياً." },
              { type: "image_url", image_url: { url: imageDataUrl } },
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const lowered = body.toLowerCase();
      // A provider rejecting image content means the configured model is
      // not vision-capable — a configuration error, not a transient one.
      if (
        res.status === 400 &&
        (lowered.includes("image") ||
          lowered.includes("vision") ||
          lowered.includes("multimodal") ||
          lowered.includes("unsupported"))
      ) {
        return {
          ok: false,
          code: "VISION_UNSUPPORTED",
          message: "The configured model does not support image input.",
        };
      }
      return {
        ok: false,
        code: "VISION_UPSTREAM",
        message: `Vision provider returned HTTP ${res.status}: ${stripDataUris(body).slice(0, 500)}`,
      };
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string | unknown } }[];
      usage?: unknown;
    };
    const content: unknown = json.choices?.[0]?.message?.content;
    // Some OpenAI-compatible providers return message content as an array
    // of parts (e.g. [{ type: "text", text: "..." }]) instead of a plain
    // string — especially for multimodal models. Treating that as empty
    // used to surface as a silent VISION_PARSE_FAILED, so join text parts.
    // Reuse the same string-or-parts joiner as the native branch.
    const rawText = textFromContent(content);
    if (!rawText.trim()) {
      return {
        ok: false,
        code: "VISION_PARSE_FAILED",
        message: "Vision provider returned no text.",
      };
    }
    return {
      ok: true,
      text: extractTranscription(rawText),
      provider: openAiProvider(config.baseUrl),
      model: config.model,
      usage: extractOpenAiUsage(json),
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, code: "VISION_TIMEOUT", message: "Vision provider timed out." };
    }
    return { ok: false, code: "VISION_UPSTREAM", message: "Vision provider request failed." };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * ocrHandwrittenImage — server function.
 * Call from the client as: ocrHandwrittenImage({ data: { ...request } })
 * Returns a discriminated result; it never throws for expected failures,
 * so the UI can distinguish "not configured" / "model can't read images"
 * from transient errors.
 */
export const ocrHandwrittenImage = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async ({ data, context }): Promise<OcrResult> => {
    const request = validateRequest(data);
    if ("error" in request) {
      return { ok: false, code: "INVALID_INPUT", message: request.error };
    }
    const db = ctxDb(context);
    const auth = await authorize(db, ctxSession(context), request.assessmentId);
    if (!auth.ok) return { ok: false, code: "UNAUTHORIZED", message: auth.message };

    const config = resolveVisionConfig();
    if (!config) {
      return {
        ok: false,
        code: "VISION_NOT_CONFIGURED",
        message:
          "Vision provider is not configured on the server (set AI_BASE_URL and AI_MODEL, plus AI_VISION_MODEL for a vision-capable model, and AI_API_KEY for hosted providers).",
      };
    }
    if (!(await consumeAiQuota(db, auth.userId, 1))) {
      return {
        ok: false,
        code: "VISION_RATE_LIMIT",
        message: "AI usage limit reached. Try again later.",
      };
    }
    const result = await callVisionOcr(config, request.imageDataUrl);
    if (!result.ok) {
      // AI-F5: the OCR call failed, so the unit consumed above goes back.
      await refundAiQuota(db, auth.userId, 1);
      return { ok: false, code: result.code, message: result.message };
    }
    // Pilot cost measurement (best-effort, never fails the OCR result).
    await logAiUsageEvent(db, auth.userId, {
      kind: "ocr",
      provider: result.provider,
      model: result.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    }).catch(() => undefined);
    return { ok: true, text: result.text, model: config.model };
  });

/**
 * getHandwritingStatus — server function.
 * Call from the client as: getHandwritingStatus({ data: {} })
 * Returns only booleans. It never reveals the key, the model, or the
 * base URL, so the page can show the "not configured" state up front.
 */
export const getHandwritingStatus = createServerFn({ method: "POST" })
  .middleware([requireCloudflareAuth])
  .validator((data: unknown) => data)
  .handler(async (): Promise<{ configured: boolean; visionModelExplicit: boolean }> => {
    const config = resolveVisionConfig();
    return {
      configured: config !== null,
      visionModelExplicit: config?.visionModelExplicit ?? false,
    };
  });

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
 * Auth model (mirrors src/server/ai-grade.ts): the client sends its
 * Supabase session access token, the server validates it with Supabase
 * Auth, requires a teacher/admin role, and — when assessmentId is
 * supplied — requires that the assessment belongs to that teacher
 * (admins exempt). A student token, a missing/invalid token, or another
 * teacher's assessment all return UNAUTHORIZED and never reach the AI
 * provider.
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { isLocalBaseUrl } from "./ai-config";

export type VisionConfig = {
  baseUrl: string;
  model: string;
  apiKey: string;
  /** True when AI_VISION_MODEL (not the AI_MODEL fallback) is in use. */
  visionModelExplicit: boolean;
};

export function resolveVisionConfig(): VisionConfig | null {
  const baseUrl = process.env.AI_BASE_URL?.trim().replace(/\/+$/, "");
  const visionModel = process.env.AI_VISION_MODEL?.trim();
  const model = visionModel || process.env.AI_MODEL?.trim();
  const apiKey = process.env.AI_API_KEY?.trim() ?? "";
  if (!baseUrl || !model) return null;
  if (!apiKey && !isLocalBaseUrl(baseUrl)) return null;
  return { baseUrl, model, apiKey, visionModelExplicit: !!visionModel };
}

export function isVisionConfigured(): boolean {
  return resolveVisionConfig() !== null;
}

export type OcrRequest = {
  /** data:image/jpeg|png|webp;base64,... — client-compressed, one photo. */
  imageDataUrl: string;
  /** Optional: when supplied, ownership is verified server-side. */
  assessmentId?: string;
  /** Supabase session access token from the calling teacher's browser. */
  accessToken: string;
};

export type OcrErrorCode =
  | "INVALID_INPUT"
  | "UNAUTHORIZED"
  | "VISION_NOT_CONFIGURED"
  | "VISION_UNSUPPORTED"
  | "VISION_UPSTREAM"
  | "VISION_TIMEOUT"
  | "VISION_PARSE_FAILED";

export type OcrResult =
  | { ok: true; text: string; model: string }
  | { ok: false; code: OcrErrorCode; message: string };

const TEACHER_ROLES = new Set(["school_teacher", "tutor", "admin"]);

/** Client-compressed JPEGs are ~1 MB; 8M chars of data URL is a hard cap. */
const MAX_DATA_URL_CHARS = 8_000_000;
const DATA_URL_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

function serverSupabaseEnv(): { url: string; anonKey: string } | null {
  const url =
    process.env.SUPABASE_URL?.trim() || process.env.VITE_SUPABASE_URL?.trim();
  const anonKey =
    process.env.SUPABASE_ANON_KEY?.trim() ||
    process.env.VITE_SUPABASE_ANON_KEY?.trim() ||
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

function validateRequest(data: unknown): OcrRequest | { error: string } {
  if (typeof data !== "object" || data === null) return { error: "Request must be an object." };
  const d = data as Record<string, unknown>;
  const asString = (v: unknown) => (typeof v === "string" ? v : null);
  const imageDataUrl = asString(d.imageDataUrl);
  const accessToken = asString(d.accessToken);
  const assessmentId = asString(d.assessmentId) ?? undefined;
  if (!imageDataUrl || !DATA_URL_RE.test(imageDataUrl)) {
    return { error: "imageDataUrl must be a jpeg/png/webp data URL." };
  }
  if (imageDataUrl.length > MAX_DATA_URL_CHARS) {
    return { error: "Image is too large. Compress it before uploading." };
  }
  if (!accessToken?.trim()) return { error: "accessToken is required." };
  return { imageDataUrl, accessToken, assessmentId };
}

/** Verify the caller is a teacher/admin and (when given) owns the assessment. */
async function authorize(
  accessToken: string,
  assessmentId: string | undefined,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const env = serverSupabaseEnv();
  if (!env) {
    return { ok: false, message: "Server Supabase environment is not configured." };
  }
  const supabase = createClient(env.url, env.anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  const user = userData?.user;
  if (userError || !user) return { ok: false, message: "Invalid or expired session." };

  const { data: roleRow } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle();
  // Defensive, mirroring src/lib/session.ts: legacy 'teacher' rows count as school_teacher.
  const role = roleRow?.role === "teacher" ? "school_teacher" : roleRow?.role;
  if (!role || !TEACHER_ROLES.has(role)) {
    return { ok: false, message: "Only teachers can extract handwritten text." };
  }
  if (assessmentId && role !== "admin") {
    const { data: assessment } = await supabase
      .from("assessments")
      .select("teacher_id")
      .eq("id", assessmentId)
      .maybeSingle();
    if (!assessment || assessment.teacher_id !== user.id) {
      return { ok: false, message: "This assessment does not belong to the caller." };
    }
  }
  return { ok: true };
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
        typeof parsed.text === "string"
          ? parsed.text
          : typeof parsed.transcription === "string"
            ? parsed.transcription
            : typeof parsed.extracted_text === "string"
              ? parsed.extracted_text
              : null;
      if (text !== null) return text;
    } catch {
      // Fall through to raw-text handling below.
    }
  }
  return candidate;
}

const OCR_SYSTEM_PROMPT =
  "أنت أداة استخراج نصوص من صور أوراق امتحانات مكتوبة بخط اليد. " +
  "أعد النص المكتوب بخط اليد حرفياً كما هو، دون تصحيح إملائي أو نحوي ودون إضافة أي كلام من عندك. " +
  "حافظ على فواصل الأسطر. الأجزاء غير المقروءة اكتب مكانها [غير واضح]. " +
  "أجب بصيغة JSON فقط: {\"text\": \"...\"}.";

async function callVisionOcr(
  config: VisionConfig,
  imageDataUrl: string,
): Promise<{ ok: true; text: string } | { ok: false; code: OcrErrorCode; message: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
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
        message: `Vision provider returned HTTP ${res.status}.`,
      };
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string | unknown } }[];
    };
    const content = json.choices?.[0]?.message?.content;
    const rawText = typeof content === "string" ? content : "";
    if (!rawText.trim()) {
      return { ok: false, code: "VISION_PARSE_FAILED", message: "Vision provider returned no text." };
    }
    return { ok: true, text: extractTranscription(rawText) };
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
export const ocrHandwrittenImage = createServerFn({ method: "POST" }).handler(
  async ({ data }): Promise<OcrResult> => {
    const request = validateRequest(data);
    if ("error" in request) {
      return { ok: false, code: "INVALID_INPUT", message: request.error };
    }
    const auth = await authorize(request.accessToken, request.assessmentId);
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
    const result = await callVisionOcr(config, request.imageDataUrl);
    if (!result.ok) return { ok: false, code: result.code, message: result.message };
    return { ok: true, text: result.text, model: config.model };
  },
);

/**
 * getHandwritingStatus — server function.
 * Call from the client as: getHandwritingStatus({ data: {} })
 * Returns only booleans. It never reveals the key, the model, or the
 * base URL, so the page can show the "not configured" state up front.
 */
export const getHandwritingStatus = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ configured: boolean; visionModelExplicit: boolean }> => {
    const config = resolveVisionConfig();
    return { configured: config !== null, visionModelExplicit: config?.visionModelExplicit ?? false };
  },
);

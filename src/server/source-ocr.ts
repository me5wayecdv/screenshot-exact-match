/**
 * Server functions for Phase 2 generation sources: OCR of curriculum
 * page photos into source text for assessment generation.
 *
 * This mirrors src/server/handwritten.ts deliberately (same vision
 * config, same error codes, same auth model) but with a different
 * prompt and a different contract:
 *   - Handwritten grading OCR transcribes ONE student answer verbatim.
 *   - Source OCR transcribes curriculum PAGES (printed or handwritten
 *     lesson content) so the teacher can generate questions from them.
 *     The extracted text goes into the generate page's source textarea
 *     for the teacher to REVIEW and EDIT before any generation runs —
 *     nothing is generated from raw OCR output.
 *
 * Provider configuration (server env only, never VITE_) — shared with
 * handwritten OCR: AI_BASE_URL (required), AI_MODEL (fallback),
 * AI_VISION_MODEL (vision-capable model), AI_API_KEY (hosted only).
 * Resolve via resolveVisionConfig() from ./handwritten so the two
 * slices can never drift apart on config.
 *
 * Auth model (mirrors handwritten.ts): the client sends its Supabase
 * session access token; the server validates it and requires a
 * teacher/admin role. Sources are not tied to an assessment yet (the
 * draft does not exist until generation), so there is no ownership
 * check here — the bucket folder ({teacher_id}) enforces ownership of
 * the stored files themselves.
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import {
  resolveGeminiConfig,
  resolveVisionConfig,
  runGeminiQuery,
  runImageToTextModel,
  runMoondreamQuery,
  stripDataUris,
  textFromContent,
  type OcrErrorCode,
} from "./handwritten";

export type SourceOcrResult =
  | { ok: true; texts: string[] }
  | { ok: false; code: OcrErrorCode; message: string; imageIndex?: number };

const TEACHER_ROLES = new Set(["school_teacher", "tutor", "admin"]);

/** Client-compressed JPEGs are ~1 MB; 8M chars of data URL is a hard cap. */
const MAX_DATA_URL_CHARS = 8_000_000;
const DATA_URL_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
/** At most 5 page photos per source batch (sequential vision calls). */
const MAX_IMAGES = 5;

function serverSupabaseEnv(): { url: string; anonKey: string } | null {
  const url = process.env.SUPABASE_URL?.trim() || process.env.VITE_SUPABASE_URL?.trim();
  const anonKey =
    process.env.SUPABASE_ANON_KEY?.trim() ||
    process.env.VITE_SUPABASE_ANON_KEY?.trim() ||
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

/** Verify the caller is a teacher/admin. No assessment ownership here. */
async function authorizeTeacher(
  accessToken: string,
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
    return { ok: false, message: "Only teachers can extract source text." };
  }
  return { ok: true };
}

/**
 * Tolerate models that wrap the JSON in ```json fences or extra prose.
 * If no JSON object is found at all, the raw reply is still usable as
 * transcribed text (fences stripped) — the teacher reviews it either way.
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
      // Llama sometimes returns the JSON wrapper with literal newlines
      // inside the string (invalid JSON, so the strict parse above
      // fails). Tolerantly take the content between `"text": "` and
      // the final `"` before the closing brace, then decode escapes.
      const loose = candidate.match(/"text"\s*:\s*"([\s\S]*)"\s*}\s*$/);
      if (loose) {
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

const SOURCE_SYSTEM_PROMPT =
  "أنت أداة استخراج نصوص من صور صفحات المناهج الدراسية. " +
  "أعد النص الظاهر في الصورة كاملاً وحرفياً، مع الحفاظ على العناوين وفقرات النص وترتيبها. " +
  "لا تلخّص ولا تصحّح ولا تضف شيئاً من عندك. " +
  "الأجزاء غير المقروءة اكتب مكانها [غير واضح]. " +
  "If the page is in English, transcribe it in English; if in Arabic, in Arabic — never translate. " +
  'أجب بصيغة JSON فقط: {"text": "..."}.';

async function callVisionOcr(
  baseUrl: string,
  model: string,
  apiKey: string,
  imageDataUrl: string,
): Promise<{ ok: true; text: string } | { ok: false; code: OcrErrorCode; message: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
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
        "Transcribe all text visible in this curriculum page image completely and literally, " +
          "preserving headings, paragraphs and their order. Do not summarize, correct, or add anything. " +
          "Parts that are unreadable, write [unclear] in their place. " +
          "Return only the transcription, nothing else.",
      );
      if (!g.ok) return g;
      return { ok: true, text: extractTranscription(g.text) };
    }
    // LLaVA (image-to-text) cannot take the chat-completions shape below:
    // on Cloudflare it needs the native run endpoint with a byte-array
    // image + text prompt. See runImageToTextModel in ./handwritten.
    if (
      baseUrl.includes("api.cloudflare.com/client/v4/accounts/") &&
      /\/v1\/?$/.test(baseUrl) &&
      model.includes("llava")
    ) {
      const runUrl = `${baseUrl.replace(/\/v1\/?$/, "")}/run/${model}`;
      const llava = await runImageToTextModel(
        runUrl,
        headers,
        controller.signal,
        imageDataUrl,
        "Transcribe all text visible in this curriculum page image completely and literally, " +
          "preserving headings, paragraphs and their order. Do not summarize, correct, or add anything. " +
          "Parts that are unreadable, write [unclear] in their place. " +
          "Return only the transcription, nothing else.",
      );
      if (!llava.ok) return llava;
      return { ok: true, text: extractTranscription(llava.text) };
    }
    if (model.includes("moondream")) {
      const runUrl = `${baseUrl.replace(/\/v1\/?$/, "")}/run/${model}`;
      const moon = await runMoondreamQuery(
        runUrl,
        headers,
        controller.signal,
        imageDataUrl,
        "Transcribe all text visible in this curriculum page image completely and literally, " +
          "preserving headings, paragraphs and their order. Do not summarize, correct, or add anything. " +
          "Parts that are unreadable, write [unclear] in their place. " +
          "Return only the transcription, nothing else.",
      );
      if (!moon.ok) return moon;
      return { ok: true, text: extractTranscription(moon.text) };
    }
    // Cloudflare vision models go through the native Workers AI run
    // endpoint (top-level `image` + text-only messages) — the
    // OpenAI-compatible endpoint refuses them (HTTP 400 observed live
    // 2026-10-29 on /assessments/generate). This mirrors the
    // handwritten path, which works first-click with this shape.
    if (baseUrl.includes("api.cloudflare.com/client/v4/accounts/") && /\/v1\/?$/.test(baseUrl)) {
      const runUrl = `${baseUrl.replace(/\/v1\/?$/, "")}/run/${model}`;
      const nativeInit = {
        method: "POST",
        signal: controller.signal,
        headers,
        body: JSON.stringify({
          messages: [
            { role: "system", content: SOURCE_SYSTEM_PROMPT },
            {
              role: "user",
              content: "استخرج كل النص الظاهر في صورة صفحة المنهج هذه حرفياً.",
            },
          ],
          image: imageDataUrl,
          max_tokens: 4000,
        }),
      };
      let res = await fetch(runUrl, nativeInit);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const lowered = body.toLowerCase();
        if (lowered.includes("model agreement") || lowered.includes("submit the prompt")) {
          const agreeRes = await fetch(runUrl, {
            method: "POST",
            signal: controller.signal,
            headers,
            body: JSON.stringify({ prompt: "agree" }),
          }).catch(() => null);
          if (agreeRes && agreeRes.ok) {
            res = await fetch(runUrl, nativeInit);
            if (!res.ok) {
              const retryBody = await res.text().catch(() => "");
              return {
                ok: false,
                code: "VISION_UPSTREAM",
                message: `Vision model license agreement required: submit the prompt 'agree' once for ${model} from the Cloudflare Workers AI Playground, then retry. Provider said: ${stripDataUris(retryBody).slice(0, 300)}`,
              };
            }
          } else {
            return {
              ok: false,
              code: "VISION_UPSTREAM",
              message: `Vision model license agreement required: submit the prompt 'agree' once for ${model} from the Cloudflare Workers AI Playground, then retry. Provider said: ${stripDataUris(body).slice(0, 300)}`,
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
      return { ok: true, text: extractTranscription(rawText) };
    }
    // Non-Cloudflare providers keep the OpenAI-compatible path below.
    const compatInit = {
      method: "POST",
      signal: controller.signal,
      headers,
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 4000,
        messages: [
          { role: "system", content: SOURCE_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: "استخرج كل النص الظاهر في صورة صفحة المنهج هذه حرفياً." },
              { type: "image_url", image_url: { url: imageDataUrl } },
            ],
          },
        ],
      }),
    };
    let res = await fetch(`${baseUrl}/chat/completions`, compatInit);
    if (!res.ok) {
      let failBody = await res.text().catch(() => "");
      // Same documented prompt-form agreement as the handwritten path:
      // a gated Llama vision model needs {"prompt": "agree"} on the
      // native run endpoint (submitted with this same key), then one
      // retry. Without this, the compat path stays gated while the
      // native handwritten path works.
      if (
        (failBody.toLowerCase().includes("model agreement") ||
          failBody.toLowerCase().includes("submit the prompt")) &&
        baseUrl.includes("api.cloudflare.com/client/v4/accounts/") &&
        /\/v1\/?$/.test(baseUrl)
      ) {
        const runUrl = `${baseUrl.replace(/\/v1\/?$/, "")}/run/${model}`;
        const agreeRes = await fetch(runUrl, {
          method: "POST",
          signal: controller.signal,
          headers,
          body: JSON.stringify({ prompt: "agree" }),
        }).catch(() => null);
        if (agreeRes && agreeRes.ok) {
          res = await fetch(`${baseUrl}/chat/completions`, compatInit);
          if (!res.ok) failBody = await res.text().catch(() => "");
        }
      }
      if (!res.ok) {
        const lowered = failBody.toLowerCase();
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
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string | unknown } }[];
    };
    const content = json.choices?.[0]?.message?.content;
    const rawText = typeof content === "string" ? content : "";
    if (!rawText.trim()) {
      return {
        ok: false,
        code: "VISION_PARSE_FAILED",
        message: "Vision provider returned no text.",
      };
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
 * ocrSourceImages — server function.
 * Call from the client as: ocrSourceImages({ data: { imageDataUrls, accessToken } })
 * Returns a discriminated result; it never throws for expected failures,
 * so the UI can distinguish "not configured" / "model can't read images"
 * from transient errors. Images are processed sequentially and the
 * first failure stops the batch (imageIndex names the failing image).
 */
export const ocrSourceImages = createServerFn({ method: "POST" }).handler(
  async ({ data }): Promise<SourceOcrResult> => {
    const d = (data ?? {}) as Record<string, unknown>;
    const imageDataUrls = Array.isArray(d.imageDataUrls) ? d.imageDataUrls : [];
    const accessToken = typeof d.accessToken === "string" ? d.accessToken : "";
    if (
      imageDataUrls.length === 0 ||
      imageDataUrls.length > MAX_IMAGES ||
      !imageDataUrls.every(
        (u) => typeof u === "string" && DATA_URL_RE.test(u) && u.length <= MAX_DATA_URL_CHARS,
      )
    ) {
      return {
        ok: false,
        code: "INVALID_INPUT",
        message: "imageDataUrls must be 1–5 jpeg/png/webp data URLs.",
      };
    }
    if (!accessToken.trim()) {
      return { ok: false, code: "INVALID_INPUT", message: "accessToken is required." };
    }

    const auth = await authorizeTeacher(accessToken);
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

    const texts: string[] = [];
    for (let i = 0; i < imageDataUrls.length; i++) {
      const result = await callVisionOcr(
        config.baseUrl,
        config.model,
        config.apiKey,
        imageDataUrls[i] as string,
      );
      if (!result.ok) {
        return { ok: false, code: result.code, message: result.message, imageIndex: i };
      }
      texts.push(result.text);
    }
    return { ok: true, texts };
  },
);

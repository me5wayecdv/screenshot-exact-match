/**
 * Server function for Phase 3 smart question-matching.
 *
 * Problem: a teacher photographs a whole exam paper (several pages)
 * instead of one answer per photo. This function matches each page to
 * a question of the selected assessment, so the teacher reviews the
 * matches and grades page by page through the existing single-grade
 * form — no second grading path is created.
 *
 * Matching strategy (cheapest reliable signal first):
 *   1. NUMBER: the vision call transcribes the page AND reports the
 *      question number visible on it (e.g. "السؤال ٣", "Q3"). A number
 *      inside the assessment's range matches directly (confidence
 *      high). Ordinal words (الثالث) are not parsed — those pages
 *      fall through to step 2.
 *   2. AI: a small text-model call compares the transcribed answer
 *      against the assessment's numbered question list and returns a
 *      question index + confidence (high/medium/low), or null.
 *   3. NONE: neither signal matched. The teacher picks the question
 *      manually in the UI (method becomes "manual" client-side).
 *
 * Auth model (mirrors handwritten.ts): the client sends its Supabase
 * session access token; the server validates it, requires a
 * teacher/admin role, and requires that the assessment belongs to
 * that teacher (admins exempt). Questions are read through the
 * teacher's own RLS-scoped client, so only their own assessment's
 * questions can ever be matched.
 *
 * Vision config is shared with handwritten OCR (resolveVisionConfig
 * from ./handwritten); the text match uses the plain text config
 * (resolveAiConfig from ./ai-config). If the text config is missing,
 * unmatched pages simply return method "none" instead of failing the
 * batch — number matches still work.
 *
 * Failure contract (mirrors source-ocr.ts): the first failing page
 * stops the batch with its pageIndex, so the teacher can retry that
 * page alone. Error codes reuse the handwritten OcrErrorCode union.
 */

import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { resolveVisionConfig, runImageToTextModel, type OcrErrorCode } from "./handwritten";
import { resolveAiConfig } from "./ai-config";
import { matchByNumber, parseQuestionNumber } from "@/lib/paper-match";

export type MatchConfidence = "high" | "medium" | "low" | "none";
export type MatchMethod = "number" | "ai" | "none";

export type MatchedPage = {
  /** Transcribed answer text (with ⟦⟧ uncertain markers, as in OCR). */
  text: string;
  /** Server storage path of the page photo (handwritten-papers). */
  imagePath: string;
  questionId: string | null;
  questionNumber: number | null;
  confidence: MatchConfidence;
  method: MatchMethod;
  /** Vision model that read the page. */
  model: string;
};

export type MatchResult =
  | { ok: true; pages: MatchedPage[] }
  | { ok: false; code: OcrErrorCode; message: string; pageIndex?: number };

const TEACHER_ROLES = new Set(["school_teacher", "tutor", "admin"]);

/** Client-compressed JPEGs are ~1 MB; 8M chars of data URL is a hard cap. */
const MAX_DATA_URL_CHARS = 8_000_000;
const DATA_URL_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
/** At most 10 page photos per matching batch (sequential vision calls). */
const MAX_PAGES = 10;

function serverSupabaseEnv(): { url: string; anonKey: string } | null {
  const url = process.env.SUPABASE_URL?.trim() || process.env.VITE_SUPABASE_URL?.trim();
  const anonKey =
    process.env.SUPABASE_ANON_KEY?.trim() ||
    process.env.VITE_SUPABASE_ANON_KEY?.trim() ||
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

/** Verify the caller is a teacher/admin who owns this assessment. */
async function authorize(
  accessToken: string,
  assessmentId: string,
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
    return { ok: false, message: "Only teachers can match paper pages." };
  }
  if (role !== "admin") {
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

type QuestionRow = { id: string; prompt: string; position: number };

async function loadQuestions(accessToken: string, assessmentId: string): Promise<QuestionRow[]> {
  const env = serverSupabaseEnv();
  if (!env) throw new Error("Server Supabase environment is not configured.");
  const supabase = createClient(env.url, env.anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase
    .from("questions")
    .select("id, prompt, position")
    .eq("assessment_id", assessmentId)
    .order("position");
  if (error || !data) throw new Error("DB_ERROR");
  return data as QuestionRow[];
}

const MATCH_SYSTEM_PROMPT =
  "أنت أداة استخراج نصوص من صور أوراق امتحانات مكتوبة بخط اليد. " +
  "أعد النص حرفياً كما هو، دون تصحيح ودون إضافة أي كلام من عندك. " +
  "الأجزاء غير المقروءة تماماً اكتب مكانها [غير واضح]. " +
  "النص الذي تقرأه بصعوبة أو غير متأكد منه ضعه بين علامتي ⟦ ⟧. " +
  "بالإضافة إلى النص، حدد رقم السؤال الظاهر في الصورة إن وجد (مثل: السؤال ٣، Q3، 3). " +
  "If the page is in English, transcribe it in English; if in Arabic, in Arabic — never translate. " +
  'أجب بصيغة JSON فقط: {"text": "...", "question_number": 3} — إن لم يظهر رقم سؤال ضع question_number: null.';

/**
 * Tolerate models that wrap the JSON in ```json fences or extra prose.
 * If no JSON object is found, the raw reply is still usable as text
 * with no question number — the teacher reviews it either way.
 */
function extractMatchReply(rawText: string): { text: string; questionNumber: number | null } {
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
      if (text !== null) {
        return { text, questionNumber: parseQuestionNumber(parsed.question_number) };
      }
    } catch {
      // Same tolerant fallback as the transcription extractors, plus
      // an optional question_number after the text field.
      const loose = candidate.match(
        /"text"\s*:\s*"([\s\S]*?)"\s*(,\s*"question_number"\s*:\s*(\d+))?\s*}\s*$/,
      );
      if (loose) {
        const decoded = loose[1]
          .replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
          .replace(/\\n/g, "\n")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\");
        return { text: decoded, questionNumber: loose[3] ? parseInt(loose[3], 10) : null };
      }
      // Fall through to raw-text handling below.
    }
  }
  return { text: candidate, questionNumber: null };
}

async function callVisionMatch(
  baseUrl: string,
  model: string,
  apiKey: string,
  imageDataUrl: string,
): Promise<
  | { ok: true; text: string; questionNumber: number | null }
  | { ok: false; code: OcrErrorCode; message: string }
> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
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
        "Transcribe the text in this image. If a question number is shown in the image, " +
          "write it on the first line as: Question number: N. Then write the transcription. " +
          "Return only that, nothing else.",
      );
      if (!llava.ok) return llava;
      const { text, questionNumber } = extractMatchReply(llava.text);
      return { ok: true, text, questionNumber };
    }
    const compatInit = {
      method: "POST",
      signal: controller.signal,
      headers,
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 4000,
        messages: [
          { role: "system", content: MATCH_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: "استخرج النص من هذه الصورة وحدد رقم السؤال الظاهر فيها." },
              { type: "image_url", image_url: { url: imageDataUrl } },
            ],
          },
        ],
      }),
    };
    let res = await fetch(`${baseUrl}/chat/completions`, compatInit);
    if (!res.ok) {
      let failBody = await res.text().catch(() => "");
      // Same documented prompt-form agreement as the handwritten path
      // (see source-ocr.ts): gated Llama needs {"prompt": "agree"}
      // on the native run endpoint, then one retry.
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
    const { text, questionNumber } = extractMatchReply(rawText);
    return { ok: true, text, questionNumber };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, code: "VISION_TIMEOUT", message: "Vision provider timed out." };
    }
    return { ok: false, code: "VISION_UPSTREAM", message: "Vision provider request failed." };
  } finally {
    clearTimeout(timeout);
  }
}

/** AI content match: which numbered question does this answer belong to? */
async function callTextMatch(
  baseUrl: string,
  model: string,
  apiKey: string,
  questions: QuestionRow[],
  answerText: string,
): Promise<{ index: number | null; confidence: "high" | "medium" | "low" }> {
  const list = questions.map((q, i) => `${i + 1}. ${(q.prompt || "").slice(0, 200)}`).join("\n");
  const prompt =
    "أنت أداة مطابقة إجابات لأسئلة اختبار. أمامك قائمة أسئلة مرقمة ونص إجابة " +
    "مستخرج من صورة ورقة. حدد أي سؤال تجيب عنه هذه الصفحة، أو null إن لم يتضح.\n" +
    "الأسئلة:\n" +
    list +
    "\nنص الإجابة:\n" +
    answerText.slice(0, 2000) +
    '\nأجب بصيغة JSON فقط: {"question_index": 2, "confidence": "medium"} — ' +
    "question_index هو رقم السؤال في القائمة (يبدأ من 1)، أو null عند عدم الوضوح. " +
    "confidence: high أو medium أو low.";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers,
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return { index: null, confidence: "low" };
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const raw = json.choices?.[0]?.message?.content ?? "";
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return { index: null, confidence: "low" };
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const idx =
      typeof parsed.question_index === "number" && Number.isInteger(parsed.question_index)
        ? parsed.question_index
        : null;
    const conf = parsed.confidence;
    const confidence: "high" | "medium" | "low" =
      conf === "high" || conf === "medium" || conf === "low" ? conf : "low";
    if (idx === null || idx < 1 || idx > questions.length) {
      return { index: null, confidence: "low" };
    }
    return { index: idx - 1, confidence };
  } catch {
    // Text-match failure is NOT fatal: the page falls back to "none"
    // and the teacher picks manually. Only vision failures stop the batch.
    return { index: null, confidence: "low" };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * matchPaperPages — server function.
 * Call from the client as: matchPaperPages({ data: { assessmentId, pages, accessToken } })
 * Returns a discriminated result; vision failures stop the batch with
 * pageIndex, text-match failures degrade to method "none" per page.
 */
export const matchPaperPages = createServerFn({ method: "POST" }).handler(
  async ({ data }): Promise<MatchResult> => {
    const d = (data ?? {}) as Record<string, unknown>;
    const assessmentId = typeof d.assessmentId === "string" ? d.assessmentId : "";
    const accessToken = typeof d.accessToken === "string" ? d.accessToken : "";
    const pages = Array.isArray(d.pages) ? d.pages : [];
    const validPage = (p: unknown): p is { imageDataUrl: string; imagePath: string } => {
      if (typeof p !== "object" || p === null) return false;
      const r = p as Record<string, unknown>;
      return (
        typeof r.imageDataUrl === "string" &&
        DATA_URL_RE.test(r.imageDataUrl) &&
        r.imageDataUrl.length <= MAX_DATA_URL_CHARS &&
        typeof r.imagePath === "string" &&
        r.imagePath.length <= 500
      );
    };
    if (!assessmentId || !accessToken.trim() || pages.length === 0 || pages.length > MAX_PAGES) {
      return {
        ok: false,
        code: "INVALID_INPUT",
        message: "assessmentId, accessToken and 1–10 pages are required.",
      };
    }
    if (!pages.every(validPage)) {
      return {
        ok: false,
        code: "INVALID_INPUT",
        message: "Each page needs a jpeg/png/webp data URL and an imagePath.",
      };
    }

    const auth = await authorize(accessToken, assessmentId);
    if (!auth.ok) return { ok: false, code: "UNAUTHORIZED", message: auth.message };

    const vision = resolveVisionConfig();
    if (!vision) {
      return {
        ok: false,
        code: "VISION_NOT_CONFIGURED",
        message:
          "Vision provider is not configured on the server (set AI_BASE_URL and AI_MODEL, plus AI_VISION_MODEL for a vision-capable model, and AI_API_KEY for hosted providers).",
      };
    }
    const textConfig = resolveAiConfig();
    const questions = await loadQuestions(accessToken, assessmentId);

    const out: MatchedPage[] = [];
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i] as { imageDataUrl: string; imagePath: string };
      const visionRes = await callVisionMatch(
        vision.baseUrl,
        vision.model,
        vision.apiKey,
        page.imageDataUrl,
      );
      if (!visionRes.ok) {
        return { ok: false, code: visionRes.code, message: visionRes.message, pageIndex: i };
      }
      const numberIdx =
        visionRes.questionNumber !== null
          ? matchByNumber(visionRes.questionNumber, questions.length)
          : null;
      if (numberIdx !== null) {
        out.push({
          text: visionRes.text,
          imagePath: page.imagePath,
          questionId: questions[numberIdx]!.id,
          questionNumber: visionRes.questionNumber,
          confidence: "high",
          method: "number",
          model: vision.model,
        });
        continue;
      }
      if (textConfig && questions.length > 0) {
        const ai = await callTextMatch(
          textConfig.baseUrl,
          textConfig.model,
          textConfig.apiKey,
          questions,
          visionRes.text,
        );
        if (ai.index !== null) {
          out.push({
            text: visionRes.text,
            imagePath: page.imagePath,
            questionId: questions[ai.index]!.id,
            questionNumber: null,
            confidence: ai.confidence,
            method: "ai",
            model: vision.model,
          });
          continue;
        }
      }
      out.push({
        text: visionRes.text,
        imagePath: page.imagePath,
        questionId: null,
        questionNumber: null,
        confidence: "none",
        method: "none",
        model: vision.model,
      });
    }
    return { ok: true, pages: out };
  },
);

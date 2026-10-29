import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Sparkles } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useI18n, translateError } from "@/lib/i18n";
import { useMe } from "@/lib/session";
import { PageHeader, Panel, Pill, Empty } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { generateAssessment } from "@/lib/generate-assessment";
import type { GenerateFailureCode } from "@/lib/ai-failure";
import type { GenerateDifficulty, GenerateQuestionType } from "@/lib/generate-assessment-prompt";
import { GENERATE_QUESTION_TYPES } from "@/lib/generate-assessment-prompt";
import { getHandwritingStatus } from "@/server/handwritten";
import { ocrSourceImages } from "@/server/source-ocr";

// Route file convention (verified against the repo listing at HEAD):
// src/routes/_authenticated/assessments.$id.tsx, assessments.index.tsx,
// assessments.take.$id.tsx, assessments.report.$id.tsx all live under
// _authenticated, so this file maps to /assessments/generate. TanStack
// Router prefers the static "generate" segment over the dynamic "$id"
// segment, so /assessments/generate does NOT fall through to the builder.
// routeTree.gen.ts is auto-generated — do not edit it by hand.
//
// Phase 2 SCOPE: pasted text PLUS file/image sources. PDF and Word
// files are parsed in the browser (pdfjs-dist / mammoth, dynamically
// imported so they never bloat the initial bundle); curriculum photos
// go through the vision OCR server function (src/server/source-ocr.ts).
// Every uploaded file is saved to the private 'generation-sources'
// bucket BEFORE extraction (platform rule: no browser-only uploads),
// and extracted text lands in the source textarea for the teacher to
// REVIEW and EDIT before any generation runs.
//
// Teacher-final-word: generation only ever saves an UNPUBLISHED draft.
// The success state links to the EXISTING builder route, where the
// teacher reviews/edits every question before publishing.

export const Route = createFileRoute("/_authenticated/assessments/generate")({
  head: () => ({
    meta: [
      { title: "Generate assessment · Qemmini" },
      { name: "description", content: "Generate a draft assessment from pasted curriculum text." },
    ],
  }),
  component: Generate,
});

/**
 * Map the server function's stable failure codes to i18n keys. The code is
 * always shown next to the message (persistent panel, not a toast), so a
 * failure is never invisible and never needs a re-run to diagnose.
 */
const GEN_ERROR_KEYS: Record<GenerateFailureCode, string> = {
  AI_NOT_CONFIGURED: "genAiKeyMissing",
  AI_AUTH: "genAiAuth",
  AI_RATE_LIMIT: "genRateLimit",
  AI_BAD_REQUEST: "genBadRequest",
  AI_UPSTREAM: "genUpstreamFailed",
  AI_TIMEOUT: "genTimeout",
  AI_EMPTY_REPLY: "genEmptyReply",
  AI_PARSE_FAILED: "genParseFailed",
  NOT_TEACHER: "genNotTeacher",
  VALIDATION: "genInvalidInput",
  DB_ERROR: "genDbError",
};

/** Server-side source-text cap (mirrors generate-assessment.ts). */
const MAX_SOURCE_CHARS = 30_000;
const MAX_DOC_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES = 5;

function appendSource(prev: string, text: string): string {
  const clean = text.trim();
  if (!clean) return prev;
  return prev.trim() ? `${prev.trim()}\n\n${clean}` : clean;
}

/** Compress an image to a ≤1600px JPEG (same bound as handwritten papers). */
async function compressImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable.");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.85),
  );
  if (!blob) throw new Error("Compression failed.");
  return blob;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Read failed."));
    reader.readAsDataURL(blob);
  });
}

/** Platform rule: every uploaded file is persisted server-side first. */
async function uploadSource(blob: Blob, ext: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("No session.");
  const path = `${user.id}/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from("generation-sources").upload(path, blob);
  if (error) throw error;
}

/** PDF text extraction (pdfjs-dist, dynamically imported). */
async function extractPdfText(arrayBuffer: ArrayBuffer): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  const { default: workerUrl } = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const doc = await pdfjs.getDocument({ data: arrayBuffer }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((it) => ("str" in it ? it.str : "")).join(" "));
  }
  return pages.join("\n\n").trim();
}

/** Word (.docx) text extraction (mammoth, dynamically imported). */
async function extractDocxText(arrayBuffer: ArrayBuffer): Promise<string> {
  const mammoth = await import("mammoth");
  const { value } = await mammoth.extractRawText({ arrayBuffer });
  return value.trim();
}

function Generate() {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const { data: me, isLoading: meLoading } = useMe();
  const { data: subjects } = useQuery({
    queryKey: ["generate-subjects"],
    queryFn: async () =>
      (await supabase.from("subjects").select("id, name").order("name")).data ?? [],
  });

  const [title, setTitle] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const [gradeLevel, setGradeLevel] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [count, setCount] = useState("5");
  const [types, setTypes] = useState<GenerateQuestionType[]>([...GENERATE_QUESTION_TYPES]);
  const [difficulty, setDifficulty] = useState<GenerateDifficulty>("mixed");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ id: string; title: string; n: number } | null>(null);
  // Persistent generation error: toasts auto-dismiss, so a failed
  // generation used to leave no trace. This panel stays until the next
  // submit (or a success) and keeps the raw error code for diagnosis.
  const [genError, setGenError] = useState<string | null>(null);
  const [fileBusy, setFileBusy] = useState(false);
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [visionOk, setVisionOk] = useState<boolean | null>(null);

  useEffect(() => {
    getHandwritingStatus({ data: {} })
      .then((s) => setVisionOk(s.configured))
      .catch(() => setVisionOk(null));
  }, []);

  if (meLoading) return <p className="text-muted-foreground">{t("loading")}</p>;
  if (!me || (me.role !== "school_teacher" && me.role !== "tutor")) {
    return <Empty>{t("genTeacherOnly")}</Empty>;
  }

  const sourceLen = sourceText.trim().length;
  const countNum = Number(count);
  const formValid =
    sourceLen >= 50 &&
    sourceLen <= MAX_SOURCE_CHARS &&
    types.length > 0 &&
    Number.isInteger(countNum) &&
    countNum >= 1 &&
    countNum <= 20;

  function toggleType(ty: GenerateQuestionType, on: boolean) {
    setTypes(on ? [...types, ty] : types.filter((x) => x !== ty));
  }

  function noteExtracted(name: string, text: string) {
    const msg = t("genExtracted", {
      name,
      count: String(text.trim().length),
    }) as string;
    setFileNote(msg);
    toast.success(msg);
  }

  async function handleDocFile(file: File) {
    const lower = file.name.toLowerCase();
    const isPdf = lower.endsWith(".pdf");
    const isDocx = lower.endsWith(".docx");
    if (!isPdf && !isDocx) return void toast.error(t("genDocUnsupported"));
    if (file.size > MAX_DOC_BYTES) return void toast.error(t("genFileTooBig"));
    setFileBusy(true);
    try {
      try {
        await uploadSource(file, isPdf ? "pdf" : "docx");
      } catch {
        toast.error(t("genUploadFailed"));
        return;
      }
      const buf = await file.arrayBuffer();
      const text = isPdf ? await extractPdfText(buf) : await extractDocxText(buf);
      if (text.trim().length < 50) {
        toast.error(t("genExtractFailed"));
        return;
      }
      setSourceText((prev) => appendSource(prev, text));
      noteExtracted(file.name, text);
    } catch {
      toast.error(t("genExtractFailed"));
    } finally {
      setFileBusy(false);
    }
  }

  async function splitImageBlob(blob: Blob): Promise<Blob[]> {
    const bitmap = await createImageBitmap(blob);
    try {
      const half = async (y0: number, y1: number): Promise<Blob> => {
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = Math.max(1, Math.round((y1 - y0) * bitmap.height));
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas unavailable.");
        ctx.drawImage(
          bitmap,
          0,
          y0 * bitmap.height,
          bitmap.width,
          (y1 - y0) * bitmap.height,
          0,
          0,
          canvas.width,
          canvas.height,
        );
        const out = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, "image/jpeg", 0.85),
        );
        if (!out) throw new Error("Compression failed.");
        return out;
      };
      // Four overlapping quarters: halves proved insufficient live
      // (dense Arabic page still exceeded the provider budget).
      return [
        await half(0, 0.3),
        await half(0.25, 0.55),
        await half(0.5, 0.8),
        await half(0.75, 1),
      ];
    } finally {
      bitmap.close();
    }
  }

  function joinSplitTexts(a: string, b: string): string {
    const aLines = a.split("\n");
    const bLines = b.split("\n");
    const norm = (s: string) => s.trim().replace(/\s+/g, " ");
    const max = Math.min(aLines.length, bLines.length, 10);
    let overlap = 0;
    for (let k = max; k > 0; k--) {
      const aTail = aLines.slice(-k).map(norm);
      const bHead = bLines.slice(0, k).map(norm);
      if (aTail.every((line, i) => line !== "" && line === bHead[i])) {
        overlap = k;
        break;
      }
    }
    return [...aLines, ...bLines.slice(overlap)].join("\n");
  }

  async function handleImageFiles(files: File[]) {
    if (files.length > MAX_IMAGES) return void toast.error(t("genTooManyImages"));
    if (files.some((f) => f.size > MAX_IMAGE_BYTES)) return void toast.error(t("genFileTooBig"));
    setOcrError(null);
    setFileBusy(true);
    try {
      const dataUrls: string[] = [];
      const blobs: Blob[] = [];
      for (const f of files) {
        const compressed = await compressImage(f);
        blobs.push(compressed);
        try {
          await uploadSource(compressed, "jpg");
        } catch {
          setOcrError("Upload to the generation-sources bucket failed.");
          toast.error(t("genUploadFailed"));
          return;
        }
        dataUrls.push(await blobToDataUrl(compressed));
      }
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await ocrSourceImages({
        data: { imageDataUrls: dataUrls, accessToken: session?.access_token ?? "" },
      });
      if (!res.ok) {
        // 408/timeout-only fallback (see handwritten.tsx): split each
        // page into overlapping quarters and transcribe those instead.
        // Per-file calls keep the batch within the 1–5 image limit.
        if (res.message.includes("408") || res.code === "VISION_TIMEOUT") {
          try {
            const perFile: string[] = [];
            for (let i = 0; i < files.length; i++) {
              const quarters = await splitImageBlob(blobs[i]);
              const quarterDataUrls: string[] = [];
              for (const quarter of quarters) {
                try {
                  await uploadSource(quarter, "jpg");
                } catch {
                  // Quarters are derivatives of an already-persisted
                  // original; a failed quarter upload must not block OCR.
                }
                quarterDataUrls.push(await blobToDataUrl(quarter));
              }
              const splitRes = await ocrSourceImages({
                data: { imageDataUrls: quarterDataUrls, accessToken: session?.access_token ?? "" },
              });
              if (!splitRes.ok || splitRes.texts.length !== 4) throw new Error("split failed");
              perFile.push(
                joinSplitTexts(
                  joinSplitTexts(
                    joinSplitTexts(splitRes.texts[0], splitRes.texts[1]),
                    splitRes.texts[2],
                  ),
                  splitRes.texts[3],
                ),
              );
            }
            const joined = perFile.join("\n\n");
            if (joined.trim().length >= 50) {
              setSourceText((prev) => appendSource(prev, joined));
              noteExtracted(files.map((f) => f.name).join("، "), joined);
              return;
            }
          } catch {
            // Fall through to the original error handling below.
          }
        }
        // Persistent panel (same pattern as the handwritten page): the
        // generic toast alone hides which stage failed, and this path
        // failed repeatedly with no diagnosable detail.
        setOcrError(`[${res.code}] ${res.message}`);
        if (res.code === "VISION_NOT_CONFIGURED") return void toast.error(t("genVisionMissing"));
        if (res.code === "VISION_UNSUPPORTED") return void toast.error(t("genVisionUnsupported"));
        return void toast.error(t("genOcrFailed"));
      }
      const text = res.texts.join("\n\n");
      if (text.trim().length < 50) {
        toast.error(t("genExtractFailed"));
        return;
      }
      setSourceText((prev) => appendSource(prev, text));
      noteExtracted(files.map((f) => f.name).join("، "), text);
    } catch {
      setOcrError("Photo OCR request failed (network or server error).");
      toast.error(t("genOcrFailed"));
    } finally {
      setFileBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!formValid || busy) return;
    setBusy(true);
    setGenError(null);
    try {
      const res = await generateAssessment({
        data: {
          title: title.trim(),
          subjectId: subjectId || null,
          gradeLevel: gradeLevel.trim(),
          sourceText: sourceText.trim(),
          questionCount: countNum,
          types,
          difficulty,
        },
      });
      // The server function RETURNS its failures (a thrown error loses its
      // message in production), so a non-ok result is the diagnosis.
      if (!res.ok) {
        const display = t(GEN_ERROR_KEYS[res.code] as never) as string;
        setGenError(
          res.detail ? `${display} [${res.code}] — ${res.detail}` : `${display} [${res.code}]`,
        );
        toast.error(display);
        return;
      }
      setResult({ id: res.assessmentId, title: res.title, n: res.questionCount });
      toast.success(t("genSuccess"));
    } catch (err) {
      // Only transport-level failures reach here (offline, 500 page, CSRF):
      // keep the raw message in the panel so they are diagnosable too.
      const msg = err instanceof Error ? err.message : String(err);
      const display = translateError(err, lang);
      toast.error(display);
      setGenError(`${display} [NETWORK] — ${msg}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title={t("genTitle")}
        subtitle={t("genSubtitle")}
        actions={
          <Button variant="outline" onClick={() => navigate({ to: "/assessments" })}>
            {t("genBackToAssessments")}
          </Button>
        }
      />

      {result ? (
        <Panel className="space-y-4">
          <p className="flex flex-wrap items-center gap-2">
            <Pill>{t("st_draft")}</Pill>
            <span className="font-semibold">{result.title}</span>
          </p>
          <p className="text-sm text-muted-foreground">
            {t("genDraftSaved", { count: String(result.n) })}
          </p>
          <p className="text-sm">{t("genDraftNote")}</p>
          <div className="flex flex-wrap gap-2">
            <Link to="/assessments/$id" params={{ id: result.id }}>
              <Button>{t("genOpenBuilder")}</Button>
            </Link>
            <Button variant="outline" onClick={() => setResult(null)}>
              {t("genGenerateAnother")}
            </Button>
          </div>
        </Panel>
      ) : (
        <form onSubmit={submit}>
          <Panel className="space-y-5">
            <p className="rounded-md bg-warning/20 p-3 text-sm">{t("genDraftNote")}</p>
            {genError ? (
              <p role="alert" className="rounded-md bg-destructive/15 p-3 text-sm">
                {genError}
              </p>
            ) : null}
            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="g-title">{t("genTitleOptional")}</Label>
                <Input
                  id="g-title"
                  value={title}
                  maxLength={200}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t("title")}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="g-subj">{t("subject")}</Label>
                <select
                  id="g-subj"
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  value={subjectId}
                  onChange={(e) => setSubjectId(e.target.value)}
                >
                  <option value="">—</option>
                  {(subjects ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="g-grade">{t("gradeLevel")}</Label>
                <Input
                  id="g-grade"
                  value={gradeLevel}
                  maxLength={60}
                  onChange={(e) => setGradeLevel(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="g-source">{t("genSourceText")}</Label>
              <Textarea
                id="g-source"
                rows={10}
                value={sourceText}
                onChange={(e) => setSourceText(e.target.value)}
                placeholder={t("genSourcePlaceholder")}
              />
              <p className="text-xs text-muted-foreground">
                {t("genSourceHint")} · {sourceLen} / {MAX_SOURCE_CHARS}
              </p>
              <p className="text-xs text-muted-foreground">{t("genFileNote")}</p>
            </div>

            <div className="space-y-3 rounded-md border p-3">
              <div className="space-y-1.5">
                <Label>{t("genUploadDoc")}</Label>
                <Input
                  type="file"
                  accept=".pdf,.docx"
                  disabled={fileBusy}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) void handleDocFile(f);
                  }}
                />
                <p className="text-xs text-muted-foreground">{t("genUploadDocHint")}</p>
              </div>
              <div className="space-y-1.5">
                <Label>{t("genUploadImages")}</Label>
                <Input
                  type="file"
                  accept="image/*"
                  multiple
                  disabled={fileBusy || visionOk === false}
                  onChange={(e) => {
                    const fs = [...(e.target.files ?? [])];
                    e.target.value = "";
                    if (fs.length) void handleImageFiles(fs);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  {visionOk === false ? t("genVisionMissing") : t("genUploadImagesHint")}
                </p>
              </div>
              {fileBusy && <p className="text-sm text-muted-foreground">{t("genExtracting")}</p>}
              {fileNote && <p className="text-sm text-muted-foreground">{fileNote}</p>}
              {ocrError && (
                <div
                  role="alert"
                  className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm"
                >
                  {ocrError}
                </div>
              )}
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="g-count">{t("genQuestionCount")}</Label>
                <Input
                  id="g-count"
                  type="number"
                  min={1}
                  max={20}
                  step={1}
                  dir="ltr"
                  value={count}
                  onChange={(e) => setCount(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="g-diff">{t("genDifficulty")}</Label>
                <select
                  id="g-diff"
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  value={difficulty}
                  onChange={(e) => setDifficulty(e.target.value as GenerateDifficulty)}
                >
                  <option value="mixed">{t("genDiffMixed")}</option>
                  <option value="easy">{t("genDiffEasy")}</option>
                  <option value="medium">{t("genDiffMedium")}</option>
                  <option value="hard">{t("genDiffHard")}</option>
                </select>
              </div>
              <fieldset className="space-y-2 md:col-span-2">
                <legend className="text-sm font-medium">{t("genQuestionTypes")}</legend>
                {GENERATE_QUESTION_TYPES.map((ty) => (
                  <label key={ty} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={types.includes(ty)}
                      onCheckedChange={(v) => toggleType(ty, !!v)}
                    />
                    {t(`q_${ty}` as never)}
                  </label>
                ))}
              </fieldset>
            </div>

            {!formValid && sourceText && (
              <p className="text-sm text-destructive">
                {sourceLen < 50
                  ? t("genNeedSource")
                  : sourceLen > MAX_SOURCE_CHARS
                    ? t("genTooLong")
                    : types.length === 0
                      ? t("genNeedType")
                      : t("genInvalidInput")}
              </p>
            )}
            <Button disabled={!formValid || busy}>
              <Sparkles className="h-4 w-4" aria-hidden />{" "}
              {busy ? t("genGenerating") : t("genGenerate")}
            </Button>
          </Panel>
        </form>
      )}
    </>
  );
}

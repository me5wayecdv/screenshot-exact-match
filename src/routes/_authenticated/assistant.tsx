import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ClipboardCheck,
  ClipboardCopy,
  FileQuestion,
  GraduationCap,
  MessageSquareText,
  RotateCcw,
  Send,
  TrendingUp,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Empty, PageHeader, Panel } from "@/components/ui-kit";
import { useI18n } from "@/lib/i18n";
import { useMe } from "@/lib/session";
import type { AssistantChatMessage } from "@/lib/teacher-assistant";
import { explainLesson } from "@/server/lesson-explain";
import { uploadLessonSourceD1 } from "@/server/d1-assistant";
import { ocrSourceImages } from "@/server/source-ocr";
import { askTeacherAssistant, getTeacherAssistantOverview } from "@/server/teacher-assistant";

export const Route = createFileRoute("/_authenticated/assistant")({
  head: () => ({
    meta: [
      { title: "Teacher assistant · Qayyimni" },
      {
        name: "description",
        content: "A practical assistant for lesson planning and assessment review.",
      },
    ],
  }),
  component: TeacherAssistantPage,
});

const starterPromptKeys = [
  "assistantPromptLesson",
  "assistantPromptQuestions",
  "assistantPromptRubric",
  "assistantPromptFeedback",
  "assistantPromptResults",
] as const;

/** File limits mirror assessment generation (same bucket, same pipeline). */
const MAX_DOC_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Compress an image to a ≤1600px JPEG (same bound as generation sources). */
async function compressExplainImage(file: File): Promise<Blob> {
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
async function uploadExplainSource(blob: Blob, ext: string): Promise<void> {
  // D1: mediated R2 put into the private generation-sources bucket
  // under {teacher_id}/{uuid}/{name}. A failed upload throws, and
  // the caller aborts extraction — the file is never skipped.
  const dataUrl = await blobToDataUrl(blob);
  await uploadLessonSourceD1({ data: { dataUrl, fileName: `lesson.${ext}` } });
}

/** PDF text extraction (pdfjs-dist, dynamically imported). */
async function extractExplainPdfText(arrayBuffer: ArrayBuffer): Promise<string> {
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
async function extractExplainDocxText(arrayBuffer: ArrayBuffer): Promise<string> {
  const mammoth = await import("mammoth");
  const { value } = await mammoth.extractRawText({ arrayBuffer });
  return value.trim();
}

function TeacherAssistantPage() {
  const { t, lang } = useI18n();
  const { data: me, isLoading: meLoading } = useMe();
  const [messages, setMessages] = useState<AssistantChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [explainFile, setExplainFile] = useState<File | null>(null);
  const [explainBusy, setExplainBusy] = useState(false);
  const [explanation, setExplanation] = useState<{
    text: string;
    truncated: boolean;
    originalChars: number;
    cappedChars: number;
  } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const teacher = me?.role === "school_teacher" || me?.role === "tutor";

  const overview = useQuery({
    queryKey: ["teacher-assistant-overview", me?.id],
    enabled: !!me && teacher,
    queryFn: () => getTeacherAssistantOverview({ data: {} }),
    staleTime: 60_000,
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy]);

  if (meLoading) return <p className="text-muted-foreground">{t("loading")}</p>;
  if (!me || !teacher) return <Empty>{t("assistantTeacherOnly")}</Empty>;

  const overviewData = overview.data?.ok ? overview.data : null;
  const configured = overviewData?.configured ?? false;
  const summary = overviewData?.summary;
  const canSend = configured && !busy && !overview.isLoading;

  async function send(text = draft.trim()) {
    const content = text.trim();
    if (!content || !canSend) return;
    const userMessage: AssistantChatMessage = { role: "user", content };
    const nextMessages = [...messages.slice(-10), userMessage];
    setMessages((current) => [...current, userMessage]);
    setDraft("");
    setBusy(true);
    try {
      const result = await askTeacherAssistant({
        data: { language: lang, messages: nextMessages },
      });
      if (!result.ok) {
        const key =
          result.code === "AI_NOT_CONFIGURED"
            ? "assistantNotConfigured"
            : result.code === "AI_RATE_LIMIT"
              ? "assistantRateLimit"
              : result.code === "AI_TIMEOUT"
                ? "assistantTimeout"
                : result.code === "UNAUTHORIZED"
                  ? "assistantTeacherOnly"
                  : result.code === "DB_ERROR"
                    ? "assistantDataError"
                    : "assistantError";
        toast.error(t(key as Parameters<typeof t>[0]));
        return;
      }
      setMessages((current) => [...current, { role: "assistant", content: result.reply }]);
    } catch {
      toast.error(t("assistantError"));
    } finally {
      setBusy(false);
    }
  }

  async function copyReply(content: string) {
    try {
      await navigator.clipboard.writeText(content);
      toast.success(t("assistantCopied"));
    } catch {
      toast.error(t("assistantCopyFailed"));
    }
  }

  async function copyExplanation(content: string) {
    try {
      await navigator.clipboard.writeText(content);
      toast.success(t("lessonExplainCopied"));
    } catch {
      toast.error(t("assistantCopyFailed"));
    }
  }

  /**
   * Explain a lesson from an uploaded file. This path is separate from the
   * 1,500-char chat input: the file is persisted to the private
   * generation-sources bucket first (same pattern as assessment
   * generation), text is extracted (browser parsing for PDF/Word,
   * source-ocr for photos), and the server caps at 30,000 chars and
   * explains the capped text. Nothing is saved — the explanation lives
   * in this panel only, so the copy button is mandatory.
   */
  async function explainFromFile() {
    if (!explainFile || explainBusy || !configured) return;
    const lower = explainFile.name.toLowerCase();
    const isPdf = lower.endsWith(".pdf");
    const isDocx = lower.endsWith(".docx");
    const isImage = /\.(jpg|jpeg|png|webp)$/.test(lower);
    if (!isPdf && !isDocx && !isImage) {
      toast.error(t("lessonExplainUnsupported"));
      return;
    }
    if ((isPdf || isDocx) && explainFile.size > MAX_DOC_BYTES) {
      toast.error(t("lessonExplainFileTooBig"));
      return;
    }
    if (isImage && explainFile.size > MAX_IMAGE_BYTES) {
      toast.error(t("lessonExplainFileTooBig"));
      return;
    }
    setExplainBusy(true);
    setExplanation(null);
    try {
      let text = "";
      if (isPdf || isDocx) {
        try {
          await uploadExplainSource(explainFile, isPdf ? "pdf" : "docx");
        } catch {
          toast.error(t("lessonExplainUploadFailed"));
          return;
        }
        const buf = await explainFile.arrayBuffer();
        text = isPdf ? await extractExplainPdfText(buf) : await extractExplainDocxText(buf);
      } else {
        const compressed = await compressExplainImage(explainFile);
        try {
          await uploadExplainSource(compressed, "jpg");
        } catch {
          toast.error(t("lessonExplainUploadFailed"));
          return;
        }
        // D1 (Phase 2b): source OCR resolves the teacher session from
        // the HttpOnly cookie; no token is sent from the browser.
        // The file upload above is D1/R2.
        const res = await ocrSourceImages({
          data: {
            imageDataUrls: [await blobToDataUrl(compressed)],
          },
        });
        if (!res.ok) {
          toast.error(t("lessonExplainExtractFailed"));
          return;
        }
        text = res.texts[0] ?? "";
      }
      if (text.trim().length < 50) {
        toast.error(t("lessonExplainTooShort"));
        return;
      }
      toast.success(
        t("genExtracted", {
          name: explainFile.name,
          count: String(text.trim().length),
        }) as string,
      );
      const result = await explainLesson({ data: { language: lang, sourceText: text } });
      if (!result.ok) {
        const key =
          result.code === "AI_NOT_CONFIGURED"
            ? "assistantNotConfigured"
            : result.code === "AI_RATE_LIMIT"
              ? "assistantRateLimit"
              : result.code === "AI_TIMEOUT"
                ? "assistantTimeout"
                : result.code === "UNAUTHORIZED"
                  ? "assistantTeacherOnly"
                  : "assistantError";
        toast.error(t(key as Parameters<typeof t>[0]));
        return;
      }
      setExplanation({
        text: result.explanation,
        truncated: result.truncated,
        originalChars: result.originalChars,
        cappedChars: result.cappedChars,
      });
    } catch {
      toast.error(t("lessonExplainExtractFailed"));
    } finally {
      setExplainBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={t("assistantTitle")}
        subtitle={t("assistantSubtitle")}
        actions={
          <>
            <Button asChild variant="outline">
              <Link to="/assessments/generate">
                <FileQuestion aria-hidden />
                {t("assistantBuildAssessment")}
              </Link>
            </Button>
            <Button asChild>
              <Link to="/grading">
                <ClipboardCheck aria-hidden />
                {t("assistantOpenGrading")}
              </Link>
            </Button>
          </>
        }
      />

      <section
        aria-label={t("assistantWorkspaceSummary")}
        className="mb-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-5"
      >
        {[
          { label: t("assistantAssessments"), value: summary?.assessments },
          { label: t("assistantDrafts"), value: summary?.drafts },
          { label: t("assistantPending"), value: summary?.pendingReviews },
          { label: t("assistantReleased"), value: summary?.releasedResults },
          {
            label: t("assistantAverageReleased"),
            value: summary
              ? summary.averageReleasedPercent === null
                ? "—"
                : `${summary.averageReleasedPercent}%`
              : undefined,
          },
        ].map((card) => (
          <Panel key={card.label} className="p-4">
            <p className="text-xs text-muted-foreground">{card.label}</p>
            <p className="mt-2 font-display text-2xl font-bold text-primary">
              {overview.isLoading ? "—" : (card.value ?? "—")}
            </p>
          </Panel>
        ))}
      </section>
      <p className="mb-5 text-xs leading-5 text-muted-foreground">{t("assistantAveragePrivacy")}</p>

      {overviewData && !configured && (
        <div
          role="status"
          className="mb-5 rounded-md border border-warning/50 bg-warning/15 p-4 text-sm leading-6 text-warning-foreground"
        >
          {t("assistantNotConfigured")}
        </div>
      )}
      {overview.data && !overview.data.ok && overview.data.code === "UNAUTHORIZED" ? (
        <div
          role="status"
          className="mb-5 rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive"
        >
          {t("assistantTeacherOnly")}
        </div>
      ) : null}
      {overview.isError ||
      (overview.data && !overview.data.ok && overview.data.code === "DB_ERROR") ? (
        <div
          role="status"
          className="mb-5 rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive"
        >
          {t("assistantDataError")}
        </div>
      ) : null}

      <Panel className="mb-5 p-4 sm:p-5">
        <h2 className="font-semibold">{t("lessonExplainTitle")}</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          {t("lessonExplainDescription")}
        </p>
        <div className="mt-4 space-y-2">
          <Label htmlFor="lesson-explain-file">{t("lessonExplainChooseFile")}</Label>
          <Input
            id="lesson-explain-file"
            type="file"
            accept=".pdf,.docx,.jpg,.jpeg,.png,.webp"
            disabled={explainBusy}
            onChange={(event) => setExplainFile(event.target.files?.[0] ?? null)}
          />
          <p className="text-xs text-muted-foreground">{t("lessonExplainFileHint")}</p>
          <Button
            type="button"
            disabled={!explainFile || explainBusy || !configured}
            onClick={() => void explainFromFile()}
          >
            <Upload aria-hidden />
            {explainBusy ? t("lessonExplainExplaining") : t("lessonExplainExplain")}
          </Button>
          {explainBusy && (
            <p className="text-sm text-muted-foreground" role="status">
              {t("lessonExplainExplaining")}
            </p>
          )}
        </div>
        {explanation && (
          <div className="mt-5 border-t pt-4">
            {explanation.truncated && (
              <p
                role="status"
                className="mb-3 rounded-md border border-warning/50 bg-warning/15 p-3 text-sm leading-6 text-warning-foreground"
              >
                {t("lessonExplainTruncated", {
                  original: String(explanation.originalChars),
                  capped: String(explanation.cappedChars),
                })}
              </p>
            )}
            <p className="whitespace-pre-wrap text-sm leading-7">{explanation.text}</p>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void copyExplanation(explanation.text)}
              >
                <ClipboardCopy aria-hidden />
                {t("lessonExplainCopy")}
              </Button>
              <p className="max-w-xl text-xs leading-5 text-muted-foreground">
                {t("lessonExplainSafety")}
              </p>
            </div>
          </div>
        )}
      </Panel>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <Panel className="overflow-hidden p-0">
          <div className="flex items-center justify-between gap-3 border-b px-4 py-3 sm:px-5">
            <div className="flex items-center gap-3">
              <span className="grid size-9 place-items-center rounded-sm bg-secondary text-primary">
                <MessageSquareText className="size-4" aria-hidden />
              </span>
              <div>
                <h2 className="text-sm font-semibold">{t("assistantConversation")}</h2>
                <p className="text-xs text-muted-foreground">{t("assistantSessionOnly")}</p>
              </div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={messages.length === 0 || busy}
              onClick={() => setMessages([])}
            >
              <RotateCcw aria-hidden />
              {t("assistantNewChat")}
            </Button>
          </div>

          <div
            className="assistant-chat-area px-4 py-5 sm:px-6"
            role="log"
            aria-live="polite"
            aria-label={t("assistantConversation")}
          >
            {messages.length === 0 ? (
              <div className="py-3">
                <p className="mb-4 text-sm leading-7 text-muted-foreground">
                  {t("assistantWelcome")}
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {starterPromptKeys.map((key) => (
                    <button
                      key={key}
                      type="button"
                      disabled={!canSend}
                      onClick={() => void send(t(key))}
                      className="rounded-sm border bg-background px-3 py-3 text-start text-sm leading-6 transition-colors hover:border-primary/50 hover:bg-secondary/50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {t(key)}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {messages.map((message, index) => (
                  <div
                    key={`${index}-${message.role}`}
                    className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
                  >
                    <article
                      className={`max-w-[92%] rounded-md px-4 py-3 sm:max-w-[82%] ${
                        message.role === "user"
                          ? "bg-primary text-primary-foreground"
                          : "border bg-muted/60 text-foreground"
                      }`}
                    >
                      <p className="whitespace-pre-wrap text-sm leading-7">{message.content}</p>
                      {message.role === "assistant" && (
                        <div className="mt-2 flex justify-end border-t border-border/60 pt-2">
                          <button
                            type="button"
                            onClick={() => void copyReply(message.content)}
                            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                          >
                            <ClipboardCopy className="size-3.5" aria-hidden />
                            {t("assistantCopy")}
                          </button>
                        </div>
                      )}
                    </article>
                  </div>
                ))}
                {busy && (
                  <p className="text-sm text-muted-foreground" role="status">
                    {t("assistantThinking")}
                  </p>
                )}
                <div ref={bottomRef} />
              </div>
            )}
          </div>

          <form
            className="border-t bg-background/70 p-3 sm:p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <Label htmlFor="assistant-message" className="sr-only">
              {t("assistantMessageLabel")}
            </Label>
            <div className="flex items-end gap-2">
              <Textarea
                id="assistant-message"
                value={draft}
                maxLength={1_500}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault();
                    void send();
                  }
                }}
                placeholder={t("assistantPlaceholder")}
                disabled={!configured || busy}
                rows={2}
                className="min-h-12 resize-y bg-card"
              />
              <Button
                type="submit"
                size="icon"
                className="size-12 shrink-0"
                disabled={!canSend || !draft.trim()}
                aria-label={t("assistantSend")}
              >
                <Send className="rtl:rotate-180" aria-hidden />
              </Button>
            </div>
            <p className="mt-2 flex justify-between gap-3 text-[11px] text-muted-foreground">
              <span>{t("assistantPrivacyNote")}</span>
              <span dir="ltr" className="shrink-0 tabular-nums">
                {draft.length}/1500
              </span>
            </p>
          </form>
        </Panel>

        <aside className="space-y-4">
          <Panel>
            <div className="flex items-center gap-2">
              <GraduationCap className="size-4 text-primary" aria-hidden />
              <h2 className="font-semibold">{t("assistantTools")}</h2>
            </div>
            <div className="mt-4 space-y-2">
              <Link to="/assessments/generate" className="assistant-tool-link">
                <FileQuestion className="size-4" aria-hidden />
                <span>{t("assistantBuildAssessment")}</span>
              </Link>
              <Link to="/grading" className="assistant-tool-link">
                <MessageSquareText className="size-4" aria-hidden />
                <span>{t("assistantOpenGrading")}</span>
              </Link>
              <Link to="/analytics" className="assistant-tool-link">
                <TrendingUp className="size-4" aria-hidden />
                <span>{t("assistantOpenAnalytics")}</span>
              </Link>
            </div>
          </Panel>
          <Panel className="border-dashed bg-transparent shadow-none">
            <p className="text-sm font-semibold">{t("assistantReminderTitle")}</p>
            <p className="mt-2 text-xs leading-6 text-muted-foreground">
              {t("assistantReminderBody")}
            </p>
          </Panel>
        </aside>
      </div>
    </div>
  );
}

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
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Empty, PageHeader, Panel } from "@/components/ui-kit";
import { useI18n } from "@/lib/i18n";
import { useMe } from "@/lib/session";
import type { AssistantChatMessage } from "@/lib/teacher-assistant";
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

function TeacherAssistantPage() {
  const { t, lang } = useI18n();
  const { data: me, isLoading: meLoading } = useMe();
  const [messages, setMessages] = useState<AssistantChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
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

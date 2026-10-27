import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
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
import type { GenerateQuestionType } from "@/lib/generate-assessment-prompt";
import { GENERATE_QUESTION_TYPES } from "@/lib/generate-assessment-prompt";

// Route file convention (verified against the repo listing at HEAD):
// src/routes/_authenticated/assessments.$id.tsx, assessments.index.tsx,
// assessments.take.$id.tsx, assessments.report.$id.tsx all live under
// _authenticated, so this file maps to /assessments/generate. TanStack
// Router prefers the static "generate" segment over the dynamic "$id"
// segment, so /assessments/generate does NOT fall through to the builder.
// routeTree.gen.ts is auto-generated — do not edit it by hand.
//
// V1 SCOPE: pasted chapter/lesson text ONLY. There is no PDF upload or
// PDF parsing in this slice (explicit follow-up); the UI says so plainly
// (genPdfNote) instead of implying uploads work.
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

/** Map the server function's stable error codes to i18n keys. */
function genErrorKey(msg: string): string | null {
  if (msg.includes("AI_NOT_CONFIGURED")) return "genAiKeyMissing";
  if (msg.includes("AI_PARSE_FAILED")) return "genParseFailed";
  if (msg.includes("AI_TIMEOUT")) return "genTimeout";
  if (msg.includes("AI_UPSTREAM")) return "genUpstreamFailed";
  if (msg.includes("NOT_TEACHER")) return "genNotTeacher";
  if (msg.includes("VALIDATION")) return "genInvalidInput";
  return null;
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
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ id: string; title: string; n: number } | null>(null);

  if (meLoading) return <p className="text-muted-foreground">{t("loading")}</p>;
  if (!me || (me.role !== "school_teacher" && me.role !== "tutor")) {
    return <Empty>{t("genTeacherOnly")}</Empty>;
  }

  const sourceLen = sourceText.trim().length;
  const countNum = Number(count);
  const formValid =
    sourceLen >= 50 &&
    types.length > 0 &&
    Number.isInteger(countNum) &&
    countNum >= 1 &&
    countNum <= 20;

  function toggleType(ty: GenerateQuestionType, on: boolean) {
    setTypes(on ? [...types, ty] : types.filter((x) => x !== ty));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!formValid || busy) return;
    setBusy(true);
    try {
      const res = await generateAssessment({
        data: {
          title: title.trim(),
          subjectId: subjectId || null,
          gradeLevel: gradeLevel.trim(),
          sourceText: sourceText.trim(),
          questionCount: countNum,
          types,
        },
      });
      setResult({ id: res.assessmentId, title: res.title, n: res.questionCount });
      toast.success(t("genSuccess"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const key = genErrorKey(msg);
      toast.error(key ? (t(key as never) as string) : translateError(err, lang));
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
                maxLength={12000}
                onChange={(e) => setSourceText(e.target.value)}
                placeholder={t("genSourcePlaceholder")}
              />
              <p className="text-xs text-muted-foreground">
                {t("genSourceHint")} · {sourceLen} / 12000
              </p>
              <p className="text-xs text-muted-foreground">{t("genPdfNote")}</p>
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
              <fieldset className="space-y-2">
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

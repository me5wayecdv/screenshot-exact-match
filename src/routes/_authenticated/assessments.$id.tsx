import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ArrowUp, ArrowDown, Trash2, Plus } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { useI18n, translateError, formatDate } from "@/lib/i18n";
import { PageHeader, Panel, Pill, statusTone } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { WhatsAppAutoSendToggle } from "@/components/whatsapp-auto-send-toggle";

type QType = Database["public"]["Enums"]["question_type"];
type Status = Database["public"]["Enums"]["assessment_status"];

export const Route = createFileRoute("/_authenticated/assessments/$id")({
  head: () => ({
    meta: [
      { title: "Assessment builder · Qayyimni" },
      { name: "description", content: "Edit questions, answer keys and assignments." },
    ],
  }),
  component: Builder,
});

function useBuilderData(id: string) {
  return useQuery({
    queryKey: ["builder", id],
    queryFn: async () => {
      const [a, q, subj, st, asg, subs] = await Promise.all([
        supabase.from("assessments").select("*").eq("id", id).single(),
        supabase
          .from("questions")
          .select("*, question_keys(*)")
          .eq("assessment_id", id)
          .order("position"),
        supabase.from("subjects").select("id, name").order("name"),
        supabase.rpc("my_students"),
        supabase.from("assessment_assignments").select("student_id").eq("assessment_id", id),
        supabase.from("submissions").select("id").eq("assessment_id", id),
      ]);
      if (a.error) throw a.error;
      return {
        a: a.data,
        questions: q.data ?? [],
        subjects: subj.data ?? [],
        students: st.data ?? [],
        assigned: new Set((asg.data ?? []).map((x) => x.student_id)),
        submissionCount: subs.data?.length ?? 0,
      };
    },
  });
}

function Builder() {
  const { id } = Route.useParams();
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const { data, isLoading, error } = useBuilderData(id);
  const refresh = () => qc.invalidateQueries({ queryKey: ["builder", id] });

  if (isLoading) return <p className="text-muted-foreground">{t("loading")}</p>;
  if (error || !data) return <p>{t("notFound")}</p>;
  const { a, questions } = data;
  const locked = data.submissionCount > 0;
  const total = questions.reduce((s, q) => s + Number(q.marks), 0);

  async function setStatus(s: Status) {
    const { error } = await supabase.rpc("set_assessment_status", { _a: id, _status: s });
    if (error) return void toast.error(translateError(error, lang));
    refresh();
  }
  async function addQuestion(type: QType) {
    const { data: q, error } = await supabase
      .from("questions")
      .insert({
        assessment_id: id,
        type,
        position: questions.length,
        options: type === "mcq" ? ["", ""] : [],
      })
      .select("id")
      .single();
    if (error) return void toast.error(translateError(error, lang));
    await supabase
      .from("question_keys")
      .insert({ question_id: q.id, correct_answer: type === "true_false" ? "true" : "" });
    refresh();
  }
  async function move(idx: number, dir: -1 | 1) {
    const other = questions[idx + dir];
    if (!other) return;
    const cur = questions[idx]!;
    await Promise.all([
      supabase
        .from("questions")
        .update({ position: idx + dir })
        .eq("id", cur.id),
      supabase.from("questions").update({ position: idx }).eq("id", other.id),
    ]);
    refresh();
  }
  async function toggleAssign(studentId: string, on: boolean) {
    const { error } = on
      ? await supabase
          .from("assessment_assignments")
          .insert({ assessment_id: id, student_id: studentId })
      : await supabase
          .from("assessment_assignments")
          .delete()
          .eq("assessment_id", id)
          .eq("student_id", studentId);
    if (error) return void toast.error(translateError(error, lang));
    refresh();
  }

  const transitions: Record<Status, { to: Status; label: string; variant?: "outline" }[]> = {
    draft: [{ to: "published", label: t("publish") }],
    published: [
      { to: "closed", label: t("close"), variant: "outline" },
      ...(locked
        ? []
        : [{ to: "draft" as Status, label: t("unpublish"), variant: "outline" as const }]),
    ],
    closed: [
      { to: "published", label: t("reopen"), variant: "outline" },
      { to: "archived", label: t("archive"), variant: "outline" },
    ],
    archived: [{ to: "closed", label: t("reopen"), variant: "outline" }],
  };

  return (
    <>
      <PageHeader
        title={a.title}
        subtitle={
          <span className="flex items-center gap-2">
            <Pill t={statusTone[a.status]}>{t(`st_${a.status}` as never)}</Pill>
            {t("totalMarks")}: {total} · {t("questions")}: {questions.length}
          </span>
        }
        actions={
          <>
            {transitions[a.status].map((tr) => (
              <Button key={tr.to} variant={tr.variant} onClick={() => setStatus(tr.to)}>
                {tr.label}
              </Button>
            ))}
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <MetaEditor a={a} subjects={data.subjects} onSaved={refresh} />
          {locked && <p className="rounded-md bg-warning/20 p-3 text-sm">{t("lockedNote")}</p>}
          {questions.map((q, i) => (
            <QuestionEditor
              key={q.id}
              q={q}
              index={i}
              count={questions.length}
              locked={locked}
              onMove={(d) => move(i, d)}
              onChanged={refresh}
            />
          ))}
          {!locked && (
            <>
              <Panel>
                <p className="mb-3 text-sm font-medium">{t("addQuestion")}</p>
                <div className="flex flex-wrap gap-2">
                  {(["mcq", "true_false", "short_answer", "written"] as QType[]).map((ty) => (
                    <Button key={ty} variant="outline" size="sm" onClick={() => addQuestion(ty)}>
                      <Plus className="h-4 w-4" aria-hidden /> {t(`q_${ty}` as never)}
                    </Button>
                  ))}
                </div>
              </Panel>
              <QuestionBank assessmentId={id} positionBase={questions.length} onAdded={refresh} />
            </>
          )}
        </div>
        <aside>
          <Panel>
            <h2 className="mb-3 font-semibold">{t("assignTo")}</h2>
            {/* Why a "missing" assessment is usually not a bug: RLS only
                shows a student an assessment that is published AND assigned
                to them, so a published exam with zero assignments is
                invisible to every student. Say it here, next to the fix. */}
            {a.status === "published" && data.assigned.size === 0 ? (
              <p role="status" className="mb-3 rounded-md bg-warning/25 p-3 text-sm">
                {t("publishedNotAssigned")}
              </p>
            ) : null}
            {a.status === "draft" ? (
              <p className="mb-3 rounded-md bg-muted p-3 text-sm text-muted-foreground">
                {t("draftNotVisible")}
              </p>
            ) : null}
            {data.students.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noStudents")}</p>
            ) : (
              <ul className="space-y-2">
                {data.students.map((s) => (
                  <li key={s.student_id} className="flex items-center gap-2">
                    <Checkbox
                      id={`s-${s.student_id}`}
                      checked={data.assigned.has(s.student_id)}
                      onCheckedChange={(v) => toggleAssign(s.student_id, !!v)}
                    />
                    <label htmlFor={`s-${s.student_id}`} className="text-sm">
                      {s.full_name || "—"}
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {data.students.length > 0 ? (
              <p className="mt-3 text-xs text-muted-foreground">
                {t("assignedCount", {
                  assigned: String(data.assigned.size),
                  total: String(data.students.length),
                })}
              </p>
            ) : null}
            <p className="mt-4 text-xs text-muted-foreground">
              {t("dueAt")}: {formatDate(a.due_at, lang)}
            </p>
          </Panel>
        </aside>
      </div>
    </>
  );
}

/**
 * Question bank (Phase 2): reuse questions from the teacher's own
 * earlier assessments. The list query is scoped by RLS — the
 * "teacher manages questions" policy (owns_assessment) only ever
 * returns this teacher's questions, so no cross-teacher leakage is
 * possible even though the query has no explicit teacher filter.
 * Copying inserts a NEW question + key into this assessment (the
 * source is never linked or moved), so edits here never affect the
 * original assessment. Hidden while locked, like addQuestion.
 */
function QuestionBank({
  assessmentId,
  positionBase,
  onAdded,
}: {
  assessmentId: string;
  positionBase: number;
  onAdded: () => void;
}) {
  const { t, lang } = useI18n();
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const { data: bank = [] } = useQuery({
    queryKey: ["question-bank", assessmentId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("questions")
        .select(
          "id, prompt, type, marks, objective, difficulty, options, assessment_id, assessments(title)",
        )
        .neq("assessment_id", assessmentId)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data ?? [];
    },
  });

  const q = search.trim().toLowerCase();
  const visible = q ? bank.filter((b) => b.prompt.toLowerCase().includes(q)) : bank;

  async function copy(b: (typeof bank)[number]) {
    setBusyId(b.id);
    try {
      const { data: key } = await supabase
        .from("question_keys")
        .select("*")
        .eq("question_id", b.id)
        .maybeSingle();
      const { data: saved, error: qErr } = await supabase
        .from("questions")
        .insert({
          assessment_id: assessmentId,
          type: b.type,
          position: positionBase,
          prompt: b.prompt,
          marks: b.marks,
          objective: b.objective ?? "",
          options: (b.options as string[]) ?? [],
          difficulty: b.difficulty ?? "medium",
        })
        .select("id")
        .single();
      if (qErr || !saved) throw qErr ?? new Error("Copy failed.");
      const { error: kErr } = await supabase.from("question_keys").insert({
        question_id: saved.id,
        correct_answer: key?.correct_answer ?? "",
        accepted_alternatives: (key?.accepted_alternatives as string[]) ?? [],
        rubric: key?.rubric ?? "",
        explanation: key?.explanation ?? "",
      });
      if (kErr) throw kErr;
      toast.success(t("bankAdded"));
      onAdded();
    } catch (err) {
      toast.error(translateError(err, lang));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Panel className="space-y-3">
      <p className="text-sm font-medium">{t("bankTitle")}</p>
      <p className="text-xs text-muted-foreground">{t("bankHint")}</p>
      <Input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t("bankSearch")}
      />
      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("bankEmpty")}</p>
      ) : (
        <ul className="space-y-2">
          {visible.map((b) => (
            <li key={b.id} className="flex items-start justify-between gap-2 rounded-md border p-2">
              <div className="min-w-0">
                <p className="truncate text-sm">{b.prompt}</p>
                <p className="text-xs text-muted-foreground">
                  {t(`q_${b.type}` as never)} ·{" "}
                  {(b.assessments as { title?: string } | null)?.title ?? "—"}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={busyId !== null}
                onClick={() => void copy(b)}
              >
                {t("bankAdd")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

type A = Database["public"]["Tables"]["assessments"]["Row"];
function toLocalInput(d: string | null) {
  if (!d) return "";
  const dt = new Date(d);
  return new Date(dt.getTime() - dt.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function MetaEditor({
  a,
  subjects,
  onSaved,
}: {
  a: A;
  subjects: { id: string; name: string }[];
  onSaved: () => void;
}) {
  const { t, lang } = useI18n();
  const [f, setF] = useState({
    title: a.title,
    instructions: a.instructions,
    grade_level: a.grade_level,
    subject_id: a.subject_id ?? "",
    due_at: toLocalInput(a.due_at),
    starts_at: toLocalInput(a.starts_at),
    duration_minutes: a.duration_minutes != null ? String(a.duration_minutes) : "",
    max_attempts: String(a.max_attempts ?? 1),
  });
  const [newSubject, setNewSubject] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!f.title.trim()) return;
    setBusy(true);
    let subject_id = f.subject_id || null;
    if (newSubject.trim()) {
      const { data, error } = await supabase
        .from("subjects")
        .insert({ name: newSubject.trim() })
        .select("id")
        .single();
      if (error) {
        setBusy(false);
        return void toast.error(translateError(error, lang));
      }
      subject_id = data.id;
      setNewSubject("");
    }
    const { error } = await supabase
      .from("assessments")
      .update({
        title: f.title.trim(),
        instructions: f.instructions,
        grade_level: f.grade_level,
        subject_id,
        due_at: f.due_at ? new Date(f.due_at).toISOString() : null,
        starts_at: f.starts_at ? new Date(f.starts_at).toISOString() : null,
        duration_minutes: f.duration_minutes.trim()
          ? Math.max(1, parseInt(f.duration_minutes, 10) || 1)
          : null,
        max_attempts: Math.max(1, parseInt(f.max_attempts, 10) || 1),
        updated_at: new Date().toISOString(),
      })
      .eq("id", a.id);
    setBusy(false);
    if (error) return void toast.error(translateError(error, lang));
    toast.success(t("save"));
    onSaved();
  }
  return (
    <Panel className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1.5 md:col-span-2">
          <Label htmlFor="m-title">{t("title")}</Label>
          <Input
            id="m-title"
            value={f.title}
            maxLength={200}
            onChange={(e) => setF({ ...f, title: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="m-subj">{t("subject")}</Label>
          <select
            id="m-subj"
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            value={f.subject_id}
            onChange={(e) => setF({ ...f, subject_id: e.target.value })}
          >
            <option value="">—</option>
            {subjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <Input
            placeholder={t("newSubject")}
            value={newSubject}
            maxLength={80}
            onChange={(e) => setNewSubject(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="m-grade">{t("gradeLevel")}</Label>
          <Input
            id="m-grade"
            value={f.grade_level}
            maxLength={60}
            onChange={(e) => setF({ ...f, grade_level: e.target.value })}
          />
          <Label htmlFor="m-due" className="pt-2">
            {t("dueAt")}
          </Label>
          <Input
            id="m-due"
            type="datetime-local"
            dir="ltr"
            value={f.due_at}
            onChange={(e) => setF({ ...f, due_at: e.target.value })}
          />
          <Label htmlFor="m-starts" className="pt-2">
            {t("startsAt")}
          </Label>
          <Input
            id="m-starts"
            type="datetime-local"
            dir="ltr"
            value={f.starts_at}
            onChange={(e) => setF({ ...f, starts_at: e.target.value })}
          />
          <Label htmlFor="m-duration" className="pt-2">
            {t("durationMinutes")}
          </Label>
          <Input
            id="m-duration"
            type="number"
            min={1}
            placeholder={t("durationUnlimited")}
            value={f.duration_minutes}
            onChange={(e) => setF({ ...f, duration_minutes: e.target.value })}
          />
          <Label htmlFor="m-attempts" className="pt-2">
            {t("maxAttempts")}
          </Label>
          <Input
            id="m-attempts"
            type="number"
            min={1}
            value={f.max_attempts}
            onChange={(e) => setF({ ...f, max_attempts: e.target.value })}
          />
        </div>
        <div className="space-y-1.5 md:col-span-2">
          <Label htmlFor="m-ins">{t("instructions")}</Label>
          <Textarea
            id="m-ins"
            rows={3}
            value={f.instructions}
            maxLength={4000}
            onChange={(e) => setF({ ...f, instructions: e.target.value })}
          />
        </div>
      </div>
      <Button onClick={save} disabled={busy}>
        {busy ? t("saving") : t("save")}
      </Button>
      {/* Per-assessment WhatsApp auto-send (default OFF). The builder
          query selects assessments.* so the new column arrives without
          a query change, once the migration + types land. */}
      <WhatsAppAutoSendToggle assessmentId={a.id} initialValue={a.auto_whatsapp_send ?? false} />
    </Panel>
  );
}

type Q = Database["public"]["Tables"]["questions"]["Row"] & {
  question_keys: Database["public"]["Tables"]["question_keys"]["Row"] | null;
};

function QuestionEditor({
  q,
  index,
  count,
  locked,
  onMove,
  onChanged,
}: {
  q: Q;
  index: number;
  count: number;
  locked: boolean;
  onMove: (d: -1 | 1) => void;
  onChanged: () => void;
}) {
  const { t, lang } = useI18n();
  const key = q.question_keys;
  const [prompt, setPrompt] = useState(q.prompt);
  const [marks, setMarks] = useState(String(q.marks));
  const [objective, setObjective] = useState(q.objective);
  const [difficulty, setDifficulty] = useState(q.difficulty ?? "medium");
  const [options, setOptions] = useState<string[]>((q.options as string[]) ?? []);
  const [correct, setCorrect] = useState(key?.correct_answer ?? "");
  const [alts, setAlts] = useState(((key?.accepted_alternatives as string[]) ?? []).join("\n"));
  const [rubric, setRubric] = useState(key?.rubric ?? "");
  const [explanation, setExplanation] = useState(key?.explanation ?? "");
  const [dirty, setDirty] = useState(false);
  useEffect(
    () => setDirty(true),
    [prompt, marks, objective, options, correct, alts, rubric, explanation, difficulty],
  );
  useEffect(() => setDirty(false), []);

  async function save() {
    const m = Number(marks);
    if (!(m > 0))
      return void toast.error(
        lang === "ar" ? "الدرجة يجب أن تكون أكبر من صفر." : "Marks must be greater than zero.",
      );
    const cleanOpts = options.map((o) => o.trim());
    if (
      q.type === "mcq" &&
      (cleanOpts.filter(Boolean).length < 2 ||
        !cleanOpts.includes(correct.trim()) ||
        !correct.trim())
    )
      return void toast.error(
        lang === "ar"
          ? "أضف خيارين على الأقل وحدد الإجابة الصحيحة."
          : "Add at least two options and mark the correct one.",
      );
    const r1 = await supabase
      .from("questions")
      .update({
        prompt: prompt.trim(),
        marks: m,
        objective: objective.trim(),
        options: cleanOpts.filter(Boolean),
        difficulty,
      })
      .eq("id", q.id);
    if (r1.error) return void toast.error(translateError(r1.error, lang));
    const r2 = await supabase.from("question_keys").upsert({
      question_id: q.id,
      correct_answer: correct.trim(),
      accepted_alternatives: alts
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
      rubric: rubric.trim(),
      explanation: explanation.trim(),
    });
    if (r2.error) return void toast.error(translateError(r2.error, lang));
    setDirty(false);
    toast.success(t("save"));
    onChanged();
  }
  async function del() {
    const { error } = await supabase.from("questions").delete().eq("id", q.id);
    if (error) return void toast.error(translateError(error, lang));
    onChanged();
  }

  return (
    <Panel className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-primary">
          {t("question")} {index + 1} · {t(`q_${q.type}` as never)}
        </span>
        {!locked && (
          <span className="flex gap-1">
            <Button
              size="icon"
              variant="ghost"
              aria-label="up"
              disabled={index === 0}
              onClick={() => onMove(-1)}
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label="down"
              disabled={index === count - 1}
              onClick={() => onMove(1)}
            >
              <ArrowDown className="h-4 w-4" />
            </Button>
            <Button size="icon" variant="ghost" aria-label={t("delete")} onClick={del}>
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          </span>
        )}
      </div>
      <fieldset disabled={locked} className="space-y-4">
        <div className="space-y-1.5">
          <Label>{t("prompt")}</Label>
          <Textarea
            rows={2}
            value={prompt}
            maxLength={4000}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>
        {q.type === "mcq" && (
          <div className="space-y-2">
            <Label>
              {t("options")} — {t("correct")}
            </Label>
            {options.map((o, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="radio"
                  name={`c-${q.id}`}
                  aria-label={t("correct")}
                  checked={!!o.trim() && correct === o.trim()}
                  onChange={() => setCorrect(o.trim())}
                />
                <Input
                  value={o}
                  maxLength={500}
                  onChange={(e) => {
                    const n = [...options];
                    if (correct === o.trim()) setCorrect(e.target.value.trim());
                    n[i] = e.target.value;
                    setOptions(n);
                  }}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t("remove")}
                  onClick={() => setOptions(options.filter((_, j) => j !== i))}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button size="sm" variant="outline" onClick={() => setOptions([...options, ""])}>
              {t("addOption")}
            </Button>
          </div>
        )}
        {q.type === "true_false" && (
          <div className="flex gap-4">
            {["true", "false"].map((v) => (
              <label key={v} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`tf-${q.id}`}
                  checked={correct === v}
                  onChange={() => setCorrect(v)}
                />{" "}
                {v === "true" ? t("trueLabel") : t("falseLabel")}
              </label>
            ))}
          </div>
        )}
        {q.type === "short_answer" && (
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t("correct")}</Label>
              <Input value={correct} maxLength={500} onChange={(e) => setCorrect(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>{t("alternatives")}</Label>
              <Textarea rows={2} value={alts} onChange={(e) => setAlts(e.target.value)} />
            </div>
          </div>
        )}
        {q.type === "written" && (
          <div className="space-y-1.5">
            <Label>{t("rubric")}</Label>
            <Textarea
              rows={4}
              value={rubric}
              maxLength={4000}
              placeholder={t("rubricHint")}
              onChange={(e) => setRubric(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t("rubricHint")}</p>
          </div>
        )}
        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-1.5">
            <Label>{t("marks")}</Label>
            <Input
              type="number"
              min={0.5}
              step={0.5}
              dir="ltr"
              value={marks}
              onChange={(e) => setMarks(e.target.value)}
            />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label>{t("objective")}</Label>
            <Input
              value={objective}
              maxLength={300}
              onChange={(e) => setObjective(e.target.value)}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>{t("difficulty")}</Label>
          <select
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value)}
          >
            <option value="easy">{t("genDiffEasy")}</option>
            <option value="medium">{t("genDiffMedium")}</option>
            <option value="hard">{t("genDiffHard")}</option>
          </select>
        </div>
        {q.type !== "written" && (
          <div className="space-y-1.5">
            <Label>{t("explanation")}</Label>
            <Input
              value={explanation}
              maxLength={1000}
              onChange={(e) => setExplanation(e.target.value)}
            />
          </div>
        )}
        {!locked && (
          <Button onClick={save} variant={dirty ? "default" : "secondary"}>
            {t("save")}
          </Button>
        )}
      </fieldset>
    </Panel>
  );
}

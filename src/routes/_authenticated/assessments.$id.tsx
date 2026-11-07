import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ArrowUp, ArrowDown, Trash2, Plus } from "lucide-react";
import {
  addQuestionD1,
  copyBankQuestionD1,
  deleteQuestionD1,
  getBuilderDataD1,
  listQuestionBankD1,
  moveQuestionD1,
  setAssessmentStatusD1,
  setAudienceEveryoneD1,
  toggleAssignmentD1,
  updateAssessmentMetaD1,
  updateQuestionD1,
  type AssessmentStatus,
  type BuilderAssessment,
  type BuilderQuestion,
  type QuestionType,
} from "@/server/d1-assessments";
import { useI18n, translateError, formatDate } from "@/lib/i18n";
import { PageHeader, Panel, Pill, statusTone } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { WhatsAppAutoSendToggle } from "@/components/whatsapp-auto-send-toggle";
import { missingAssignments, modeFromCoverage, planPublishAudience } from "@/lib/audience";

type QType = QuestionType;
type Status = AssessmentStatus;

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
      // D1 (Phase 2): ownership is enforced server-side (teacher_id =
      // session user); a non-owner gets NOT_FOUND, never another
      // teacher's assessment, questions, or keys.
      const data = await getBuilderDataD1({ data: { assessmentId: id } });
      return {
        a: data.assessment,
        // QuestionEditor reads q.question_keys; the D1 shape calls it key.
        questions: data.questions.map((q) => ({ ...q, question_keys: q.key })),
        subjects: data.subjects,
        students: data.students,
        assigned: new Set(data.assignedIds),
        submissionCount: data.submissionCount,
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
  // Bound once, after the guard: hoisted function declarations below do not
  // see the narrowing of `data`, but these consts carry it.
  const linkedStudentIds = data.students.map((st) => st.student_id);
  const assignedIds = data.assigned;
  const unassigned = missingAssignments(linkedStudentIds, assignedIds);

  /**
   * Publish is the one transition that decides who can see the exam, so it
   * is the one that must not be able to produce a "published but invisible"
   * row. Order matters:
   *   1. block when the teacher has no linked students (nobody to publish to);
   *   2. run the server transition (it validates questions and, on current
   *      schemas, auto-assigns everyone when no cohort was picked);
   *   3. close the gap for older schemas / students linked since: assign the
   *      missing linked students when the audience is "everyone", and record
   *      audience_mode so late joiners keep arriving.
   * A subset selection is never widened.
   */
  async function setStatus(s: Status) {
    // The audience is derived from the rows that exist, never from
    // a.audience_mode (its DB default is 'explicit', which used to be
    // mistaken for a deliberate choice).
    const plan = planPublishAudience({ linkedIds: linkedStudentIds, assignedIds });
    if (s === "published") {
      if (plan.blocked === "no_students") {
        toast.error(t("publishNoStudents"));
        return;
      }
      if (plan.mode === "explicit") {
        // A strict subset: allowed, but say out loud who will NOT see it.
        toast.warning(
          t("publishPartial", {
            assigned: String(assignedIds.size),
            total: String(linkedStudentIds.length),
          }),
        );
      }
    }
    // D1 (Phase 2): the server re-derives the audience from approved
    // links + current assignments, enforces the transition table and
    // the publish completeness checks, and returns the true reach
    // counted from assignment rows — no re-read, no duplicate-key
    // toast. KNOWN V1 GROUP EDGE: publish widening ignores group_exams
    // links (see d1-assessments.ts header); the take gate blocks
    // non-members separately.
    let result: { reach: number; mode: string | null };
    try {
      result = await setAssessmentStatusD1({ data: { assessmentId: id, status: s } });
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (message.includes("PUBLISH_NO_STUDENTS")) return void toast.error(t("publishNoStudents"));
      return void toast.error(translateError(err, lang));
    }
    if (s === "published" && plan.blocked === null) {
      if (result.reach === 0) {
        toast.error(t("publishReachZero"));
      } else {
        toast.success(t("publishReach", { count: String(result.reach) }));
      }
    }
    refresh();
  }

  /** Switch an already-published assessment to "everyone" and top it up. */
  async function makeAudienceEveryone() {
    try {
      const result = await setAudienceEveryoneD1({ data: { assessmentId: id } });
      toast.success(t("audienceEveryoneNow", { count: String(result.count) }));
    } catch (err) {
      toast.error(translateError(err, lang));
    }
    refresh();
  }

  async function addQuestion(type: QType) {
    // The server creates the question AND its key (correct_answer
    // "true" for true_false, "" otherwise) in one owner-checked call.
    try {
      await addQuestionD1({ data: { assessmentId: id, type } });
    } catch (err) {
      return void toast.error(translateError(err, lang));
    }
    refresh();
  }
  async function move(idx: number, dir: -1 | 1) {
    const other = questions[idx + dir];
    if (!other) return;
    const cur = questions[idx]!;
    try {
      await moveQuestionD1({ data: { questionId: cur.id, dir } });
    } catch (err) {
      return void toast.error(translateError(err, lang));
    }
    refresh();
  }
  async function toggleAssign(studentId: string, on: boolean) {
    try {
      await toggleAssignmentD1({ data: { assessmentId: id, studentId, on } });
    } catch (err) {
      return void toast.error(translateError(err, lang));
    }
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
            {a.status !== "draft" && unassigned.length > 0 ? (
              <div className="mt-3 space-y-2 rounded-md bg-info/15 p-3">
                {a.audience_mode === "auto_all" ? (
                  <>
                    <p className="text-xs">{t("audienceHasNewStudents")}</p>
                    <Button size="sm" variant="outline" onClick={makeAudienceEveryone}>
                      {t("audienceSyncNow")}
                    </Button>
                  </>
                ) : (
                  <>
                    {/* 'explicit' means a real subset — never widen it
                        silently. Offer the switch instead, because a
                        subset that just happens to cover everyone who was
                        linked at publish time is indistinguishable from
                        "everyone" once somebody new joins. */}
                    <p className="text-xs">{t("audienceExplicitNote")}</p>
                    <Button size="sm" variant="outline" onClick={makeAudienceEveryone}>
                      {t("audienceMakeEveryone")}
                    </Button>
                  </>
                )}
              </div>
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
 * Question bank (D1, Phase 2): reuse questions from the teacher's own
 * earlier assessments. The server scopes the list by
 * assessments.teacher_id = session user (the old RLS
 * "teacher manages questions" rule, now a code check), so no
 * cross-teacher leakage is possible. Copying inserts a NEW question
 * + key into this assessment (the source is never linked or moved),
 * so edits here never affect the original assessment. Hidden while
 * locked, like addQuestion.
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
    queryFn: async () => listQuestionBankD1({ data: { assessmentId } }),
  });

  const q = search.trim().toLowerCase();
  const visible = q ? bank.filter((b) => b.prompt.toLowerCase().includes(q)) : bank;

  async function copy(b: (typeof bank)[number]) {
    setBusyId(b.id);
    try {
      await copyBankQuestionD1({
        data: {
          assessmentId,
          sourceQuestionId: b.id,
          position: positionBase,
        },
      });
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
                  {t(`q_${b.type}` as never)} · {b.assessmentTitle ?? "—"}
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

type A = BuilderAssessment;
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
    try {
      // The server creates a new teacher-owned subject when
      // newSubject is set, then updates the assessment — one
      // owner-checked call, no client-side subject insert.
      await updateAssessmentMetaD1({
        data: {
          assessmentId: a.id,
          title: f.title.trim(),
          instructions: f.instructions,
          gradeLevel: f.grade_level,
          subjectId: f.subject_id || null,
          newSubjectName: newSubject.trim() || null,
          dueAt: f.due_at ? new Date(f.due_at).toISOString() : null,
          startsAt: f.starts_at ? new Date(f.starts_at).toISOString() : null,
          durationMinutes: f.duration_minutes.trim()
            ? Math.max(1, parseInt(f.duration_minutes, 10) || 1)
            : null,
          maxAttempts: Math.max(1, parseInt(f.max_attempts, 10) || 1),
        },
      });
      setNewSubject("");
    } catch (err) {
      setBusy(false);
      return void toast.error(translateError(err, lang));
    }
    setBusy(false);
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
      <WhatsAppAutoSendToggle assessmentId={a.id} initialValue={a.auto_whatsapp_send === 1} />
    </Panel>
  );
}

type Q = BuilderQuestion & { question_keys: BuilderQuestion["key"] };

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
  const [options, setOptions] = useState<string[]>(q.options ?? []);
  const [correct, setCorrect] = useState(key?.correct_answer ?? "");
  const [alts, setAlts] = useState((key?.accepted_alternatives ?? []).join("\n"));
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
    try {
      // One owner-checked server call updates the question AND its
      // key; the server re-validates marks and the mcq rule.
      await updateQuestionD1({
        data: {
          questionId: q.id,
          prompt: prompt.trim(),
          marks: m,
          objective: objective.trim(),
          options: cleanOpts.filter(Boolean),
          difficulty,
          correctAnswer: correct.trim(),
          acceptedAlternatives: alts
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean),
          rubric: rubric.trim(),
          explanation: explanation.trim(),
          type: q.type,
        },
      });
    } catch (err) {
      return void toast.error(translateError(err, lang));
    }
    setDirty(false);
    toast.success(t("save"));
    onChanged();
  }
  async function del() {
    try {
      await deleteQuestionD1({ data: { questionId: q.id } });
    } catch (err) {
      return void toast.error(translateError(err, lang));
    }
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

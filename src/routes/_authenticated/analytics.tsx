import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { useI18n, translateError } from "@/lib/i18n";
import { useMe } from "@/lib/session";
import { PageHeader, Panel, Pill, Empty } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  computeAssessmentStats,
  computeGroupStats,
  computeObjectiveStats,
  computeQuestionStats,
  computeStudentStats,
  formatPct,
  mostMissed,
  reteachTopics,
  toCsv,
  type SubmissionInput,
} from "@/lib/analytics";

// Phase 4 — analytics page. Read-only over existing tables, plus ONE
// write: the suggested-practice draft (a new unpublished assessment
// built by copying the most-missed questions + keys, same pattern as
// the builder's question-bank copy). No migration, no schema change.
//
// DEFINITIONS (shared with src/lib/analytics.ts and the report page):
// released = status "released" + final_score + total_possible > 0;
// per-question effective score = final_score ?? auto_score, graded
// answers only. A student in two groups counts in both.

type Q = Database["public"]["Tables"]["questions"]["Row"];

export const Route = createFileRoute("/_authenticated/analytics")({
  head: () => ({
    meta: [
      { title: "Analytics · Qemmini" },
      {
        name: "description",
        content: "Strengths, weaknesses, most-missed questions and comparisons.",
      },
    ],
  }),
  component: Analytics,
});

function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function Analytics() {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const { data: me, isLoading: meLoading } = useMe();

  const role = me?.role as string | undefined;
  const isTeacher = role === "school_teacher" || role === "tutor" || role === "teacher";

  const [selectedId, setSelectedId] = useState("");
  const [practiceBusy, setPracticeBusy] = useState(false);

  const assessmentsQuery = useQuery({
    queryKey: ["an-assessments", me?.id],
    enabled: !!me?.id && isTeacher,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("assessments")
        .select("id, title, subject_id, grade_level, status, created_at")
        .eq("teacher_id", me!.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const subjectsQuery = useQuery({
    queryKey: ["an-subjects"],
    enabled: isTeacher,
    queryFn: async () =>
      (await supabase.from("subjects").select("id, name").order("name")).data ?? [],
  });

  const assessments = useMemo(() => assessmentsQuery.data ?? [], [assessmentsQuery.data]);
  const subjects = subjectsQuery.data ?? [];
  const subjectNames = Object.fromEntries(subjects.map((s) => [s.id, s.name]));

  useEffect(() => {
    if (!selectedId && assessments.length > 0) {
      setSelectedId(assessments[0]!.id);
    }
  }, [selectedId, assessments]);

  const selected = assessments.find((a) => a.id === selectedId) ?? null;

  const detailQuery = useQuery({
    queryKey: ["an-detail", selectedId],
    enabled: !!selectedId,
    queryFn: async () => {
      const { data: questions, error: qErr } = await supabase
        .from("questions")
        .select("id, position, type, prompt, marks, objective, difficulty, options")
        .eq("assessment_id", selectedId)
        .order("position");
      if (qErr) throw qErr;
      const { data: submissions, error: sErr } = await supabase
        .from("submissions")
        .select("id, student_id, status, final_score, total_possible")
        .eq("assessment_id", selectedId);
      if (sErr) throw sErr;
      const submissionIds = (submissions ?? []).map((s) => s.id);
      let answers: {
        question_id: string;
        auto_score: number | null;
        final_score: number | null;
      }[] = [];
      if (submissionIds.length > 0) {
        const { data: aData, error: aErr } = await supabase
          .from("answers")
          .select("question_id, auto_score, final_score")
          .in("submission_id", submissionIds);
        if (aErr) throw aErr;
        answers = aData ?? [];
      }
      const studentIds = [...new Set((submissions ?? []).map((s) => s.student_id))];
      let names: Record<string, string> = {};
      if (studentIds.length > 0) {
        const { data: profiles } = await supabase
          .from("profiles")
          .select("id, full_name")
          .in("id", studentIds);
        names = Object.fromEntries((profiles ?? []).map((p) => [p.id, p.full_name || "—"]));
      }
      return {
        questions: (questions ?? []) as Q[],
        submissions: (submissions ?? []) as SubmissionInput[],
        answers,
        names,
      };
    },
  });

  const groupsQuery = useQuery({
    queryKey: ["an-groups", me?.id, role],
    enabled: !!me?.id && isTeacher,
    queryFn: async () => {
      // Classes first (school teachers); lessons as the tutor equivalent.
      const { data: classes } = await supabase
        .from("classes")
        .select("id, name")
        .eq("teacher_id", me!.id);
      if ((classes ?? []).length > 0) {
        const ids = classes!.map((c) => c.id);
        const { data: members } = await supabase
          .from("class_members")
          .select("class_id, student_id")
          .in("class_id", ids);
        const byClass = new Map<string, string[]>();
        for (const m of members ?? []) {
          const list = byClass.get(m.class_id) ?? [];
          list.push(m.student_id);
          byClass.set(m.class_id, list);
        }
        return classes!.map((c) => ({
          id: c.id,
          name: c.name,
          studentIds: byClass.get(c.id) ?? [],
        }));
      }
      const { data: lessons } = await supabase
        .from("lessons")
        .select("id, title")
        .eq("tutor_id", me!.id);
      if ((lessons ?? []).length === 0) return [];
      const ids = lessons!.map((l) => l.id);
      const { data: enrollments } = await supabase
        .from("lesson_enrollments")
        .select("lesson_id, student_id")
        .in("lesson_id", ids);
      const byLesson = new Map<string, string[]>();
      for (const m of enrollments ?? []) {
        const list = byLesson.get(m.lesson_id) ?? [];
        list.push(m.student_id);
        byLesson.set(m.lesson_id, list);
      }
      return lessons!.map((l) => ({
        id: l.id,
        name: l.title,
        studentIds: byLesson.get(l.id) ?? [],
      }));
    },
  });

  const overviewQuery = useQuery({
    queryKey: ["an-overview", me?.id, assessments.map((a) => a.id).join(",")],
    enabled: assessments.length > 0,
    queryFn: async () => {
      const ids = assessments.map((a) => a.id);
      const { data, error } = await supabase
        .from("submissions")
        .select("assessment_id, student_id, status, final_score, total_possible")
        .in("assessment_id", ids);
      if (error) throw error;
      const byAssessment: Record<string, SubmissionInput[]> = {};
      for (const row of data ?? []) {
        const list = byAssessment[row.assessment_id] ?? [];
        list.push({
          id: "",
          student_id: row.student_id,
          status: row.status,
          final_score: row.final_score,
          total_possible: row.total_possible,
        });
        byAssessment[row.assessment_id] = list;
      }
      return byAssessment;
    },
  });

  if (meLoading) return <p className="text-muted-foreground">{t("loading")}</p>;
  if (!me || !isTeacher) return <Empty>{t("anTeacherOnly")}</Empty>;

  const detail = detailQuery.data;
  const questionStats = detail
    ? computeQuestionStats(
        detail.questions.map((q) => ({
          id: q.id,
          prompt: q.prompt,
          type: q.type,
          marks: Number(q.marks),
          objective: q.objective ?? "",
          difficulty: q.difficulty ?? "medium",
        })),
        detail.answers,
      )
    : [];
  const objectiveStats = computeObjectiveStats(questionStats);
  const strengths = [...objectiveStats]
    .filter((o) => o.avgPct !== null)
    .sort((a, b) => (b.avgPct ?? 0) - (a.avgPct ?? 0))
    .slice(0, 3);
  const weaknesses = [...objectiveStats]
    .filter((o) => o.avgPct !== null)
    .sort((a, b) => (a.avgPct ?? 0) - (b.avgPct ?? 0))
    .slice(0, 3);
  const reteach = reteachTopics(objectiveStats);
  const missed = mostMissed(questionStats, 5);
  const studentStats = detail ? computeStudentStats(detail.submissions, detail.names) : [];
  const groupStats = detail ? computeGroupStats(groupsQuery.data ?? [], detail.submissions) : [];
  const assessmentStats = computeAssessmentStats(
    assessments.map((a) => ({ id: a.id, title: a.title, subject_id: a.subject_id })),
    overviewQuery.data ?? {},
    subjectNames,
  );
  const subjectStats = (() => {
    const bySubject = new Map<string, { released: number; avgs: number[]; count: number }>();
    for (const st of assessmentStats) {
      const entry = bySubject.get(st.subjectName) ?? { released: 0, avgs: [], count: 0 };
      entry.released += st.released;
      if (st.avgPct !== null) entry.avgs.push(st.avgPct);
      entry.count += 1;
      bySubject.set(st.subjectName, entry);
    }
    return [...bySubject.entries()].map(([name, e]) => ({
      name,
      count: e.count,
      released: e.released,
      avgPct: e.avgs.length > 0 ? e.avgs.reduce((s, v) => s + v, 0) / e.avgs.length : null,
    }));
  })();
  const questionsSorted = [...questionStats].sort((a, b) => {
    if (a.avgPct === null && b.avgPct === null) return 0;
    if (a.avgPct === null) return 1;
    if (b.avgPct === null) return -1;
    return a.avgPct - b.avgPct;
  });
  const releasedCount = detail
    ? detail.submissions.filter(
        (s) => s.status === "released" && s.final_score !== null && Number(s.total_possible) > 0,
      ).length
    : 0;

  const diffLabel = (d: string) =>
    d === "easy" ? t("genDiffEasy") : d === "hard" ? t("genDiffHard") : t("genDiffMedium");
  const num = (v: number | null) => (v === null ? "" : Math.round(v * 10) / 10);

  async function createPractice() {
    if (!selected || missed.length === 0) {
      toast.error(t("anNoPractice"));
      return;
    }
    if (!detail) return;
    setPracticeBusy(true);
    try {
      const { data: draft, error: dErr } = await supabase
        .from("assessments")
        .insert({
          title: `${t("anPracticeTitle")}: ${selected.title}`,
          teacher_id: me.id,
          subject_id: selected.subject_id,
          grade_level: selected.grade_level ?? "",
          instructions: "",
          status: "draft",
        })
        .select("id")
        .single();
      if (dErr || !draft) throw dErr ?? new Error("Draft failed.");
      for (let i = 0; i < missed.length; i++) {
        const m = missed[i]!;
        const src = detail.questions.find((q) => q.id === m.questionId);
        if (!src) continue;
        const { data: key } = await supabase
          .from("question_keys")
          .select("*")
          .eq("question_id", src.id)
          .maybeSingle();
        const { data: saved, error: qErr } = await supabase
          .from("questions")
          .insert({
            assessment_id: draft.id,
            type: src.type,
            position: i,
            prompt: src.prompt,
            marks: src.marks,
            objective: src.objective,
            options: (src.options as string[]) ?? [],
            difficulty: src.difficulty ?? "medium",
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
      }
      toast.success(t("anPracticeCreated"));
      navigate({ to: "/assessments/$id", params: { id: draft.id } });
    } catch (err) {
      toast.error(translateError(err, lang));
    } finally {
      setPracticeBusy(false);
    }
  }

  return (
    <>
      <PageHeader title={t("anTitle")} subtitle={t("anSubtitle")} />
      <div className="space-y-6">
        <Panel>
          <p className="rounded-md bg-warning/20 p-3 text-sm">{t("anDefinitions")}</p>
        </Panel>

        {assessments.length === 0 ? (
          <Empty>{t("anNoData")}</Empty>
        ) : (
          <>
            <Panel className="space-y-4">
              <h2 className="font-semibold">{t("anOverview")}</h2>
              <div className="space-y-2">
                <Label htmlFor="an-assessment">{t("anSelectAssessment")}</Label>
                <select
                  id="an-assessment"
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  value={selectedId}
                  onChange={(e) => setSelectedId(e.target.value)}
                >
                  {assessments.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.title}
                    </option>
                  ))}
                </select>
              </div>
              <h3 className="text-sm font-medium">{t("anBySubject")}</h3>
              {subjectStats.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("anNoReleased")}</p>
              ) : (
                <ul className="space-y-2">
                  {subjectStats.map((s) => (
                    <li key={s.name} className="flex items-center justify-between gap-2 text-sm">
                      <span>
                        {s.name} · {s.count} {t("anAssessment")}
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="text-muted-foreground">
                          {t("anReleased")}: {s.released}
                        </span>
                        <span className="font-medium">{formatPct(s.avgPct, lang)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="border-b text-start text-muted-foreground">
                      <th className="py-2 pe-3 text-start font-medium">{t("anAssessment")}</th>
                      <th className="py-2 pe-3 text-start font-medium">{t("anSubject")}</th>
                      <th className="py-2 pe-3 text-start font-medium">{t("anReleased")}</th>
                      <th className="py-2 text-start font-medium">{t("anAvgPct")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {assessmentStats.map((st) => (
                      <tr key={st.assessmentId} className="border-b last:border-0">
                        <td className="py-3 pe-3">{st.title}</td>
                        <td className="py-3 pe-3">{st.subjectName}</td>
                        <td className="py-3 pe-3">{st.released}</td>
                        <td className="py-3">{formatPct(st.avgPct, lang)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>

            {selected && (
              <>
                <Panel className="space-y-4">
                  <h2 className="font-semibold">{t("anQuestions")}</h2>
                  {detailQuery.isLoading ? (
                    <p className="text-sm text-muted-foreground">{t("loading")}</p>
                  ) : questionStats.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("anNoData")}</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[720px] text-sm">
                        <thead>
                          <tr className="border-b text-start text-muted-foreground">
                            <th className="py-2 pe-3 text-start font-medium">{t("anQuestion")}</th>
                            <th className="py-2 pe-3 text-start font-medium">{t("anObjective")}</th>
                            <th className="py-2 pe-3 text-start font-medium">{t("difficulty")}</th>
                            <th className="py-2 pe-3 text-start font-medium">{t("anAnswered")}</th>
                            <th className="py-2 pe-3 text-start font-medium">{t("anGraded")}</th>
                            <th className="py-2 pe-3 text-start font-medium">{t("anAvgPct")}</th>
                            <th className="py-2 text-start font-medium">{t("anFullCredit")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {questionsSorted.map((qs) => (
                            <tr key={qs.questionId} className="border-b last:border-0">
                              <td className="py-3 pe-3">
                                <span className="line-clamp-2">{qs.prompt || "—"}</span>
                                <span className="mt-1 block">
                                  <Pill>{t(`q_${qs.type}` as never)}</Pill>
                                </span>
                              </td>
                              <td className="py-3 pe-3">{qs.objective || t("anNoObjective")}</td>
                              <td className="py-3 pe-3">{diffLabel(qs.difficulty)}</td>
                              <td className="py-3 pe-3">{qs.answered}</td>
                              <td className="py-3 pe-3">{qs.graded}</td>
                              <td
                                className={`py-3 pe-3 ${qs.avgPct !== null && qs.avgPct < 50 ? "text-destructive" : ""}`}
                              >
                                {formatPct(qs.avgPct, lang)}
                              </td>
                              <td className="py-3">{formatPct(qs.fullCreditPct, lang)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Panel>

                <Panel className="space-y-4">
                  <h2 className="font-semibold">{t("anObjectives")}</h2>
                  {objectiveStats.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("anNoData")}</p>
                  ) : (
                    <>
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[560px] text-sm">
                          <thead>
                            <tr className="border-b text-start text-muted-foreground">
                              <th className="py-2 pe-3 text-start font-medium">
                                {t("anObjective")}
                              </th>
                              <th className="py-2 pe-3 text-start font-medium">
                                {t("anQuestions")}
                              </th>
                              <th className="py-2 pe-3 text-start font-medium">{t("anGraded")}</th>
                              <th className="py-2 text-start font-medium">{t("anAvgPct")}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {objectiveStats.map((o) => (
                              <tr key={o.objective} className="border-b last:border-0">
                                <td className="py-3 pe-3">{o.objective || t("anNoObjective")}</td>
                                <td className="py-3 pe-3">{o.questionCount}</td>
                                <td className="py-3 pe-3">{o.graded}</td>
                                <td className="py-3">{formatPct(o.avgPct, lang)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {strengths.length > 0 && (
                        <p className="text-sm">
                          {t("anStrengths")}:{" "}
                          {strengths
                            .map(
                              (o) =>
                                `${o.objective || t("anNoObjective")} (${formatPct(o.avgPct, lang)})`,
                            )
                            .join(" · ")}
                        </p>
                      )}
                      {weaknesses.length > 0 && (
                        <p className="text-sm">
                          {t("anWeaknesses")}:{" "}
                          {weaknesses
                            .map(
                              (o) =>
                                `${o.objective || t("anNoObjective")} (${formatPct(o.avgPct, lang)})`,
                            )
                            .join(" · ")}
                        </p>
                      )}
                    </>
                  )}
                </Panel>

                <Panel className="space-y-4">
                  <h2 className="font-semibold">{t("anStudents")}</h2>
                  {studentStats.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("anNoReleased")}</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[480px] text-sm">
                        <thead>
                          <tr className="border-b text-start text-muted-foreground">
                            <th className="py-2 pe-3 text-start font-medium">{t("anStudent")}</th>
                            <th className="py-2 pe-3 text-start font-medium">{t("anReleased")}</th>
                            <th className="py-2 text-start font-medium">{t("anAvgPct")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {studentStats.map((st) => (
                            <tr key={st.studentId} className="border-b last:border-0">
                              <td className="py-3 pe-3">{st.name}</td>
                              <td className="py-3 pe-3">{st.released}</td>
                              <td className="py-3">{formatPct(st.avgPct, lang)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Panel>

                <Panel className="space-y-4">
                  <h2 className="font-semibold">{t("anGroups")}</h2>
                  {groupStats.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("anNoGroups")}</p>
                  ) : releasedCount === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("anNoReleased")}</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[480px] text-sm">
                        <thead>
                          <tr className="border-b text-start text-muted-foreground">
                            <th className="py-2 pe-3 text-start font-medium">{t("anGroup")}</th>
                            <th className="py-2 pe-3 text-start font-medium">{t("anStudent")}</th>
                            <th className="py-2 text-start font-medium">{t("anAvgPct")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {groupStats.map((g) => (
                            <tr key={g.groupId} className="border-b last:border-0">
                              <td className="py-3 pe-3">{g.name}</td>
                              <td className="py-3 pe-3">{g.students}</td>
                              <td className="py-3">{formatPct(g.avgPct, lang)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Panel>

                <Panel className="space-y-4">
                  <h2 className="font-semibold">{t("anReteach")}</h2>
                  {reteach.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("anNoReteach")}</p>
                  ) : (
                    <ul className="space-y-1 text-sm">
                      {reteach.map((o) => (
                        <li key={o.objective}>
                          {o.objective || t("anNoObjective")} — {formatPct(o.avgPct, lang)}
                        </li>
                      ))}
                    </ul>
                  )}
                  <h3 className="text-sm font-medium">{t("anPractice")}</h3>
                  <p className="text-xs text-muted-foreground">{t("anPracticeNote")}</p>
                  <p className="text-sm text-muted-foreground">
                    {t("anMostMissed")}:{" "}
                    {missed.length === 0
                      ? "—"
                      : missed
                          .map(
                            (m) =>
                              `${(m.prompt || "").slice(0, 40)} (${formatPct(m.avgPct, lang)})`,
                          )
                          .join(" · ")}
                  </p>
                  <Button onClick={createPractice} disabled={practiceBusy || missed.length === 0}>
                    {practiceBusy ? t("anPracticeCreating") : t("anPracticeCreate")}
                  </Button>
                </Panel>

                <Panel className="space-y-4">
                  <h2 className="font-semibold">{t("anExport")}</h2>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      onClick={() =>
                        downloadCsv(
                          "qemmini-questions.csv",
                          toCsv(
                            questionStats.map((qs) => [
                              qs.prompt,
                              qs.type,
                              qs.difficulty,
                              qs.objective,
                              qs.answered,
                              qs.graded,
                              num(qs.avgPct),
                              num(qs.fullCreditPct),
                            ]),
                            [
                              t("anQuestion"),
                              t("anQuestionType"),
                              t("difficulty"),
                              t("anObjective"),
                              t("anAnswered"),
                              t("anGraded"),
                              t("anAvgPct"),
                              t("anFullCredit"),
                            ],
                          ),
                        )
                      }
                    >
                      {t("anExportQuestions")}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() =>
                        downloadCsv(
                          "qemmini-students.csv",
                          toCsv(
                            studentStats.map((st) => [st.name, st.released, num(st.avgPct)]),
                            [t("anStudent"), t("anReleased"), t("anAvgPct")],
                          ),
                        )
                      }
                    >
                      {t("anExportStudents")}
                    </Button>
                    <Button variant="outline" onClick={() => window.print()}>
                      {t("anPrint")}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t("anExportNote")}</p>
                </Panel>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}

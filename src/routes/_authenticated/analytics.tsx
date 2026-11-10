import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  createPracticeDraftD1,
  getAnalyticsDetailD1,
  getAnalyticsOverviewD1,
  listAnalyticsAssessmentsD1,
  listAnalyticsStudentPageD1,
} from "@/server/d1-analytics";
import { listSubjectsD1 } from "@/server/d1-generation";
import { useI18n, translateError } from "@/lib/i18n";
import { useMe } from "@/lib/session";
import { PageHeader, Panel, Pill, Empty } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { DataPager } from "@/components/data-pager";
import { Label } from "@/components/ui/label";
import {
  computeObjectiveStats,
  formatPct,
  mostMissed,
  reteachTopics,
  toCsv,
  type AssessmentStat,
  type GroupStat,
  type QuestionStat,
  type StudentStat,
} from "@/lib/analytics";

// Phase 4 — analytics page. Read-only over existing tables, plus ONE
// write: the suggested-practice draft (a new unpublished assessment
// built by copying the most-missed questions; the client sends question
// ids only and the server re-reads the questions and their keys from
// its own rows, so no answer key ever reaches the browser).
// No migration, no schema change.
//
// DEFINITIONS (shared with src/lib/analytics.ts and the report page):
// released = status "released" + final_score + total_possible > 0;
// per-question effective score = final_score ?? auto_score, graded
// answers only. A student in two groups counts in both.

// D1 question shape (options parsed to string[] server-side).
type Q = {
  id: string;
  position: number;
  type: string;
  prompt: string;
  marks: number;
  objective: string;
  difficulty: string;
  options: string[];
};

export const Route = createFileRoute("/_authenticated/analytics")({
  head: () => ({
    meta: [
      { title: "Analytics · Qayyimni" },
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
  const [assessmentPage, setAssessmentPage] = useState(0);
  const [studentPage, setStudentPage] = useState(0);
  const [groupPage, setGroupPage] = useState(0);
  const [practiceBusy, setPracticeBusy] = useState(false);
  const [studentExportBusy, setStudentExportBusy] = useState(false);

  const assessmentsQuery = useQuery({
    queryKey: ["an-assessments", me?.id, assessmentPage],
    enabled: !!me?.id && isTeacher,
    // D1: the caller's own assessments only.
    queryFn: async () => listAnalyticsAssessmentsD1({ data: { page: assessmentPage } }),
  });

  const subjectsQuery = useQuery({
    queryKey: ["an-subjects"],
    enabled: isTeacher,
    queryFn: async () => listSubjectsD1({ data: {} }),
  });

  const assessments = useMemo(
    () => assessmentsQuery.data?.assessments ?? [],
    [assessmentsQuery.data?.assessments],
  );
  const subjects = subjectsQuery.data ?? [];
  const subjectNames = Object.fromEntries(subjects.map((s) => [s.id, s.name]));

  useEffect(() => {
    if (assessments.length > 0 && !assessments.some((assessment) => assessment.id === selectedId)) {
      setSelectedId(assessments[0]!.id);
      setStudentPage(0);
    }
  }, [selectedId, assessments]);

  const selected = assessments.find((a) => a.id === selectedId) ?? null;

  const detailQuery = useQuery({
    queryKey: ["an-detail", selectedId, studentPage, groupPage],
    enabled: !!selectedId,
    // D1: released-only stats for the caller's own assessment.
    // question_keys are never selected by the stats queries.
    queryFn: async () => {
      const detail = await getAnalyticsDetailD1({
        data: { assessmentId: selectedId, studentPage, groupPage },
      });
      const questionStats: QuestionStat[] = detail.questions.map((q) => {
        const stats = detail.questionStats.find((s) => s.questionId === q.id);
        return {
          questionId: q.id,
          prompt: q.prompt,
          type: q.type,
          objective: q.objective ?? "",
          difficulty: q.difficulty ?? "medium",
          marks: Number(q.marks),
          answered: stats?.answered ?? 0,
          graded: stats?.graded ?? 0,
          avgPct: stats?.avgPct ?? null,
          fullCreditPct: stats?.fullCreditPct ?? null,
        };
      });
      return {
        questions: detail.questions as Q[],
        questionStats,
        students: detail.students as StudentStat[],
        hasMoreStudents: detail.hasMoreStudents,
        groups: detail.groups as GroupStat[],
        hasMoreGroups: detail.hasMoreGroups,
      };
    },
  });

  const overviewQuery = useQuery({
    queryKey: ["an-overview", me?.id, assessments.map((a) => a.id).join(",")],
    enabled: assessments.length > 0,
    queryFn: async () =>
      getAnalyticsOverviewD1({ data: { assessmentIds: assessments.map((a) => a.id) } }),
  });

  if (meLoading) return <p className="text-muted-foreground">{t("loading")}</p>;
  if (!me || !isTeacher) return <Empty>{t("anTeacherOnly")}</Empty>;

  const detail = detailQuery.data;
  const questionStats = detail?.questionStats ?? [];
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
  const studentStats = detail?.students ?? [];
  const groupStats = detail?.groups ?? [];
  const summaryByAssessment = new Map(
    (overviewQuery.data ?? []).map((row) => [row.assessment_id, row]),
  );
  const assessmentStats: AssessmentStat[] = assessments.map((assessment) => {
    const summary = summaryByAssessment.get(assessment.id);
    return {
      assessmentId: assessment.id,
      title: assessment.title,
      subjectName: assessment.subject_id ? (subjectNames[assessment.subject_id] ?? "—") : "—",
      released: summary?.released ?? 0,
      avgPct: summary?.avg_pct ?? null,
    };
  });
  const releasedCount = selectedId ? (summaryByAssessment.get(selectedId)?.released ?? 0) : 0;
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
  const diffLabel = (d: string) =>
    d === "easy" ? t("genDiffEasy") : d === "hard" ? t("genDiffHard") : t("genDiffMedium");
  const num = (v: number | null) => (v === null ? "" : Math.round(v * 10) / 10);

  async function createPractice() {
    if (!me) return;
    if (!selected || missed.length === 0) {
      toast.error(t("anNoPractice"));
      return;
    }
    if (!detail) return;
    setPracticeBusy(true);
    try {
      // D1: the client sends question ids only. The server re-reads
      // the questions and their keys from the caller's own rows and
      // creates the copy as a draft, never published — no key material
      // ever reaches the browser.
      const draft = await createPracticeDraftD1({
        data: {
          assessmentId: selected.id,
          questionIds: missed.map((m) => m.questionId),
          title: `${t("anPracticeTitle")}: ${selected.title}`,
        },
      });
      toast.success(t("anPracticeCreated"));
      navigate({ to: "/assessments/$id", params: { id: draft.id } });
    } catch (err) {
      toast.error(translateError(err, lang));
    } finally {
      setPracticeBusy(false);
    }
  }

  async function exportStudents() {
    if (!selected) return;
    setStudentExportBusy(true);
    try {
      const rows: StudentStat[] = [];
      let offset = 0;
      while (true) {
        // D1: released-only page for the caller's own assessment.
        const pageRows = await listAnalyticsStudentPageD1({
          data: { assessmentId: selected.id, offset },
        });
        rows.push(...(pageRows.slice(0, 50) as StudentStat[]));
        if (pageRows.length <= 50) break;
        offset += 50;
      }
      downloadCsv(
        "qemmini-students.csv",
        toCsv(
          rows.map((row) => [row.name, row.released, num(row.avgPct)]),
          [t("anStudent"), t("anReleased"), t("anAvgPct")],
        ),
      );
    } catch (error) {
      toast.error(translateError(error, lang));
    } finally {
      setStudentExportBusy(false);
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
                  onChange={(e) => {
                    setSelectedId(e.target.value);
                    setStudentPage(0);
                    setGroupPage(0);
                  }}
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
              {assessmentsQuery.data && (assessmentPage > 0 || assessmentsQuery.data.hasNext) ? (
                <DataPager
                  page={assessmentPage}
                  hasPrevious={assessmentPage > 0}
                  hasNext={assessmentsQuery.data.hasNext}
                  onPrevious={() => {
                    setSelectedId("");
                    setAssessmentPage((current) => Math.max(0, current - 1));
                  }}
                  onNext={() => {
                    setSelectedId("");
                    setAssessmentPage((current) => current + 1);
                  }}
                />
              ) : null}
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
                  {detail && (studentPage > 0 || detail.hasMoreStudents) ? (
                    <DataPager
                      page={studentPage}
                      hasPrevious={studentPage > 0}
                      hasNext={detail.hasMoreStudents}
                      onPrevious={() => setStudentPage((current) => Math.max(0, current - 1))}
                      onNext={() => setStudentPage((current) => current + 1)}
                    />
                  ) : null}
                </Panel>

                <Panel className="space-y-4">
                  <h2 className="font-semibold">{t("anGroups")}</h2>
                  {groupStats.length === 0 && groupPage === 0 ? (
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
                  {detail && (groupPage > 0 || detail.hasMoreGroups) ? (
                    <DataPager
                      page={groupPage}
                      hasPrevious={groupPage > 0}
                      hasNext={detail.hasMoreGroups}
                      onPrevious={() => setGroupPage((current) => Math.max(0, current - 1))}
                      onNext={() => setGroupPage((current) => current + 1)}
                    />
                  ) : null}
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
                      disabled={studentExportBusy}
                      onClick={() => void exportStudents()}
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

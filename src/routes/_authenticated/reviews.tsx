import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useI18n, translateError } from "@/lib/i18n";
import { useMe } from "@/lib/session";
import { PageHeader, Panel, Empty } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

// Phase 7 — grade-review requests.
//
// Student: picks one of their RELEASED submissions, optionally one of
// its questions, and writes why the grade should be reviewed. The
// insert policy recomputes ownership server-side (released submission,
// assessment's real owner, question belonging to that assessment).
// Teacher: lists requests for their own assessments and resolves them
// through the SECURITY DEFINER fn resolve_review_request — there is no
// direct UPDATE policy, so a teacher can change only status/response.

type ReviewRow = {
  id: string;
  submission_id: string;
  question_id: string | null;
  student_id: string;
  teacher_id: string;
  message: string;
  status: string;
  teacher_response: string;
  created_at: string;
  resolved_at: string | null;
};

export const Route = createFileRoute("/_authenticated/reviews")({
  head: () => ({
    meta: [
      { title: "Grade reviews · Qayyimni" },
      { name: "description", content: "Students request grade reviews; teachers resolve them." },
    ],
  }),
  component: ReviewsPage,
});

function ReviewsPage() {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const { data: me, isLoading: meLoading } = useMe();
  const role = me?.role as string | undefined;
  const isStudent = role === "student";
  const isTeacher = role === "school_teacher" || role === "tutor" || role === "teacher";

  const [assessmentId, setAssessmentId] = useState("");
  const [questionId, setQuestionId] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [responses, setResponses] = useState<Record<string, string>>({});
  const [resolving, setResolving] = useState<string | null>(null);

  const releasedQuery = useQuery({
    queryKey: ["reviews-released", me?.id],
    enabled: !!me?.id && isStudent,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("submissions")
        .select("id, assessment_id")
        .eq("student_id", me!.id)
        .eq("status", "released");
      if (error) throw error;
      return data ?? [];
    },
  });
  const released = releasedQuery.data ?? [];
  const releasedAssessmentIds = [...new Set(released.map((s) => s.assessment_id))];

  const assessmentsQuery = useQuery({
    queryKey: ["reviews-assessments", releasedAssessmentIds.join(",")],
    enabled: releasedAssessmentIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("assessments")
        .select("id, title, teacher_id")
        .in("id", releasedAssessmentIds);
      if (error) throw error;
      return data ?? [];
    },
  });
  const assessments = useMemo(() => assessmentsQuery.data ?? [], [assessmentsQuery.data]);

  useEffect(() => {
    if (!assessmentId && assessments.length > 0) setAssessmentId(assessments[0]!.id);
  }, [assessmentId, assessments]);

  const submission = released.find((s) => s.assessment_id === assessmentId) ?? null;

  const questionsQuery = useQuery({
    queryKey: ["reviews-questions", assessmentId],
    enabled: !!assessmentId && isStudent,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("questions")
        .select("id, prompt")
        .eq("assessment_id", assessmentId)
        .order("position");
      if (error) throw error;
      return data ?? [];
    },
  });

  const requestsQuery = useQuery({
    queryKey: ["reviews-list", me?.id, role],
    enabled: !!me?.id && (isStudent || isTeacher),
    queryFn: async () => {
      const col = isStudent ? "student_id" : "teacher_id";
      const { data, error } = await supabase
        .from("grade_review_requests")
        .select("*")
        .eq(col, me!.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as ReviewRow[];
    },
  });
  const requests = requestsQuery.data ?? [];

  // Display maps: submission -> assessment title, question prompt, names.
  const requestSubmissionIds = [...new Set(requests.map((r) => r.submission_id))];
  const requestStudentIds = [...new Set(requests.map((r) => r.student_id))];
  const requestQuestionIds = [
    ...new Set(requests.map((r) => r.question_id).filter(Boolean)),
  ] as string[];

  const mapsQuery = useQuery({
    queryKey: [
      "reviews-maps",
      requestSubmissionIds.join(","),
      requestStudentIds.join(","),
      requestQuestionIds.join(","),
    ],
    enabled: requests.length > 0,
    queryFn: async () => {
      const [{ data: subs }, { data: profiles }, { data: questions }] = await Promise.all([
        supabase.from("submissions").select("id, assessment_id").in("id", requestSubmissionIds),
        supabase.from("profiles").select("id, full_name").in("id", requestStudentIds),
        requestQuestionIds.length > 0
          ? supabase.from("questions").select("id, prompt").in("id", requestQuestionIds)
          : Promise.resolve({ data: [] as { id: string; prompt: string }[] }),
      ]);
      const assessmentIds = [...new Set((subs ?? []).map((s) => s.assessment_id))];
      const { data: assess } =
        assessmentIds.length > 0
          ? await supabase.from("assessments").select("id, title").in("id", assessmentIds)
          : { data: [] as { id: string; title: string }[] };
      return {
        submissionToAssessment: Object.fromEntries(
          (subs ?? []).map((s) => [s.id, s.assessment_id]),
        ),
        assessmentTitles: Object.fromEntries((assess ?? []).map((a) => [a.id, a.title])),
        names: Object.fromEntries((profiles ?? []).map((p) => [p.id, p.full_name || "—"])),
        questionPrompts: Object.fromEntries((questions ?? []).map((q) => [q.id, q.prompt])),
      };
    },
  });
  const maps = mapsQuery.data;

  async function submitRequest() {
    if (!submission || !message.trim()) return;
    const assessment = assessments.find((a) => a.id === assessmentId);
    if (!assessment) return;
    setSubmitting(true);
    try {
      const { error } = await supabase.from("grade_review_requests").insert({
        submission_id: submission.id,
        question_id: questionId || null,
        student_id: me!.id,
        teacher_id: assessment.teacher_id,
        message: message.trim(),
      });
      if (error) throw error;
      toast.success(t("reviewsSubmitted"));
      setMessage("");
      setQuestionId("");
      await qc.invalidateQueries({ queryKey: ["reviews-list"] });
    } catch (err) {
      toast.error(translateError(err, lang));
    } finally {
      setSubmitting(false);
    }
  }

  async function resolveRequest(requestId: string) {
    const response = (responses[requestId] ?? "").trim();
    setResolving(requestId);
    try {
      const { data, error } = await supabase.rpc("resolve_review_request", {
        _id: requestId,
        _response: response,
      });
      if (error) throw error;
      if (!data) {
        toast.error(t("reviewsResolveFailed"));
        return;
      }
      toast.success(t("reviewsResolved"));
      await qc.invalidateQueries({ queryKey: ["reviews-list"] });
    } catch (err) {
      toast.error(translateError(err, lang));
    } finally {
      setResolving(null);
    }
  }

  if (meLoading) return <p className="text-muted-foreground">{t("loading")}</p>;
  if (!me || (!isStudent && !isTeacher)) return <Empty>{t("reviewsRoleNote")}</Empty>;

  return (
    <>
      <PageHeader title={t("reviewsTitle")} subtitle={t("reviewsSubtitle")} />
      <div className="space-y-6">
        {isStudent && (
          <Panel className="space-y-4">
            <h2 className="font-semibold">{t("reviewsNew")}</h2>
            {assessments.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("tutorNoReleased")}</p>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label>{t("reviewsSelectAssessment")}</Label>
                  <select
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                    value={assessmentId}
                    onChange={(e) => {
                      setAssessmentId(e.target.value);
                      setQuestionId("");
                    }}
                  >
                    {assessments.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.title}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label>{t("reviewsSelectQuestion")}</Label>
                  <select
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                    value={questionId}
                    onChange={(e) => setQuestionId(e.target.value)}
                  >
                    <option value="">{t("reviewsWholeAssessment")}</option>
                    {(questionsQuery.data ?? []).map((q, i) => (
                      <option key={q.id} value={q.id}>
                        {i + 1}. {(q.prompt || "").slice(0, 60)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label>{t("reviewsMessage")}</Label>
                  <Textarea
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder={t("reviewsMessagePlaceholder")}
                    rows={3}
                  />
                </div>
                <Button
                  onClick={() => void submitRequest()}
                  disabled={submitting || !message.trim()}
                >
                  {submitting ? t("loading") : t("reviewsSubmit")}
                </Button>
              </>
            )}
          </Panel>
        )}

        <Panel className="space-y-4">
          <h2 className="font-semibold">
            {isStudent ? t("reviewsMyRequests") : t("reviewsTeacherRequests")}
          </h2>
          {requestsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">{t("loading")}</p>
          ) : requests.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("reviewsNoRequests")}</p>
          ) : (
            <ul className="space-y-4">
              {requests.map((r) => {
                const assessmentTitle = maps
                  ? (maps.assessmentTitles[maps.submissionToAssessment[r.submission_id] ?? ""] ??
                    "—")
                  : "—";
                const questionPrompt = r.question_id
                  ? (maps?.questionPrompts[r.question_id] ?? "—")
                  : null;
                return (
                  <li key={r.id} className="space-y-2 rounded-md border p-3">
                    <p className="text-sm">
                      <span className="font-medium">{assessmentTitle}</span>
                      {isTeacher && (
                        <span className="text-muted-foreground">
                          {" "}
                          · {maps?.names[r.student_id] ?? "—"}
                        </span>
                      )}
                      <span className="text-muted-foreground">
                        {" "}
                        · {t(`reviewsStatus_${r.status}` as never)}
                      </span>
                    </p>
                    {questionPrompt && (
                      <p className="text-sm text-muted-foreground">
                        {t("reviewsQuestion")}: {(questionPrompt || "").slice(0, 120)}
                      </p>
                    )}
                    <p className="whitespace-pre-wrap text-sm">{r.message}</p>
                    {r.teacher_response && (
                      <p className="whitespace-pre-wrap rounded-md bg-muted p-3 text-sm">
                        {t("reviewsResponse")}: {r.teacher_response}
                      </p>
                    )}
                    {isTeacher && r.status === "open" && (
                      <div className="space-y-2">
                        <Textarea
                          value={responses[r.id] ?? ""}
                          onChange={(e) =>
                            setResponses((prev) => ({ ...prev, [r.id]: e.target.value }))
                          }
                          placeholder={t("reviewsResponsePlaceholder")}
                          rows={2}
                        />
                        <Button
                          size="sm"
                          onClick={() => void resolveRequest(r.id)}
                          disabled={resolving === r.id}
                        >
                          {t("reviewsResolve")}
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}

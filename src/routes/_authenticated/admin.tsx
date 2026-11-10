import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  createSetPasswordInvitationD1,
  decideAccountD1,
  getAdminCountsD1,
  listAccountsD1,
  listPasswordlessAccountsD1,
  listSiteActivityD1,
  listTakeWriteFailuresD1,
  resetUserPasswordD1,
  type AdminAccount,
  type PasswordlessAccount,
  type SiteActivityRow,
  type TakeWriteFailureRow,
} from "@/server/d1-admin";
import { useMe } from "@/lib/session";
import { useI18n, translateError } from "@/lib/i18n";
import { PageHeader, Panel, Empty } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/admin")({
  head: () => ({ meta: [{ title: "Admin · Qayyimni" }] }),
  component: Admin,
});

type ActivityT = ReturnType<typeof useI18n>["t"];

// Human label for one activity-feed action. Unknown actions fall back
// to the raw action string (never blank). Only curated fields are
// rendered downstream: time / actor / type / target — never raw
// details (ids, scores) and never anything password-shaped.
// The server whitelists details to these keys before they reach us:
// target_label, exam_label, group_label, decision, to.
function activityLabel(row: SiteActivityRow, t: ActivityT, lang: "ar" | "en"): string {
  const details = typeof row.details === "object" ? row.details : {};
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const ar = lang === "ar";
  switch (row.action) {
    case "account_signup":
      return ar ? "تسجيل حساب جديد" : "New account signed up";
    case "account_approved":
      return ar ? "قبول حساب" : "Account approved";
    case "account_rejected":
      return ar ? "رفض حساب" : "Account rejected";
    case "password_reset":
      return ar ? "تعيين كلمة سر مؤقتة" : "Temporary password set";
    case "group_created":
      return ar ? "إنشاء مجموعة" : "Group created";
    case "group_updated":
      return ar ? "تعديل مجموعة" : "Group updated";
    case "group_deleted":
      return ar ? "حذف مجموعة" : "Group deleted";
    case "group_join_requested":
      return ar ? "طلب انضمام لمجموعة" : "Group join requested";
    case "group_membership_decision":
      if (str(details["decision"]) === "approved")
        return ar ? "قبول عضوية مجموعة" : "Group membership approved";
      if (str(details["decision"]) === "rejected")
        return ar ? "رفض عضوية مجموعة" : "Group membership rejected";
      return ar ? "قرار عضوية مجموعة" : "Group membership decision";
    case "group_membership_approve_all":
      return ar ? "قبول جماعي لأعضاء مجموعة" : "All group members approved";
    case "enrollment_approved":
      return ar ? "قبول انضمام طالب" : "Student enrollment approved";
    case "enrollment_rejected":
      return ar ? "رفض انضمام طالب" : "Student enrollment rejected";
    case "enrollment_approve_all":
      return ar ? "قبول جماعي للطلاب" : "All enrollments approved";
    case "exam_created":
      return ar ? "إنشاء امتحان" : "Exam created";
    case "assessment_status":
      if (str(details["to"]) === "published") return ar ? "نشر امتحان" : "Exam published";
      if (str(details["to"]) === "draft")
        return ar ? "إرجاع امتحان لمسودة" : "Exam returned to draft";
      return t("auditActionAssessmentStatus");
    case "group_exam_assigned":
      return ar ? "ربط امتحان بمجموعة" : "Exam assigned to group";
    case "exam_submitted":
      return ar ? "تسليم امتحان" : "Exam submitted";
    case "review_answer":
      return t("auditActionReviewAnswer");
    case "release":
      return t("auditActionRelease");
    case "ai_suggestion":
      return t("auditActionAiSuggestion");
    case "handwritten_grade":
      return t("auditActionHandwrittenGrade");
    case "handwritten_grade_deleted":
      return t("auditActionHandwrittenGradeDeleted");
    default:
      return row.action;
  }
}

// Target line for one feed row: the written label first, then the
// resolved account name, then the raw entity id as a last resort,
// plus exam/group qualifiers when the writer stored them.
function activityTarget(row: SiteActivityRow): string {
  const details = typeof row.details === "object" ? row.details : {};
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const base = str(details["target_label"]) || row.targetName || row.entityId || "";
  const examLabel = str(details["exam_label"]);
  const groupLabel = str(details["group_label"]);
  return [base, examLabel, groupLabel].filter((s) => s !== "").join(" · ");
}

function Admin() {
  const { t, lang } = useI18n();
  const { data: me, isLoading } = useMe();
  const { data } = useQuery({
    queryKey: ["admin-page"],
    enabled: me?.role === "admin",
    // D1 (admin-gated server-side): counts only, never user rows.
    queryFn: async () => getAdminCountsD1({ data: {} }),
  });
  // Passwordless list: 50 per page, oldest first. Pages accumulate
  // below; "Load more" fetches the next page while one exists.
  const [passwordlessPage, setPasswordlessPage] = useState(0);
  const [passwordlessAll, setPasswordlessAll] = useState<PasswordlessAccount[]>([]);
  const [passwordlessHasNext, setPasswordlessHasNext] = useState(false);
  const { data: passwordlessData, refetch: refetchPasswordless } = useQuery({
    queryKey: ["admin-passwordless", passwordlessPage],
    enabled: me?.role === "admin",
    // Admin-only server function: id + email + created date only.
    queryFn: async () =>
      (await listPasswordlessAccountsD1({ data: { page: passwordlessPage } })) as {
        rows: PasswordlessAccount[];
        hasNext: boolean;
      },
  });
  useEffect(() => {
    if (!passwordlessData) return;
    setPasswordlessHasNext(passwordlessData.hasNext);
    setPasswordlessAll((prev) =>
      passwordlessPage === 0
        ? passwordlessData.rows
        : [...prev, ...passwordlessData.rows.filter((r) => !prev.some((p) => p.id === r.id))],
    );
  }, [passwordlessData, passwordlessPage]);
  const passwordless = passwordlessAll;
  // Approval queue: 50 per page, pending first. Pages accumulate
  // below; "Load more" fetches the next page while one exists.
  const [accountsPage, setAccountsPage] = useState(0);
  const [accountsAll, setAccountsAll] = useState<AdminAccount[]>([]);
  const [accountsHasNext, setAccountsHasNext] = useState(false);
  const { data: accountsData, refetch: refetchAccounts } = useQuery({
    queryKey: ["admin-accounts", accountsPage],
    enabled: me?.role === "admin",
    // Admin-only server function: full identity + status, never passwords.
    queryFn: async () =>
      (await listAccountsD1({ data: { page: accountsPage } })) as {
        rows: AdminAccount[];
        hasNext: boolean;
      },
  });
  useEffect(() => {
    if (!accountsData) return;
    setAccountsHasNext(accountsData.hasNext);
    setAccountsAll((prev) =>
      accountsPage === 0
        ? accountsData.rows
        : [...prev, ...accountsData.rows.filter((r) => !prev.some((p) => p.id === r.id))],
    );
  }, [accountsData, accountsPage]);
  const accounts = accountsAll;
  // After a decision the queue order can change (pending sorts first),
  // so restart from page 0 instead of refetching the current page.
  function refreshAccounts() {
    if (accountsPage === 0) void refetchAccounts();
    else setAccountsPage(0);
  }
  function refreshPasswordless() {
    if (passwordlessPage === 0) void refetchPasswordless();
    else setPasswordlessPage(0);
  }
  // Site-wide activity feed: newest first, keyset cursor paging (50
  // per page). The cursor points at the last row shown, so new events
  // arriving between pages cannot duplicate or skip rows. "Load more"
  // is hidden once the server reports a null nextCursor (end-of-feed).
  const [activityCursor, setActivityCursor] = useState<string | null>(null);
  const [activityRows, setActivityRows] = useState<SiteActivityRow[]>([]);
  const [activityNextCursor, setActivityNextCursor] = useState<string | null>(null);
  const { data: activityData } = useQuery({
    queryKey: ["admin-activity", activityCursor ?? "first"],
    enabled: me?.role === "admin",
    // Admin-only server function, display only: time / actor / type /
    // target. Never answer content, never passwords or hashes.
    queryFn: async () =>
      (await listSiteActivityD1({ data: { cursor: activityCursor } })) as {
        rows: SiteActivityRow[];
        nextCursor: string | null;
      },
  });
  useEffect(() => {
    if (!activityData) return;
    setActivityNextCursor(activityData.nextCursor);
    setActivityRows((prev) =>
      activityCursor === null
        ? activityData.rows
        : [...prev, ...activityData.rows.filter((r) => !prev.some((p) => p.id === r.id))],
    );
  }, [activityData, activityCursor]);
  const activity = activityRows;

  // Phase 3: failed take-queue writes (ids + reason only). A row here
  // means the message ALSO sits in the dead-letter queue — the DLQ is
  // the replay source, this panel is the visible surface.
  const { data: failures } = useQuery({
    queryKey: ["admin-take-failures"],
    queryFn: async () =>
      (await listTakeWriteFailuresD1({ data: undefined })) as TakeWriteFailureRow[],
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  const [deciding, setDeciding] = useState<string | null>(null);
  const [resetting, setResetting] = useState<string | null>(null);
  // Temporary password from the last reset: kept ONLY in component
  // state, shown once, never logged or stored anywhere else.
  const [tempPassword, setTempPassword] = useState<{
    email: string;
    value: string;
  } | null>(null);
  async function decide(userId: string, decision: "approved" | "rejected") {
    setDeciding(`${userId}:${decision}`);
    try {
      await decideAccountD1({ data: { userId, decision } });
      toast.success(t("accountDecisionDone"));
      refreshAccounts();
    } catch (err) {
      toast.error(translateError(err, lang));
    } finally {
      setDeciding(null);
    }
  }
  async function resetPassword(userId: string, email: string) {
    setResetting(userId);
    try {
      const result = (await resetUserPasswordD1({ data: { userId } })) as {
        temporaryPassword: string;
      };
      setTempPassword({ email, value: result.temporaryPassword });
      toast.success(t("passwordResetDone"));
      refreshAccounts();
    } catch (err) {
      toast.error(translateError(err, lang));
    } finally {
      setResetting(null);
    }
  }
  const [inviting, setInviting] = useState<string | null>(null);
  async function invite(email: string) {
    setInviting(email);
    try {
      await createSetPasswordInvitationD1({ data: { email } });
      toast.success(lang === "ar" ? "اتبعَت دعوة تعيين كلمة سر." : "Set-password invitation sent.");
      refreshPasswordless();
    } catch (err) {
      toast.error(translateError(err, lang));
    } finally {
      setInviting(null);
    }
  }
  // Approval queue split (2026-11-06, user request): teachers and
  // students in separate sections so the admin can choose who to
  // approve. Server order is kept inside each section (pending
  // first, then newest). Admin-role rows are not approvable and go
  // in their own small section only when present.
  const teachers = (accounts ?? []).filter(
    (a) => a.role === "school_teacher" || a.role === "tutor",
  );
  const students = (accounts ?? []).filter((a) => a.role === "student");
  const admins = (accounts ?? []).filter(
    (a) => a.role !== "school_teacher" && a.role !== "tutor" && a.role !== "student",
  );
  const accountRow = (a: AdminAccount) => (
    <li
      key={a.id}
      className="flex flex-wrap items-start justify-between gap-3 rounded-sm border px-3 py-2"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{a.fullName}</span>
        <span dir="ltr" className="block truncate text-sm text-muted-foreground">
          {a.email}
        </span>
        <span className="mt-1 block text-xs leading-5 text-muted-foreground">
          {a.phone ? (
            <span dir="ltr" className="me-2">
              {a.phone}
            </span>
          ) : null}
          {a.subjects ? <span className="me-2">{a.subjects}</span> : null}
          {a.school ? <span className="me-2">{a.school}</span> : null}
          <span className="me-2">{t(a.role as "school_teacher")}</span>
          <span className="me-2">{a.createdAt}</span>
          <span className="font-medium">
            {a.status === "pending"
              ? t("accountPending")
              : a.status === "approved"
                ? t("accountApproved")
                : t("accountRejected")}
          </span>
        </span>
      </span>
      <span className="flex flex-wrap gap-2">
        {a.status === "pending" ? (
          <>
            <Button
              size="sm"
              disabled={deciding === `${a.id}:approved`}
              onClick={() => void decide(a.id, "approved")}
            >
              {t("approveAccount")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={deciding === `${a.id}:rejected`}
              onClick={() => void decide(a.id, "rejected")}
            >
              {t("rejectAccount")}
            </Button>
          </>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          disabled={resetting === a.id}
          onClick={() => void resetPassword(a.id, a.email)}
        >
          {t("resetPassword")}
        </Button>
      </span>
    </li>
  );
  if (isLoading || !me) return <p className="text-muted-foreground">{t("loading")}</p>;
  if (me.role !== "admin")
    return (
      <Panel>
        <Empty>{t("adminOnly")}</Empty>
      </Panel>
    );
  return (
    <>
      <PageHeader title={t("admin")} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[
          { label: t("summaryTeachers"), value: data?.teachers },
          { label: t("summaryStudents"), value: data?.students },
        ].map((c) => (
          <Panel key={c.label}>
            <p className="text-sm text-muted-foreground">{c.label}</p>
            <p className="mt-2 font-display text-3xl font-bold text-primary">{c.value ?? "—"}</p>
          </Panel>
        ))}
      </div>

      <Panel>
        <h2 className="text-base font-bold">{t("adminAccounts")}</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {lang === "ar"
            ? "كل حساب مسجل: اسمه وبريده ورقمه ومواده ومدرسته ودوره وتاريخ تسجيله وحالته. الحسابات متقسمة لقسمين — معلمين وطلاب — عشان تختار مين تقبله. الحسابات الجديدة بانتظار الموافقة ومش بتدخل على أي حاجة لحد ما تقبلها. كلمات السر مش بتظهر هنا أبداً — لو حد نسي كلمته، عيّن له كلمة سر مؤقتة من هنا وهتظهر لك مرة واحدة بس."
            : "Every registered account: name, email, phone, subjects, school, role, signup date and status. Accounts are split into two sections — teachers and students — so you can choose who to approve. New accounts wait for approval and cannot use anything until you approve them. Passwords are never shown here — if someone forgot theirs, set a temporary password here and it will be shown to you only once."}
        </p>
        {tempPassword ? (
          <div className="mt-4 rounded-sm border border-amber-500/50 bg-amber-500/10 px-3 py-3">
            <p className="text-sm font-bold">{t("tempPasswordLabel")}</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("tempPasswordNote")}</p>
            <p className="mt-2 flex flex-wrap items-center gap-2">
              <span dir="ltr" className="rounded-sm bg-background px-2 py-1 font-mono text-sm">
                {tempPassword.value}
              </span>
              <span className="text-xs text-muted-foreground">({tempPassword.email})</span>
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(tempPassword.value);
                    toast.success(lang === "ar" ? "اتنسخت." : "Copied.");
                  } catch {
                    toast.error(
                      lang === "ar"
                        ? "النسخ فشل — انسخها يدوياً."
                        : "Copy failed — copy it manually.",
                    );
                  }
                }}
              >
                {lang === "ar" ? "نسخ" : "Copy"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setTempPassword(null)}>
                {lang === "ar" ? "إخفاء" : "Dismiss"}
              </Button>
            </p>
          </div>
        ) : null}
        {!accounts || accounts.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">{t("noAccounts")}</p>
        ) : (
          <>
            <h3 className="mt-5 text-sm font-bold">
              {t("teachers")} ({data?.teachers ?? teachers.length})
            </h3>
            {teachers.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">
                {lang === "ar" ? "مفيش معلمين مسجلين." : "No teachers registered."}
              </p>
            ) : (
              <ul className="mt-2 space-y-3">{teachers.map((a) => accountRow(a))}</ul>
            )}
            <h3 className="mt-5 text-sm font-bold">
              {t("students")} ({data?.students ?? students.length})
            </h3>
            {students.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">
                {lang === "ar" ? "مفيش طلاب مسجلين." : "No students registered."}
              </p>
            ) : (
              <ul className="mt-2 space-y-3">{students.map((a) => accountRow(a))}</ul>
            )}
            {admins.length > 0 ? (
              <>
                <h3 className="mt-5 text-sm font-bold">
                  {lang === "ar" ? "المدراء" : "Admins"} ({admins.length})
                </h3>
                <ul className="mt-2 space-y-3">{admins.map((a) => accountRow(a))}</ul>
              </>
            ) : null}
            {accountsHasNext ? (
              <Button
                size="sm"
                variant="outline"
                className="mt-4"
                onClick={() => setAccountsPage((p) => p + 1)}
              >
                {lang === "ar" ? "عرض المزيد" : "Load more"}
              </Button>
            ) : null}
          </>
        )}
      </Panel>

      <Panel>
        <h2 className="text-base font-bold">
          {lang === "ar" ? "أحدث النشاط على الموقع" : "Recent site activity"}
        </h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {lang === "ar"
            ? "كل حاجة بتحصل على الموقع، الأحدث أولاً: تسجيلات، موافقات، مجموعات، امتحانات، تسليمات، تصحيح، ودرجات ورقية. للعرض بس — مفيش أي إجراء من هنا، ومفيش محتوى إجابات ولا كلمات سر بتظهر."
            : "Everything happening on the site, newest first: signups, approvals, groups, exams, submissions, grading, and handwritten grades. Display only — no actions from here, and no answer content or passwords are shown."}
        </p>
        {!activity || activity.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">
            {lang === "ar" ? "مفيش نشاط لسه." : "No activity yet."}
          </p>
        ) : (
          <>
            <ul className="mt-4 space-y-3">
              {activity.map((row) => (
                <li key={row.id} className="rounded-sm border px-3 py-2">
                  <span className="block text-sm font-medium">{activityLabel(row, t, lang)}</span>
                  <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                    <span className="me-2">{row.actorName || row.actorEmail}</span>
                    {row.actorName ? (
                      <span dir="ltr" className="me-2">
                        {row.actorEmail}
                      </span>
                    ) : null}
                    <span className="me-2">{t(row.actorRole as "school_teacher")}</span>
                    <span className="me-2">{row.createdAt}</span>
                  </span>
                  {activityTarget(row) ? (
                    <span className="mt-1 block truncate text-sm">{activityTarget(row)}</span>
                  ) : null}
                </li>
              ))}
            </ul>
            {activityNextCursor !== null ? (
              <Button
                size="sm"
                variant="outline"
                className="mt-4"
                onClick={() => setActivityCursor(activityNextCursor)}
              >
                {lang === "ar" ? "عرض المزيد" : "Load more"}
              </Button>
            ) : null}
          </>
        )}
      </Panel>

      <Panel>
        <h2 className="text-base font-bold">
          {lang === "ar" ? "محاولات التسليم الفاشلة" : "Failed take writes"}
        </h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {lang === "ar"
            ? "رسايل بدء/حفظ/تسليم ماتطبقتش بعد كل المحاولات — لأغراض العرض بس، مفيش محتوى إجابات بيظهر هنا. الرسالة نفسها محفوظة في قائمة الرسايل الميتة (DLQ) على Cloudflare، ومنها تقدر تعيد تشغيلها."
            : "Start/draft/submit messages that failed after all retries — display only, no answer content is shown here. The message itself is kept in the dead-letter queue (DLQ) on Cloudflare, where it can be retried from."}
        </p>
        {!failures || failures.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">
            {lang === "ar" ? "مفيش محاولات فاشلة." : "No failed writes."}
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {failures.map((f) => (
              <li key={f.id} className="rounded-sm border px-3 py-2">
                <span className="block text-sm font-medium">
                  {f.studentName || f.studentEmail}
                  {f.assessmentTitle ? ` — ${f.assessmentTitle}` : ""}
                </span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                  <span className="me-2">{f.messageType}</span>
                  <span className="me-2">
                    {lang === "ar" ? "محاولات: " : "attempts: "}
                    {f.attempts}
                  </span>
                  <span className="me-2">{f.createdAt}</span>
                </span>
                <span className="mt-1 block truncate text-sm" dir="ltr">
                  {f.reason}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel>
        <h2 className="text-base font-bold">
          {lang === "ar" ? "حسابات بلا كلمة سر" : "Passwordless accounts"}
        </h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {lang === "ar"
            ? "الحسابات اللي اتنقلت من Google ولسه معندهاش كلمة سر. ابعت لكل واحد دعوة تعيين كلمة سر على بريده — الدعوة صالحة لساعة واحدة وتُستخدم مرة واحدة."
            : "Accounts migrated from Google that have no password yet. Send each one a set-password invitation to its email — valid for one hour, single-use."}
        </p>
        {!passwordless || passwordless.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">
            {lang === "ar" ? "مفيش حسابات بلا كلمة سر." : "No passwordless accounts."}
          </p>
        ) : (
          <>
            <ul className="mt-4 space-y-3">
              {passwordless.map((a) => (
                <li
                  key={a.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-sm border px-3 py-2"
                >
                  <span className="min-w-0">
                    <span dir="ltr" className="block truncate text-sm font-medium">
                      {a.email}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {lang === "ar" ? "أُنشئ في " : "Created "}
                      {a.createdAt}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    disabled={inviting === a.email}
                    onClick={() => void invite(a.email)}
                  >
                    {lang === "ar" ? "ابعت دعوة" : "Send invitation"}
                  </Button>
                </li>
              ))}
            </ul>
            {passwordlessHasNext ? (
              <Button
                size="sm"
                variant="outline"
                className="mt-4"
                onClick={() => setPasswordlessPage((p) => p + 1)}
              >
                {lang === "ar" ? "عرض المزيد" : "Load more"}
              </Button>
            ) : null}
          </>
        )}
      </Panel>
    </>
  );
}

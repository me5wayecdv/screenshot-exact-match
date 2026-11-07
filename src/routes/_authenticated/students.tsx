import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Check, X } from "lucide-react";
import {
  approveAllEnrollmentsD1,
  decideEnrollmentD1,
  listStudentRosterD1,
  removeStudentD1,
} from "@/server/d1-students";
import { useMe } from "@/lib/session";
import { useI18n, formatDate, translateError } from "@/lib/i18n";
import { displayName, pendingCount, splitRoster } from "@/lib/enrollment";
import { PageHeader, Panel, Empty, Pill } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { ParentContactForm } from "@/components/parent-contact-form";

export const Route = createFileRoute("/_authenticated/students")({
  head: () => ({
    meta: [
      { title: "Students · Qayyimni" },
      { name: "description", content: "Manage your students." },
    ],
  }),
  component: Students,
});

function Students() {
  const { t, lang } = useI18n();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ["my-students"],
    // D1 roster: the status rides along, so one read answers three
    // questions — who is waiting, who is mine, who was turned down.
    // Contact data rides only on approved rows (server-side CASE).
    queryFn: async () => listStudentRosterD1({ data: {} }),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["my-students"] });
  const { pending, approved, rejected } = splitRoster(data);

  async function decide(studentId: string, approve: boolean) {
    setBusy(studentId);
    const name = displayName(data?.find((r) => r.student_id === studentId) ?? {});
    try {
      await decideEnrollmentD1({ data: { studentId, approve } });
    } catch (err) {
      setBusy(null);
      return void toast.error(translateError(err, lang));
    }
    setBusy(null);
    toast.success(approve ? t("enrollmentApproved", { name }) : t("enrollmentRejected", { name }));
    refresh();
  }

  async function approveAll() {
    setBusy("all");
    let count: number;
    try {
      count = await approveAllEnrollmentsD1({ data: {} });
    } catch (err) {
      setBusy(null);
      return void toast.error(translateError(err, lang));
    }
    setBusy(null);
    toast.success(t("enrollmentApprovedAll", { count: String(count ?? pending.length) }));
    refresh();
  }

  async function remove(id: string) {
    try {
      await removeStudentD1({ data: { studentId: id } });
    } catch (err) {
      return void toast.error(translateError(err, lang));
    }
    refresh();
  }

  return (
    <>
      <PageHeader title={t("students")} />
      <Panel className="mb-8">
        <p className="text-sm text-muted-foreground">{t("joinCode")}</p>
        <p dir="ltr" className="figures mt-1 text-3xl font-semibold tracking-[0.2em] text-primary">
          {me?.joinCode ?? "—"}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">{t("joinCodeHint")}</p>
      </Panel>

      {/* Requests first: this is the only thing on the page that needs a decision. */}
      <section className="mb-8">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">
              {t("enrollmentRequestsTitle")}
              {pending.length > 0 ? (
                <span className="ms-2 align-middle">
                  <Pill t="warning">{String(pendingCount(data))}</Pill>
                </span>
              ) : null}
            </h2>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">
              {t("enrollmentPendingHint")}
            </p>
          </div>
          {pending.length > 0 ? (
            <Button onClick={approveAll} disabled={busy === "all"} className="lift">
              <Check className="size-4" aria-hidden />
              {t("enrollmentApproveAll", { count: String(pending.length) })}
            </Button>
          ) : null}
        </div>

        {pending.length === 0 ? (
          <Empty>{t("enrollmentNone")}</Empty>
        ) : (
          <ul className="divide-y rounded-lg border bg-card">
            {pending.map((s) => (
              <li
                key={s.student_id}
                className="flex flex-wrap items-center justify-between gap-3 p-4"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{displayName(s)}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t("enrollmentDate")} {formatDate(s.requested_at ?? s.joined_at, lang)}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={() => decide(s.student_id, true)}
                    disabled={busy === s.student_id}
                  >
                    <Check className="size-4" aria-hidden />
                    {t("enrollmentApprove")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => decide(s.student_id, false)}
                    disabled={busy === s.student_id}
                  >
                    <X className="size-4" aria-hidden />
                    {t("enrollmentReject")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <h2 className="mb-3 text-lg font-semibold">{t("students")}</h2>
      {approved.length === 0 ? (
        <Empty>{t("noStudents")}</Empty>
      ) : (
        <div className="divide-y rounded-lg border bg-card">
          {approved.map((s) => (
            <div key={s.student_id} className="space-y-3 p-4">
              <div className="flex items-center justify-between">
                <span className="font-medium">{displayName(s)}</span>
                <span className="flex items-center gap-3 text-sm text-muted-foreground">
                  {formatDate(s.joined_at, lang)}
                  <Button size="sm" variant="ghost" onClick={() => remove(s.student_id)}>
                    {t("remove")}
                  </Button>
                </span>
              </div>
              <ParentContactForm
                studentId={s.student_id}
                initialPhone={s.parent_phone}
                initialConsent={s.whatsapp_consent}
                onSaved={refresh}
              />
            </div>
          ))}
        </div>
      )}

      {/* Rejected stays visible: a decision the teacher can reverse. */}
      {rejected.length > 0 ? (
        <section className="mt-8">
          <h2 className="mb-2 text-base font-semibold">{t("enrollmentRejectedTitle")}</h2>
          <p className="mb-3 text-sm text-muted-foreground">{t("enrollmentRejectedNote")}</p>
          <ul className="divide-y rounded-lg border bg-card">
            {rejected.map((s) => (
              <li key={s.student_id} className="flex items-center justify-between gap-3 p-4">
                <span className="text-sm text-muted-foreground">{displayName(s)}</span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => decide(s.student_id, true)}
                  disabled={busy === s.student_id}
                >
                  {t("enrollmentApprove")}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

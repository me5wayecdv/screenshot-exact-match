import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Check, X, Users } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useMe } from "@/lib/session";
import { useI18n, formatDate, translateError } from "@/lib/i18n";
import { displayName, splitRoster } from "@/lib/enrollment";
import { PageHeader, Panel, Empty, Pill } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/groups")({
  head: () => ({
    meta: [
      { title: "My groups · Qayyimni" },
      { name: "description", content: "Teacher groups and group join codes." },
    ],
  }),
  component: Groups,
});

type TeacherGroup = {
  group_id: string;
  name: string;
  school_year: string;
  days: string[];
  time_text: string;
  notes: string;
  join_code: string;
  approved_count: number;
  pending_count: number;
  created_at: string;
};

type RosterRow = {
  student_id: string;
  full_name: string;
  status: string;
  requested_at: string | null;
};

type MyGroup = {
  group_id: string;
  group_name: string;
  school_year: string;
  days: string[];
  time_text: string;
  teacher_id: string;
  teacher_name: string;
};

type PendingGroup = {
  group_id: string;
  group_name: string;
  teacher_id: string;
  teacher_name: string;
  requested_at: string;
};

const DAY_KEYS = ["sat", "sun", "mon", "tue", "wed", "thu", "fri"] as const;

function Groups() {
  const { t } = useI18n();
  const { data: me } = useMe();
  const isTeacher = me?.role === "school_teacher" || me?.role === "tutor";
  if (isTeacher) return <TeacherGroups />;
  if (me?.role === "student") return <StudentGroups />;
  return (
    <>
      <PageHeader title={t("groups")} />
      <Empty>{t("groupNone")}</Empty>
    </>
  );
}

function dayLabels(t: (key: string) => string) {
  return {
    sat: t("daySat"),
    sun: t("daySun"),
    mon: t("dayMon"),
    tue: t("dayTue"),
    wed: t("dayWed"),
    thu: t("dayThu"),
    fri: t("dayFri"),
  } as Record<string, string>;
}

function TeacherGroups() {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [year, setYear] = useState("");
  const [days, setDays] = useState<string[]>([]);
  const [time, setTime] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const labels = dayLabels(t as (key: string) => string);

  const { data: groups } = useQuery({
    queryKey: ["my-teacher-groups"],
    queryFn: async () => ((await supabase.rpc("my_teacher_groups")).data ?? []) as TeacherGroup[],
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["my-teacher-groups"] });

  function toggleDay(key: string) {
    setDays((cur) => (cur.includes(key) ? cur.filter((d) => d !== key) : [...cur, key]));
  }

  async function create() {
    if (name.trim() === "") return;
    setBusy(true);
    const { error } = await supabase.rpc("create_teacher_group", {
      _name: name.trim(),
      _year: year.trim(),
      _days: days,
      _time: time.trim(),
      _notes: notes.trim(),
    });
    setBusy(false);
    if (error) return void toast.error(translateError(error, lang));
    toast.success(t("groupCreated"));
    setName("");
    setYear("");
    setDays([]);
    setTime("");
    setNotes("");
    refresh();
  }

  return (
    <>
      <PageHeader title={t("groups")} />
      <Panel className="mb-8">
        <h2 className="mb-4 text-lg font-semibold">{t("groupCreateTitle")}</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            {t("groupName")}
            <input
              className="mt-1 w-full rounded-md border px-3 py-2"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("groupNamePlaceholder")}
            />
          </label>
          <label className="block text-sm">
            {t("groupYear")}
            <input
              className="mt-1 w-full rounded-md border px-3 py-2"
              value={year}
              onChange={(e) => setYear(e.target.value)}
              placeholder={t("groupYearPlaceholder")}
            />
          </label>
        </div>
        <fieldset className="mt-4">
          <legend className="text-sm font-medium">{t("groupDays")}</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {DAY_KEYS.map((key) => (
              <label
                key={key}
                className="flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm"
              >
                <input
                  type="checkbox"
                  checked={days.includes(key)}
                  onChange={() => toggleDay(key)}
                />
                {labels[key]}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            {t("groupTime")}
            <input
              className="mt-1 w-full rounded-md border px-3 py-2"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              placeholder={t("groupTimePlaceholder")}
            />
          </label>
          <label className="block text-sm">
            {t("groupNotes")}
            <input
              className="mt-1 w-full rounded-md border px-3 py-2"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t("groupNotesPlaceholder")}
            />
          </label>
        </div>
        <Button onClick={create} disabled={busy || name.trim() === ""} className="lift mt-5">
          {t("groupCreate")}
        </Button>
      </Panel>

      {(groups ?? []).length === 0 ? (
        <Empty>{t("groupNone")}</Empty>
      ) : (
        <div className="space-y-6">
          {(groups ?? []).map((g) => (
            <GroupCard key={g.group_id} group={g} labels={labels} onChanged={refresh} />
          ))}
        </div>
      )}
    </>
  );
}

function GroupCard({
  group,
  labels,
  onChanged,
}: {
  group: TeacherGroup;
  labels: Record<string, string>;
  onChanged: () => void;
}) {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(group.name);
  const [year, setYear] = useState(group.school_year);
  const [days, setDays] = useState<string[]>(group.days ?? []);
  const [time, setTime] = useState(group.time_text);
  const [notes, setNotes] = useState(group.notes);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const { data: roster } = useQuery({
    queryKey: ["group-roster", group.group_id],
    queryFn: async () =>
      ((await supabase.rpc("my_group_roster", { _group: group.group_id })).data ??
        []) as RosterRow[],
  });
  const refreshRoster = () => qc.invalidateQueries({ queryKey: ["group-roster", group.group_id] });
  const { pending, approved, rejected } = splitRoster(roster);

  async function save() {
    if (name.trim() === "") return;
    setBusy("save");
    const { error } = await supabase.rpc("update_teacher_group", {
      _group: group.group_id,
      _name: name.trim(),
      _year: year.trim(),
      _days: days,
      _time: time.trim(),
      _notes: notes.trim(),
    });
    setBusy(null);
    if (error) return void toast.error(translateError(error, lang));
    toast.success(t("groupUpdated"));
    setEditing(false);
    onChanged();
  }

  async function remove() {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setBusy("delete");
    const { error } = await supabase.rpc("delete_teacher_group", {
      _group: group.group_id,
    });
    setBusy(null);
    if (error) return void toast.error(translateError(error, lang));
    toast.success(t("groupDeleted"));
    onChanged();
  }

  async function decide(studentId: string, approve: boolean) {
    setBusy(studentId);
    const { error } = await supabase.rpc("decide_group_membership", {
      _group: group.group_id,
      _student: studentId,
      _approve: approve,
    });
    setBusy(null);
    if (error) return void toast.error(translateError(error, lang));
    const row = roster?.find((r) => r.student_id === studentId);
    toast.success(
      approve
        ? t("enrollmentApproved", { name: displayName(row ?? {}) })
        : t("enrollmentRejected", { name: displayName(row ?? {}) }),
    );
    refreshRoster();
    onChanged();
  }

  async function approveAll() {
    setBusy("all");
    const { data: count, error } = await supabase.rpc("approve_all_group_members", {
      _group: group.group_id,
    });
    setBusy(null);
    if (error) return void toast.error(translateError(error, lang));
    toast.success(t("groupApprovedAll", { count: String(count ?? pending.length) }));
    refreshRoster();
    onChanged();
  }

  const dayText = (group.days ?? []).map((d) => labels[d] ?? d).join("، ");

  return (
    <section className="rounded-lg border bg-card p-4 sm:p-5">
      {editing ? (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              {t("groupName")}
              <input
                className="mt-1 w-full rounded-md border px-3 py-2"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="block text-sm">
              {t("groupYear")}
              <input
                className="mt-1 w-full rounded-md border px-3 py-2"
                value={year}
                onChange={(e) => setYear(e.target.value)}
              />
            </label>
          </div>
          <fieldset>
            <legend className="text-sm font-medium">{t("groupDays")}</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {DAY_KEYS.map((key) => (
                <label
                  key={key}
                  className="flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={days.includes(key)}
                    onChange={() =>
                      setDays((cur) =>
                        cur.includes(key) ? cur.filter((d) => d !== key) : [...cur, key],
                      )
                    }
                  />
                  {labels[key]}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              {t("groupTime")}
              <input
                className="mt-1 w-full rounded-md border px-3 py-2"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </label>
            <label className="block text-sm">
              {t("groupNotes")}
              <input
                className="mt-1 w-full rounded-md border px-3 py-2"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </label>
          </div>
          <div className="flex gap-2">
            <Button onClick={save} disabled={busy === "save" || name.trim() === ""}>
              {t("groupSave")}
            </Button>
            <Button variant="outline" onClick={() => setEditing(false)}>
              {t("groupCancel")}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold">{group.name}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {group.school_year}
                {dayText ? ` — ${dayText}` : ""}
                {group.time_text ? ` — ${group.time_text}` : ""}
              </p>
              {group.notes ? (
                <p className="mt-1 text-sm text-muted-foreground">{group.notes}</p>
              ) : null}
              <p className="mt-2 text-sm">
                {t("groupCounts", {
                  approved: String(group.approved_count ?? 0),
                  pending: String(group.pending_count ?? 0),
                })}
              </p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                {t("groupEdit")}
              </Button>
              <Button size="sm" variant="outline" onClick={remove} disabled={busy === "delete"}>
                {confirmingDelete ? t("groupDeleteConfirm") : t("groupDelete")}
              </Button>
            </div>
          </div>
          <div className="mt-4 rounded-md border bg-muted/40 p-3">
            <p className="text-sm text-muted-foreground">{t("groupCode")}</p>
            <p
              dir="ltr"
              className="figures mt-1 text-2xl font-semibold tracking-[0.2em] text-primary"
            >
              {group.join_code}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">{t("groupCodeHint")}</p>
          </div>
        </>
      )}

      <div className="mt-6">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <h4 className="font-semibold">
            {t("groupPendingTitle")}
            {pending.length > 0 ? (
              <span className="ms-2 align-middle">
                <Pill t="warning">{String(pending.length)}</Pill>
              </span>
            ) : null}
          </h4>
          {pending.length > 0 ? (
            <Button size="sm" onClick={approveAll} disabled={busy === "all"}>
              <Check className="size-4" aria-hidden />
              {t("groupApproveAll", { count: String(pending.length) })}
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
                    {t("enrollmentDate")} {formatDate(s.requested_at, lang)}
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
      </div>

      <div className="mt-6">
        <h4 className="mb-3 font-semibold">{t("groupMembers")}</h4>
        {approved.length === 0 ? (
          <Empty>{t("noStudents")}</Empty>
        ) : (
          <ul className="divide-y rounded-lg border bg-card">
            {approved.map((s) => (
              <li key={s.student_id} className="flex items-center justify-between gap-3 p-4">
                <span className="font-medium">{displayName(s)}</span>
                <span className="text-sm text-muted-foreground">
                  {formatDate(s.requested_at, lang)}
                </span>
              </li>
            ))}
          </ul>
        )}
        {rejected.length > 0 ? (
          <div className="mt-4">
            <h5 className="mb-2 text-base font-semibold">{t("enrollmentRejectedTitle")}</h5>
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
          </div>
        ) : null}
      </div>
    </section>
  );
}

function StudentGroups() {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const { data: myGroups } = useQuery({
    queryKey: ["my-groups"],
    queryFn: async () => ((await supabase.rpc("my_groups")).data ?? []) as MyGroup[],
  });
  const { data: pending } = useQuery({
    queryKey: ["my-pending-groups"],
    queryFn: async () =>
      ((await supabase.rpc("my_pending_group_requests")).data ?? []) as PendingGroup[],
  });
  const labels = dayLabels(t as (key: string) => string);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["my-groups"] });
    qc.invalidateQueries({ queryKey: ["my-pending-groups"] });
  };

  async function join() {
    if (code.trim() === "") return;
    setBusy(true);
    const { error } = await supabase.rpc("join_group", { _code: code.trim() });
    setBusy(false);
    if (error) return void toast.error(translateError(error, lang));
    toast.success(t("groupJoinSent"));
    setCode("");
    refresh();
  }

  return (
    <>
      <PageHeader title={t("groups")} />
      <Panel className="mb-8">
        <h2 className="mb-4 text-lg font-semibold">{t("groupJoinTitle")}</h2>
        <label className="block text-sm">
          {t("groupJoinCode")}
          <input
            className="mt-1 w-full rounded-md border px-3 py-2"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={t("groupJoinCodePlaceholder")}
          />
        </label>
        <Button onClick={join} disabled={busy || code.trim() === ""} className="lift mt-4">
          <Users className="size-4" aria-hidden />
          {t("groupJoin")}
        </Button>
      </Panel>

      {(pending ?? []).length > 0 ? (
        <section className="mb-8">
          <h2 className="mb-3 text-lg font-semibold">{t("enrollmentRequestsTitle")}</h2>
          <ul className="divide-y rounded-lg border bg-card">
            {(pending ?? []).map((p) => (
              <li key={p.group_id} className="p-4">
                <p className="font-medium">{t("groupPendingWaiting", { name: p.group_name })}</p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {t("groupTeacher", { name: p.teacher_name || "—" })} — {t("enrollmentDate")}{" "}
                  {formatDate(p.requested_at, lang)}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <h2 className="mb-3 text-lg font-semibold">{t("groups")}</h2>
      {(myGroups ?? []).length === 0 ? (
        <Empty>{t("groupNoGroups")}</Empty>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {(myGroups ?? []).map((g) => (
            <div key={g.group_id} className="rounded-lg border bg-card p-4">
              <h3 className="font-semibold">{g.group_name}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {g.school_year}
                {(g.days ?? []).length > 0
                  ? ` — ${(g.days ?? []).map((d) => labels[d] ?? d).join("، ")}`
                  : ""}
                {g.time_text ? ` — ${g.time_text}` : ""}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                {t("groupTeacher", { name: g.teacher_name || "—" })}
              </p>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getMyProfileExtraD1, updateMyFullNameD1, updateMySubjectD1 } from "@/server/d1-profile";
import { useMe } from "@/lib/session";
import { useI18n, formatDate, translateError } from "@/lib/i18n";
import { PageHeader, Panel } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/_authenticated/profile")({
  head: () => ({
    meta: [
      { title: "Profile · Qemmini" },
      { name: "description", content: "View and edit your profile." },
    ],
  }),
  component: Profile,
});

function Profile() {
  const { t, lang } = useI18n();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? me?.fullName ?? "";
  const isTeacher = me?.role === "school_teacher" || me?.role === "tutor";

  // D1, own row only: created_at + teacher subjects_text (stored on
  // the profile only — deliberately NOT wired into any assistant
  // prompt). The server function reads only the session user's rows.
  const { data: extra } = useQuery({
    queryKey: ["my-profile-extra"],
    enabled: !!me,
    queryFn: async () => getMyProfileExtraD1({ data: {} }),
  });
  const createdAt = extra?.createdAt ?? null;
  const subjectRow = isTeacher ? (extra?.subjectsText ?? null) : null;
  const [subjectDraft, setSubjectDraft] = useState<string | null>(null);
  const subjectValue = subjectDraft ?? subjectRow ?? "";

  async function saveSubject(e: FormEvent) {
    e.preventDefault();
    if (!me) return;
    try {
      await updateMySubjectD1({ data: { subjectsText: subjectValue.trim() } });
    } catch (err) {
      return void toast.error(translateError(err, lang));
    }
    toast.success(t("profileSaved"));
    qc.invalidateQueries({ queryKey: ["my-profile-extra"] });
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || !me) return;
    try {
      await updateMyFullNameD1({ data: { fullName: trimmed } });
    } catch (err) {
      return void toast.error(translateError(err, lang));
    }
    toast.success(t("profileSaved"));
    qc.invalidateQueries({ queryKey: ["me"] });
  }

  return (
    <>
      <PageHeader title={t("profile")} />
      <Panel className="mb-8">
        <form onSubmit={save} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="profile-name">{t("fullName")}</Label>
            <Input
              id="profile-name"
              value={value}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={100}
            />
          </div>
          <Button type="submit" disabled={!value.trim() || value.trim() === me?.fullName}>
            {t("save")}
          </Button>
        </form>
      </Panel>
      {isTeacher && (
        <Panel className="mb-8">
          <form onSubmit={saveSubject} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="profile-subject">{t("profileSubject")}</Label>
              <Input
                id="profile-subject"
                value={subjectValue}
                onChange={(e) => setSubjectDraft(e.target.value)}
                placeholder={t("profileSubjectPlaceholder")}
                maxLength={100}
              />
            </div>
            <Button type="submit" disabled={subjectValue.trim() === (subjectRow ?? "").trim()}>
              {t("save")}
            </Button>
          </form>
        </Panel>
      )}
      <Panel>
        <dl className="space-y-3 text-sm">
          <div className="flex items-center justify-between gap-4">
            <dt className="text-muted-foreground">{t("email")}</dt>
            <dd dir="ltr">{me?.email ?? "—"}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-muted-foreground">{t("accountType")}</dt>
            <dd>{me ? t(me.role) : "—"}</dd>
          </div>
          {isTeacher && (
            <div className="flex items-center justify-between gap-4">
              <dt className="text-muted-foreground">{t("joinCode")}</dt>
              <dd dir="ltr" className="font-bold tracking-[0.3em]">
                {me?.joinCode ?? "—"}
              </dd>
            </div>
          )}
          <div className="flex items-center justify-between gap-4">
            <dt className="text-muted-foreground">{t("memberSince")}</dt>
            <dd>{createdAt ? formatDate(createdAt, lang) : "—"}</dd>
          </div>
        </dl>
      </Panel>
    </>
  );
}

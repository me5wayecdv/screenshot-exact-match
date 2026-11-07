import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { createLessonD1, listTutorLessonsD1 } from "@/server/d1-lessons";
import { useMe } from "@/lib/session";
import { useI18n, translateError } from "@/lib/i18n";
import { PageHeader, Panel, Empty } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataPager } from "@/components/data-pager";

export const Route = createFileRoute("/_authenticated/lessons")({
  head: () => ({ meta: [{ title: "Lessons · Qayyimni" }] }),
  component: Lessons,
});

function Lessons() {
  const { t, lang } = useI18n();
  const { data: me, isLoading } = useMe();
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const [page, setPage] = useState(0);

  const { data } = useQuery({
    queryKey: ["tutor-lessons", page],
    enabled: !!me,
    // D1, tutor-owned only: lessons + subjects + per-lesson counts.
    queryFn: async () => listTutorLessonsD1({ data: { page } }),
  });

  if (isLoading || !me) return <p className="text-muted-foreground">{t("loading")}</p>;
  if (me.role !== "tutor")
    return (
      <Panel>
        <Empty>{t("tutorOnly")}</Empty>
      </Panel>
    );

  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      await createLessonD1({
        data: {
          title: title.trim(),
          description: description.trim(),
          subjectId: subjectId || null,
        },
      });
    } catch (err) {
      return void toast.error(translateError(err, lang));
    }
    toast.success(t("created"));
    setTitle("");
    setDescription("");
    setSubjectId("");
    qc.invalidateQueries({ queryKey: ["tutor-lessons"] });
  }

  return (
    <>
      <PageHeader title={t("lessons")} />
      <Panel className="mb-8">
        <form onSubmit={create} className="grid gap-3 md:grid-cols-2">
          <div>
            <label htmlFor="lesson-title" className="text-sm font-medium">
              {t("lessonTitle")}
            </label>
            <Input
              id="lesson-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="mt-1.5"
              required
            />
          </div>
          <div>
            <label htmlFor="lesson-subject" className="text-sm font-medium">
              {t("subject")}
            </label>
            <select
              id="lesson-subject"
              value={subjectId}
              onChange={(e) => setSubjectId(e.target.value)}
              className="mt-1.5 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">{t("noSubject")}</option>
              {data?.subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="md:col-span-2">
            <label htmlFor="lesson-desc" className="text-sm font-medium">
              {t("lessonDescription")}
            </label>
            <Input
              id="lesson-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="mt-1.5"
            />
          </div>
          <div>
            <Button type="submit">{t("createLesson")}</Button>
          </div>
        </form>
      </Panel>
      {data && data.lessons.length === 0 ? (
        <Empty>{t("noLessons")}</Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {data?.lessons.map((l) => (
            <Panel key={l.id}>
              <h3 className="font-semibold">{l.title}</h3>
              {l.description ? (
                <p className="mt-1 text-sm text-muted-foreground">{l.description}</p>
              ) : null}
              <p className="mt-2 text-sm text-muted-foreground">
                {t("joinCodeLabel")}: <span dir="ltr">{l.join_code}</span> · {t("summaryStudents")}:{" "}
                {data?.enrollments.find((x) => x.lesson_id === l.id)?.student_count ?? 0}
              </p>
            </Panel>
          ))}
        </div>
      )}
      {data && (page > 0 || data.hasNext) ? (
        <DataPager
          page={page}
          hasPrevious={page > 0}
          hasNext={data.hasNext}
          onPrevious={() => setPage((current) => Math.max(0, current - 1))}
          onNext={() => setPage((current) => current + 1)}
        />
      ) : null}
    </>
  );
}

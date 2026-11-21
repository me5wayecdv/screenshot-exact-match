import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  confirmHwReferenceD1,
  getHwReferenceImageD1,
  listHwReferencesD1,
} from "@/server/d1-handwritten";
import type { PaperReference } from "@/server/paper-reference";
import { ocrHandwrittenImage } from "@/server/handwritten";
import { useI18n, translateError } from "@/lib/i18n";
import { Panel } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function PaperReferencePanel({
  teacherId,
  reference,
  onChange,
  compressImage,
  locked = false,
}: {
  teacherId: string;
  locked?: boolean;
  reference: PaperReference | null;
  onChange: (reference: PaperReference | null) => void;
  compressImage: (file: File) => Promise<{ dataUrl: string }>;
}) {
  const { lang } = useI18n();
  const a = (ar: string, en: string) => (lang === "ar" ? ar : en);
  const queryClient = useQueryClient();
  const { data: references, isError } = useQuery({
    queryKey: ["hw-references", teacherId],
    enabled: !!teacherId,
    queryFn: () => listHwReferencesD1({ data: {} }),
  });
  const [image, setImage] = useState("");
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"written" | "bubble">("written");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function chooseFile(file?: File) {
    if (!file) return;
    onChange(null);
    setText("");
    setImage("");
    setError("");
    setBusy(true);
    try {
      if (!file.type.startsWith("image/"))
        throw new Error(a("ارفع صورة واضحة للنموذج", "Upload a clear reference image"));
      setImage((await compressImage(file)).dataUrl);
      setTitle(file.name.replace(/\.[^.]+$/, "").slice(0, 200));
    } catch (err) {
      setError(translateError(err, lang));
    } finally {
      setBusy(false);
    }
  }
  async function readReference() {
    setBusy(true);
    setError("");
    try {
      const result = await ocrHandwrittenImage({
        data: { imageDataUrl: image, paperRole: "reference", paperKind: kind },
      });
      if (!result.ok) throw new Error(result.message);
      setText(result.text);
    } catch (err) {
      setError(translateError(err, lang));
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    setBusy(true);
    setError("");
    try {
      const result = await confirmHwReferenceD1({
        data: { title, kind, dataUrl: image, confirmedText: text },
      });
      await queryClient.invalidateQueries({ queryKey: ["hw-references", teacherId] });
      onChange(result);
      setImage("");
      setText("");
      toast.success(
        a("تم اعتماد نموذج الإجابة كمرجع للتصحيح", "Model answer confirmed as grading reference"),
      );
    } catch (err) {
      setError(translateError(err, lang));
    } finally {
      setBusy(false);
    }
  }
  async function showReferenceImage() {
    if (!reference) return;
    setBusy(true);
    setError("");
    try {
      const result = await getHwReferenceImageD1({ data: { referenceId: reference.id } });
      setImage(result);
    } catch (err) {
      setError(translateError(err, lang));
    } finally {
      setBusy(false);
    }
  }
  return (
    <fieldset disabled={locked} className="min-w-0">
      <Panel className="space-y-4 border-primary/40">
        <h2 className="font-semibold">
          {a("١. نموذج الإجابة المرجعي", "1. Model answer reference")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {a(
            "ارفع نموذج المدرس أولا، راجع الإجابات المستخرجة واعتمده. النموذج مرجع للذكاء الاصطناعي وليس ورقة طالب. بعدها ارفع أوراق الطلبة في الخطوة التالية.",
            "Upload the teacher's model answer first, review the extracted answers and confirm. This is the AI grading reference, not a student submission. Then upload student papers below.",
          )}
        </p>
        <Label className="block" htmlFor="hw-reference-existing">
          {a("مرجع معتمد سابقا", "Previously confirmed reference")}
        </Label>
        <select
          id="hw-reference-existing"
          className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          value={reference?.id ?? ""}
          disabled={busy}
          onChange={(e) => {
            setImage("");
            setText("");
            setError("");
            onChange(references?.find((r) => r.id === e.target.value) ?? null);
          }}
        >
          <option value="">
            {a(
              "اختر مرجعا أو ارفع نموذجا جديدا",
              "Choose a reference or upload a new model answer",
            )}
          </option>
          {(references ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {r.title} ·{" "}
              {r.kind === "bubble"
                ? a("بابل شيت", "Bubble sheet")
                : a("إجابات مكتوبة", "Written answers")}
            </option>
          ))}
        </select>
        {isError && (
          <p role="alert" className="text-sm text-destructive">
            {a(
              "تعذر تحميل المراجع. حاول تحديث الصفحة.",
              "Could not load references. Try refreshing the page.",
            )}
          </p>
        )}
        {reference ? (
          <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
            <p className="font-medium">
              {a("تم اعتماد المرجع: ", "Confirmed reference: ")}
              {reference.title}
            </p>
            <p className="text-sm">
              {a(
                "كل اقتراح درجة جديد في هذه الصفحة سيستخدم هذا المرجع. لتعديله ارفع نسخة جديدة واعتمدها.",
                "Every new grade preview on this page will use this reference. To change it, upload and confirm a new version.",
              )}
            </p>
            <details>
              <summary className="cursor-pointer text-sm">
                {a("عرض الإجابات المعتمدة", "View confirmed answers")}
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap font-sans text-sm">
                {reference.confirmed_text}
              </pre>
            </details>
            <Button type="button" variant="outline" disabled={busy} onClick={showReferenceImage}>
              {a("عرض صورة المرجع", "View reference image")}
            </Button>
            {image && (
              <img
                src={image}
                alt={a(
                  "صورة نموذج الإجابة المرجعي المعتمد",
                  "Confirmed model answer reference image",
                )}
                className="max-h-80 max-w-full rounded-lg border object-contain"
              />
            )}
            <Button
              className="h-auto min-h-10 max-w-full whitespace-normal text-center"
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                onChange(null);
                setImage("");
                setText("");
              }}
            >
              {a("اختيار أو رفع مرجع آخر", "Choose or upload another reference")}
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label className="block" htmlFor="hw-reference-kind">
                  {a("نوع النموذج", "Reference type")}
                </Label>
                <select
                  id="hw-reference-kind"
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  value={kind}
                  disabled={busy}
                  onChange={(e) => {
                    setKind(e.target.value as "written" | "bubble");
                    setText("");
                  }}
                >
                  <option value="written">
                    {a("إجابات نموذجية مكتوبة", "Written model answers")}
                  </option>
                  <option value="bubble">
                    {a(
                      "بابل شيت مظلل بالإجابات الصحيحة",
                      "Bubble sheet marked with correct answers",
                    )}
                  </option>
                </select>
              </div>
              <div className="space-y-2">
                <Label className="block" htmlFor="hw-reference-file">
                  {a(
                    "صورة المرجع فقط، ليست ورقة طالب",
                    "Reference image only, not a student paper",
                  )}
                </Label>
                <Input
                  id="hw-reference-file"
                  type="file"
                  accept="image/*"
                  disabled={busy}
                  onChange={(e) => {
                    void chooseFile(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
              </div>
            </div>
            {image && (
              <>
                <img
                  src={image}
                  alt={a("نموذج الإجابة قبل الاعتماد", "Model answer before confirmation")}
                  className="max-h-80 max-w-full rounded-lg border object-contain"
                />
                <Label className="block" htmlFor="hw-reference-title">
                  {a("اسم المرجع", "Reference name")}
                </Label>
                <Input
                  id="hw-reference-title"
                  maxLength={200}
                  value={title}
                  disabled={busy}
                  onChange={(e) => setTitle(e.target.value)}
                />
                <Button type="button" variant="outline" disabled={busy} onClick={readReference}>
                  {busy
                    ? a("جار المعالجة...", "Working...")
                    : a("قراءة إجابات النموذج بالذكاء الاصطناعي", "Read model answers with AI")}
                </Button>
                <Label className="block" htmlFor="hw-reference-text">
                  {a(
                    "راجع الإجابات وصححها قبل الاعتماد",
                    "Review and correct answers before confirming",
                  )}
                </Label>
                <Textarea
                  id="hw-reference-text"
                  rows={8}
                  maxLength={8000}
                  value={text}
                  disabled={busy}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={
                    kind === "bubble"
                      ? a(
                          "س١: ب\nس٢: ج\nاكتب [غير واضح] لأي تظليل غير مؤكد",
                          "Q1: B\nQ2: C\nUse [unclear] for uncertain marks",
                        )
                      : a(
                          "الإجابات النموذجية مرتبة بأرقام الأسئلة",
                          "Model answers with question numbers",
                        )
                  }
                />
                <p className="text-xs text-muted-foreground">
                  {a(
                    "القراءة الآلية قد تخطئ، خصوصا في التظليل. تأكد من أرقام الأسئلة والاختيارات. يمكنك إدخال الإجابات يدويا إذا تعذرت القراءة. لن يُستخدم النموذج إلا بعد اعتماده.",
                    "AI reading can make mistakes, especially with shaded bubbles. Check question numbers and choices. You can enter answers manually if reading fails. The model answer is not used until confirmed.",
                  )}
                </p>
                <Button
                  className="h-auto min-h-10 max-w-full whitespace-normal text-center"
                  type="button"
                  disabled={busy || !title.trim() || !text.trim()}
                  onClick={confirm}
                >
                  {a(
                    "اعتماد الصورة والإجابات كمرجع للتصحيح",
                    "Confirm image and answers as grading reference",
                  )}
                </Button>
              </>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">
            {error}
          </p>
        )}
      </Panel>
    </fieldset>
  );
}

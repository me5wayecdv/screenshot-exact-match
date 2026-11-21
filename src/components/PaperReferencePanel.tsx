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
  const [reviewing, setReviewing] = useState(false);

  async function chooseFile(file?: File) {
    if (!file) return;
    onChange(null);
    setText("");
    setReviewing(false);
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
      setReviewing(true);
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
        a("حفظنا النموذج. دلوقتي ارفع ورقة الطالب.", "Model answer confirmed as grading reference"),
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
        <h2 className="font-semibold">{a("١. ارفع نموذج الإجابة", "1. Upload model answers")}</h2>
        <p className="text-sm text-muted-foreground">
          {a(
            "ارفع ورقة فيها الإجابات الصح. هنقرأها، وتراجعها، وبعدها نصحح عليها ورق الطلبة.",
            "Upload a page with the correct answers. Read it, check the answers, then grade student papers against it.",
          )}
        </p>
        {(references?.length ?? 0) > 0 && (
          <details>
            <summary className="cursor-pointer text-sm">
              {a("عندك نموذج محفوظ؟", "Use a saved model answer")}
            </summary>
            <Label className="mt-3 block" htmlFor="hw-reference-existing">
              {a("استخدم نموذج حفظته قبل كده", "Previously confirmed reference")}
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
                {a("نموذج جديد", "Choose a reference or upload a new model answer")}
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
          </details>
        )}
        {isError && (
          <p role="alert" className="text-sm text-destructive">
            {a(
              "مش قادرين نعرض النماذج المحفوظة. جرّب تحديث الصفحة.",
              "Could not load references. Try refreshing the page.",
            )}
          </p>
        )}
        {reference ? (
          <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
            <p className="font-medium">
              {a("نموذج الإجابة جاهز: ", "Confirmed reference: ")}
              {reference.title}
            </p>
            <p className="text-sm">
              {a(
                "هنصحح ورق الطلبة على إجابات النموذج ده. كمل للخطوة اللي تحت.",
                "Every new grade preview on this page will use this reference. To change it, upload and confirm a new version.",
              )}
            </p>
            <details>
              <summary className="cursor-pointer text-sm">
                {a("شوف الإجابات", "View confirmed answers")}
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap font-sans text-sm">
                {reference.confirmed_text}
              </pre>
            </details>
            <Button type="button" variant="outline" disabled={busy} onClick={showReferenceImage}>
              {a("شوف صورة النموذج", "View reference image")}
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
              {a("غيّر النموذج", "Choose or upload another reference")}
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label className="block" htmlFor="hw-reference-kind">
                  {a("شكل ورقة الإجابة", "Reference type")}
                </Label>
                <select
                  id="hw-reference-kind"
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  value={kind}
                  disabled={busy}
                  onChange={(e) => {
                    setKind(e.target.value as "written" | "bubble");
                    setText("");
                    setReviewing(false);
                  }}
                >
                  <option value="written">{a("إجابات مكتوبة", "Written model answers")}</option>
                  <option value="bubble">
                    {a("بابل شيت (اختيارات متظللة)", "Bubble sheet marked with correct answers")}
                  </option>
                </select>
              </div>
              <div className="space-y-2">
                <Label className="block" htmlFor="hw-reference-file">
                  {a("صورة نموذج الإجابة الصح", "Reference image only, not a student paper")}
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
                <Button type="button" variant="outline" disabled={busy} onClick={readReference}>
                  {busy
                    ? a("جار المعالجة...", "Working...")
                    : reviewing
                      ? a("اقرأ الصورة تاني", "Read image again")
                      : a("التالي: اقرأ إجابات النموذج", "Read model answers with AI")}
                </Button>
                {!reviewing && (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setReviewing(true)}
                  >
                    {a("أو اكتب الإجابات بنفسك", "Or enter answers yourself")}
                  </Button>
                )}
                {reviewing && (
                  <>
                    <Label className="block" htmlFor="hw-reference-title">
                      {a("اسم النموذج (علشان تلاقيه بعدين)", "Reference name")}
                    </Label>
                    <Input
                      id="hw-reference-title"
                      maxLength={200}
                      value={title}
                      disabled={busy}
                      onChange={(e) => setTitle(e.target.value)}
                    />
                    <Label className="block" htmlFor="hw-reference-text">
                      {a("٢. راجع الإجابات", "Review and correct answers before confirming")}
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
                        "قارن الكلام ده بالصورة. لو فيه إجابة أو رقم سؤال غلط، عدّله هنا. في البابل شيت اتأكد إن كل اختيار هو المتظلل فعلا.",
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
                        "الإجابات صح، ابدأ تصحيح الطلبة",
                        "Confirm image and answers as grading reference",
                      )}
                    </Button>
                  </>
                )}
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

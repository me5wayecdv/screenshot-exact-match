import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, BadgeCheck, PencilLine, Sparkles } from "lucide-react";
import { Brand } from "@/components/Brand";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "قيمني — مساعد الذكاء الاصطناعي للمدرس" },
      {
        name: "description",
        content: "قيمني يقترح تصحيح الامتحانات بالذكاء الاصطناعي، والمدرس يعتمد قبل ما أي درجة توصل للطالب.",
      },
      { property: "og:title", content: "قيمني — مساعد الذكاء الاصطناعي للمدرس" },
      { property: "og:description", content: "الذكاء الاصطناعي يقترح التصحيح، وإنت تعتمد." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Landing,
});

const INK = "#eef2f8";
const PINE = "#ff6b4a";
const PINE_DARK = "#e04a2a";
const PAPER = "#0d1420";
const TINT = "#1b2436";
const LINE = "#26324a";
const MUTED = "#93a2b8";
const PANEL = "#141e30";
const CARD_BG = "#ffffff";
const CARD_SOFT = "#f7f6fb";
const CARD_INK = "#1e1b34";
const CARD_MUTED = "#5b5870";
const CARD_LINE = "#e4e2f0";
const CARD_TINT = "#eeedfb";
const DARKLOGO = true;

function Landing() {
  return (
    <div style={{ background: PAPER, color: INK }}>
      {/* Header */}
      <header className="border-b" style={{ borderColor: LINE, background: PAPER }}>
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3.5 md:px-8">
          <Link to="/" aria-label="قيمني" className="rounded-sm" style={{ color: PINE }}>
            <Brand onDark={DARKLOGO} />
          </Link>
          <div className="flex items-center gap-2.5">
            <Link
              to="/auth"
              className="hidden rounded-lg px-4 py-2 text-sm font-semibold sm:inline-flex"
              style={{ color: PINE }}
            >
              تسجيل الدخول
            </Link>
            <Link
              to="/auth"
              className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
              style={{ background: PINE }}
            >
              إنشاء حساب
              <ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />
            </Link>
          </div>
        </div>
      </header>

      <main>
        <section className="mx-auto grid w-full max-w-6xl items-center gap-10 px-5 py-12 md:grid-cols-[1.05fr_0.95fr] md:px-8 md:py-16">
          <div>
            <p
              className="inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[0.8rem] font-semibold"
              style={{ borderColor: LINE, background: PANEL, color: PINE }}
            >
              <Sparkles className="size-3.5" aria-hidden />
              مساعد الذكاء الاصطناعي للمدرس
            </p>
            <h1
              className="mt-5 max-w-xl font-display text-[2rem] font-bold leading-[1.35] md:text-[2.75rem] md:leading-[1.3]"
              style={{ color: INK }}
            >
              الذكاء الاصطناعي يقترح التصحيح، <span style={{ color: PINE }}>وإنت تعتمد.</span>
            </h1>
            <p className="mt-5 max-w-md text-[1rem] leading-8" style={{ color: MUTED }}>
              ارفع الامتحان أو ورقة الإجابة، وراجع الدرجات المقترحة قبل ما توصل للطالب.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                to="/auth"
                className="inline-flex h-12 items-center gap-2 rounded-xl px-6 text-[0.95rem] font-bold text-white transition-opacity hover:opacity-90"
                style={{ background: PINE }}
              >
                ابدأ دلوقتي
                <ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />
              </Link>
              <span className="text-[0.85rem]" style={{ color: MUTED }}>
                النتيجة متتنشرش غير بموافقتك
              </span>
            </div>
          </div>

          {/* Product mock: AI suggestion -> teacher approval */}
          <div className="relative">
            <div
              className="rounded-2xl border p-5 shadow-[0_18px_50px_-24px_rgba(49,46,129,0.35)] md:p-6"
              style={{ background: CARD_BG, borderColor: CARD_LINE }}
            >
              <div className="flex items-center justify-between">
                <p className="text-[0.8rem] font-semibold" style={{ color: CARD_MUTED }}>
                  اقتراح تصحيح · السؤال ٣
                </p>
                <span
                  className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[0.7rem] font-bold"
                  style={{ background: CARD_TINT, color: PINE }}
                >
                  <Sparkles className="size-3" aria-hidden />
                  اقتراح AI
                </span>
              </div>
              <div
                className="mt-4 rounded-xl border p-4 text-[0.85rem] leading-7"
                style={{ borderColor: CARD_LINE, background: CARD_SOFT, color: CARD_INK }}
              >
                «تتبخر مياه البحر بفعل حرارة الشمس، وتتكاثف مرة أخرى على هيئة أمطار…»
              </div>
              <div className="mt-4 flex items-center justify-between">
                <div>
                  <p className="text-[0.72rem] font-semibold" style={{ color: CARD_MUTED }}>
                    الدرجة المقترحة
                  </p>
                  <p className="font-display text-2xl font-bold" style={{ color: PINE }}>
                    <span>٤ من ٥</span>
                  </p>
                </div>
                <p className="max-w-[55%] text-[0.75rem] leading-5" style={{ color: CARD_MUTED }}>
                  الدليل: ذكر التبخر والتكاثف، لكن لم يشرح دورة الماء كاملة.
                </p>
              </div>
              <div className="mt-5 flex gap-2.5">
                <button
                  type="button"
                  className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl text-[0.9rem] font-bold text-white"
                  style={{ background: PINE }}
                >
                  <BadgeCheck className="size-4" aria-hidden />
                  اعتماد الدرجة
                </button>
                <button
                  type="button"
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border px-4 text-[0.9rem] font-bold"
                  style={{ borderColor: CARD_LINE, color: PINE }}
                >
                  <PencilLine className="size-4" aria-hidden />
                  تعديل
                </button>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Slim capability strip */}
      <section className="border-t" style={{ borderColor: LINE, background: PANEL }}>
        <div
          className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-8 gap-y-2 px-5 py-4 text-[0.85rem] font-semibold md:px-8"
          style={{ color: MUTED }}
        >
          <span>امتحان من ملف PDF</span>
          <span aria-hidden style={{ color: LINE }}>
            •
          </span>
          <span>تصحيح أوراق PDF وWord</span>
          <span aria-hidden style={{ color: LINE }}>
            •
          </span>
          <span>امتحانات بمواعيد</span>
          <span aria-hidden style={{ color: LINE }}>
            •
          </span>
          <span>ربط الطلاب بكود</span>
        </div>
      </section>

      <footer className="border-t" style={{ borderColor: LINE }}>
        <div
          className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-5 text-[0.8rem] md:px-8"
          style={{ color: MUTED }}
        >
          <span style={{ color: PINE }}>
            <Brand onDark={DARKLOGO} />
          </span>
          <div className="flex items-center gap-5">
            <Link to="/terms" className="hover:opacity-70">
              الشروط
            </Link>
            <Link to="/privacy" className="hover:opacity-70">
              الخصوصية
            </Link>
            <span>© ٢٠٢٦ قيمني</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

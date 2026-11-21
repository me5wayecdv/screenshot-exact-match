import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  BadgeCheck,
  CalendarClock,
  Eye,
  FileText,
  KeyRound,
  ListChecks,
  PencilLine,
  ScanLine,
  Sparkles,
} from "lucide-react";
import { Brand } from "@/components/Brand";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "قيمني — مساعد الذكاء الاصطناعي للمدرس" },
      {
        name: "description",
        content:
          "قيمني يقترح تصحيح الامتحانات بالذكاء الاصطناعي، والمدرس يعتمد قبل ما أي درجة توصل للطالب.",
      },
      { property: "og:title", content: "قيمني — مساعد الذكاء الاصطناعي للمدرس" },
      { property: "og:description", content: "مساعدك الذكي في التدريس" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Landing,
});

const INK = "#eef2f8";
const PINE = "#ff4d2e";
const PINE_DARK = "#d63a16";
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
// Light body palette (design pass: dark hero, warm light sections)
const CREAM = "#f7f4ee";
const CREAM_ALT = "#efe9de";
const L_INK = "#14213d";
const L_MUTED = "#5b6070";
const L_LINE = "#e6e0d3";
const L_PINE = "#b83010";
const L_TINT = "#ffdcd5";

const FEATURES = [
  {
    icon: FileText,
    title: "امتحان من ملف",
    body: "حول ملف PDF أو Word أو صورة إلى امتحان جاهز من غير إعادة كتابة.",
  },
  {
    icon: ScanLine,
    title: "تصحيح الأوراق",
    body: "ارفع أوراق الطلاب، والمساعد يقترح الدرجة مع الدليل من إجابة الطالب.",
  },
  {
    icon: ListChecks,
    title: "أسئلة متنوعة",
    body: "اختيار من متعدد، صح وخطأ، قصيرة ومقالية، بمفاتيح إجابة ومعايير تصحيح.",
  },
  {
    icon: KeyRound,
    title: "ربط الطلاب بكود",
    body: "شارك كود الانضمام مع طلابك، وراجع طلباتهم في مكان واحد.",
  },
  {
    icon: CalendarClock,
    title: "امتحانات بمواعيد",
    body: "حدد موعد نهائي لكل امتحان، وتابع التسليمات أول بأول.",
  },
  {
    icon: Eye,
    title: "نتائج واضحة للطالب",
    body: "الدرجة والملاحظات تظهر للطالب بعد اعتمادك فقط.",
  },
];

function Landing() {
  return (
    <div
      className="relative flex min-h-screen flex-col"
      style={{ background: CREAM, color: L_INK }}
    >
      {/* Header */}
      <header className="absolute inset-x-0 top-0 z-10">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-2 px-4 py-3.5 md:px-8">
          <Link to="/" aria-label="قيمني" className="rounded-sm" style={{ color: PINE }}>
            <Brand onDark={DARKLOGO} className="[&>span]:hidden min-[360px]:[&>span]:inline" />
          </Link>
          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2.5">
            <Link
              to="/auth"
              search={{}}
              className="inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-lg px-2 text-xs font-bold text-white transition-opacity hover:opacity-90 sm:px-4 sm:text-sm"
              style={{ background: PINE }}
            >
              تسجيل الدخول
            </Link>
            <Link
              to="/auth"
              search={{ mode: "signup" }}
              className="inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-lg border px-2 text-xs font-semibold transition-opacity hover:opacity-90 sm:px-4 sm:text-sm"
              style={{ borderColor: LINE, color: INK }}
            >
              إنشاء حساب
            </Link>
          </div>
        </div>
      </header>

      <main>
        <div
          style={{
            background: `radial-gradient(circle at 12% 8%, rgba(255,107,74,0.2), transparent 34%), radial-gradient(circle at 92% 30%, rgba(90,140,255,0.18), transparent 36%), radial-gradient(rgba(255,255,255,0.07) 1.2px, transparent 1.3px), ${PAPER}`,
            backgroundSize: "auto, auto, 26px 26px, auto",
            color: INK,
          }}
          className="rounded-b-[1.75rem] pt-16 md:rounded-b-[2.5rem]"
        >
          <section className="mx-auto grid w-full max-w-6xl items-center gap-8 px-5 py-9 md:gap-10 md:grid-cols-[1.05fr_0.95fr] md:px-8 md:py-16">
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
                مساعدك الذكي <span style={{ color: PINE }}>في التدريس</span>
              </h1>
              <p className="mt-5 max-w-md text-[1rem] leading-8" style={{ color: MUTED }}>
                ارفع الامتحان أو ورقة الإجابة، وراجع الدرجات المقترحة قبل ما توصل للطالب.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Link
                  to="/auth"
                  search={{ mode: "signup" }}
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
        </div>

        {/* Features */}
        <section style={{ background: CREAM }}>
          <div className="mx-auto max-w-6xl px-5 py-10 md:px-8 md:py-14">
            <p className="text-[0.8rem] font-bold" style={{ color: L_PINE }}>
              المميزات
            </p>
            <h2
              className="mt-3 font-display text-2xl font-bold leading-snug md:text-3xl"
              style={{ color: L_INK }}
            >
              كل خطوات التقييم، من الملف للدرجة المعتمدة
            </h2>
            <div className="mt-7 grid gap-3 sm:grid-cols-2 md:mt-8 md:gap-4 lg:grid-cols-3">
              {FEATURES.map(({ icon: Icon, title, body }) => (
                <div
                  key={title}
                  className="rounded-2xl border p-4 md:p-5"
                  style={{ borderColor: L_LINE, background: "#ffffff" }}
                >
                  <span
                    className="grid size-10 place-items-center rounded-lg"
                    style={{ background: L_TINT, color: L_PINE }}
                  >
                    <Icon className="size-5" aria-hidden />
                  </span>
                  <h3 className="mt-4 text-[1rem] font-bold" style={{ color: L_INK }}>
                    {title}
                  </h3>
                  <p className="mt-1.5 text-[0.85rem] leading-6" style={{ color: L_MUTED }}>
                    {body}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="how-it-works" style={{ background: CREAM }}>
          <div className="mx-auto max-w-6xl px-5 py-10 md:px-8 md:py-14">
            <p className="text-[0.8rem] font-bold" style={{ color: L_PINE }}>
              من البداية للنتيجة
            </p>
            <h2
              className="mt-3 font-display text-2xl font-bold md:text-3xl"
              style={{ color: L_INK }}
            >
              ابدأ بامتحانك. وسيب آخر قرار ليك.
            </h2>
            <div className="mt-8 grid gap-7 md:grid-cols-3 md:gap-8">
              {[
                {
                  n: "٠١",
                  title: "جهز الامتحان",
                  body: "ارفع ملف الدرس أو اكتب الأسئلة، وراجعها قبل النشر.",
                },
                {
                  n: "٠٢",
                  title: "شارك مع طلابك",
                  body: "ابعت كود الانضمام، وحدد موعد الامتحان وتابع التسليمات.",
                },
                {
                  n: "٠٣",
                  title: "راجع واعتمد",
                  body: "راجع الدرجة المقترحة والدليل، وعدل قبل ما تنشر النتيجة.",
                },
              ].map(({ n, title, body }) => (
                <div
                  key={n}
                  className="rounded-2xl border border-t-[3px] p-5"
                  style={{ borderColor: L_LINE, borderTopColor: PINE, background: "#ffffff" }}
                >
                  <span className="font-display text-3xl font-bold" style={{ color: L_PINE }}>
                    {n}
                  </span>
                  <h3 className="mt-4 font-bold" style={{ color: L_INK }}>
                    {title}
                  </h3>
                  <p className="mt-2 max-w-sm text-sm leading-7" style={{ color: L_MUTED }}>
                    {body}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="questions" style={{ background: CREAM_ALT }}>
          <div className="mx-auto grid max-w-6xl gap-7 px-5 py-10 md:grid-cols-[0.8fr_1.2fr] md:gap-16 md:px-8 md:py-14">
            <div>
              <p className="text-[0.8rem] font-bold" style={{ color: L_PINE }}>
                قبل ما تبدأ
              </p>
              <h2
                className="mt-3 font-display text-2xl font-bold md:text-3xl"
                style={{ color: L_INK }}
              >
                أسئلة سريعة
              </h2>
              <p className="mt-4 max-w-xs text-sm leading-7" style={{ color: L_MUTED }}>
                المساعد يقترح. وإنت تراجع وتقرر.
              </p>
            </div>
            <div className="flex flex-col gap-3">
              {[
                {
                  q: "الدرجة بتوصل للطالب على طول؟",
                  a: "لأ. الدرجة والملاحظات بتظهر بعد ما تراجعها وتعتمد نشرها.",
                },
                {
                  q: "أقدر أعدل اقتراح التصحيح؟",
                  a: "أيوه. تقدر تعدل الدرجة والملاحظات قبل الاعتماد.",
                },
                {
                  q: "أبدأ من ورقة ولا لازم أكتب كل حاجة؟",
                  a: "تقدر ترفع PDF أو Word أو صورة، أو تكتب الأسئلة بنفسك.",
                },
              ].map(({ q, a }) => (
                <div
                  key={q}
                  className="rounded-2xl border p-5"
                  style={{ borderColor: L_LINE, background: "#ffffff" }}
                >
                  <h3 className="text-[0.95rem] font-bold" style={{ color: L_INK }}>
                    {q}
                  </h3>
                  <p className="mt-2 text-sm leading-7" style={{ color: L_MUTED }}>
                    {a}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section style={{ background: CREAM }}>
          <div className="mx-auto max-w-6xl px-5 py-10 md:px-8 md:py-14">
            <div
              className="flex flex-col items-start justify-between gap-6 rounded-3xl p-7 md:flex-row md:items-center md:p-12"
              style={{ background: PAPER, color: INK }}
            >
              <div>
                <h2 className="font-display text-2xl font-bold md:text-3xl">
                  جاهز تبدأ أول امتحان؟
                </h2>
                <p className="mt-3 text-sm leading-7" style={{ color: MUTED }}>
                  من تجهيز الأسئلة لمراجعة النتيجة، في مكان واحد.
                </p>
              </div>
              <Link
                to="/auth"
                search={{ mode: "signup" }}
                className="inline-flex h-12 shrink-0 items-center gap-3 rounded-xl px-6 text-sm font-bold text-white hover:opacity-90"
                style={{ background: PINE }}
              >
                إنشاء حساب
                <ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer style={{ background: PAPER }}>
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

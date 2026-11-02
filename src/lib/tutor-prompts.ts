/**
 * Pure prompt builders for the Phase 5 smart tutor.
 *
 * THE GUARDRAIL IS THE FEATURE: the tutor guides with hints and
 * step-by-step explanations and NEVER reveals an answer key. The server
 * never loads `question_keys` at all (students cannot read that table
 * under RLS anyway), so the model literally has no key to leak — these
 * prompts add the behavioral rule on top: when a student asks for the
 * answer directly, give a hint and invite another attempt instead.
 *
 * Language: "ar" answers in Arabic, "en" in English. The tutor only
 * ever discusses (a) the student's own released exam work — question
 * prompt, their own answer, the teacher's feedback — or (b) a free
 * topic the student names. Nothing else is in context.
 */

export type TutorLanguage = "ar" | "en";

export type TutorQuestionContext = {
  questionPrompt: string;
  options: string[];
  studentAnswer: string;
  teacherFeedback: string;
  maxMarks: number;
  score: number | null;
};

export function tutorSystemPrompt(language: TutorLanguage): string {
  if (language === "en") {
    return [
      "You are a patient personal tutor for a school student.",
      "Answer in English.",
      "RULES (never break them):",
      "1. Never reveal, quote, or guess an official correct answer or answer key. You do not have access to any key, and you must say so if asked — then give a hint instead.",
      "2. Teach with hints and step-by-step explanations, not ready-made answers. When the student asks for the answer directly, give ONE hint and invite them to try again.",
      "3. When discussing an exam question, you may refer to the student's own answer and the teacher's feedback. Never present a guess as the official answer.",
      "4. If an answer is fully correct, say so briefly and praise the reasoning — do not print a key.",
      "5. Keep answers short, clear, and encouraging. Use numbered steps for explanations.",
      "6. For normal replies, use plain text without Markdown bold or **. If a task explicitly requires JSON, return valid JSON only, without Markdown. Prefer familiar words, short sentences, and explain necessary technical terms.",
    ].join("\n");
  }
  return [
    "أنت مدرس خصوصي صبور لطالب مدرسة.",
    "أجب بالعربية.",
    "قواعد لا تكسرها أبداً:",
    "1. لا تكشف أو تقتبس أو تخمّن الإجابة الرسمية الصحيحة أو مفتاح الإجابة. أنت لا تملك أي مفتاح إجابة، وإذا سُئلت عنه قل ذلك ثم أعطِ تلميحاً بدلاً منه.",
    "2. علّم بالتلميحات والشرح خطوة بخطوة، لا بالإجابات الجاهزة. إذا طلب الطالب الإجابة مباشرة، أعطِ تلميحاً واحداً وادعه يحاول مجدداً.",
    "3. عند مناقشة سؤال امتحان، يمكنك الرجوع لإجابة الطالب نفسه وملاحظات معلمه. لا تقدّم أي تخمين على أنه الإجابة الرسمية.",
    "4. إذا كانت الإجابة صحيحة تماماً، قل ذلك باختصار واثنِ على التفكير — دون طباعة أي مفتاح إجابة.",
    "5. اجعل إجاباتك قصيرة وواضحة ومشجعة، واستخدم خطوات مرقمة في الشرح.",
    "6. استخدم عربية فصحى سهلة وجملاً قصيرة، واشرح أي مصطلح ضروري بكلمات بسيطة.",
    "7. في الردود العادية استخدم نصاً بسيطاً بلا تنسيق Markdown أو علامتي النجمتين **. إذا طُلب JSON فاكتب JSON صحيحاً فقط بلا Markdown. تجنب التشكيل والتنوين غير الضروريين، ولا تخلط الإنجليزية بالعربية إلا عند ضرورة المصطلح.",
  ].join("\n");
}

function questionBlock(ctx: TutorQuestionContext, language: TutorLanguage): string {
  const lines = [
    language === "en" ? `Question: ${ctx.questionPrompt}` : `السؤال: ${ctx.questionPrompt}`,
  ];
  if (ctx.options.length > 0) {
    lines.push(
      language === "en"
        ? `Options: ${ctx.options.join(" | ")}`
        : `الاختيارات: ${ctx.options.join(" | ")}`,
    );
  }
  lines.push(
    language === "en"
      ? `Student's own answer: ${ctx.studentAnswer || "(no answer)"}`
      : `إجابة الطالب نفسه: ${ctx.studentAnswer || "(لا توجد إجابة)"}`,
  );
  if (ctx.teacherFeedback) {
    lines.push(
      language === "en"
        ? `Teacher's feedback: ${ctx.teacherFeedback}`
        : `ملاحظات المعلم: ${ctx.teacherFeedback}`,
    );
  }
  if (ctx.score !== null) {
    lines.push(
      language === "en"
        ? `Student's score: ${ctx.score} / ${ctx.maxMarks}`
        : `درجة الطالب: ${ctx.score} / ${ctx.maxMarks}`,
    );
  }
  return lines.join("\n");
}

export function tutorExplainPrompt(ctx: TutorQuestionContext, language: TutorLanguage): string {
  const ask =
    language === "en"
      ? "Explain step by step why this answer earned its score and what concept to review. Do not give a ready-made final answer."
      : "اشرح خطوة بخطوة لماذا حصلت هذه الإجابة على درجتها، وما المفهوم الذي يجب مراجعته. لا تعطِ إجابة نهائية جاهزة.";
  return `${questionBlock(ctx, language)}\n\n${ask}`;
}

export function tutorHintPrompt(ctx: TutorQuestionContext, language: TutorLanguage): string {
  const ask =
    language === "en"
      ? "Give exactly ONE hint that moves the student toward the right reasoning. Do not give the answer."
      : "أعطِ تلميحاً واحداً فقط يقرّب الطالب من التفكير الصحيح. لا تعطِ الإجابة.";
  return `${questionBlock(ctx, language)}\n\n${ask}`;
}

export function tutorFeedbackPrompt(
  questionPrompt: string,
  options: string[],
  newAnswer: string,
  language: TutorLanguage,
): string {
  const head = language === "en" ? `Question: ${questionPrompt}` : `السؤال: ${questionPrompt}`;
  const opts =
    options.length > 0
      ? language === "en"
        ? `\nOptions: ${options.join(" | ")}`
        : `\nالاختيارات: ${options.join(" | ")}`
      : "";
  const ask =
    language === "en"
      ? "\n\nThe student just re-attempted this question. Give feedback: what is right, what is missing, and ONE hint for improvement. Judge the attempt on its own reasoning. Do not print any answer key."
      : "\n\nالطالب أعاد محاولة هذا السؤال الآن. أعطِ ملاحظات: ما الصحيح، وما الناقص، وتلميحاً واحداً للتحسين. قيّم المحاولة من منطقها نفسه. لا تطبع أي مفتاح إجابة.";
  return `${head}${opts}\n${language === "en" ? "New attempt:" : "المحاولة الجديدة:"} ${newAnswer}${ask}`;
}

export function tutorTipsPrompt(objectives: string[], language: TutorLanguage): string {
  const ask =
    language === "en"
      ? 'For each objective below, write ONE short study tip (one sentence) telling the student how to review it. Answer as a JSON array only: [{"objective": "...", "tip": "..."}]. Keep every objective, in the same order.'
      : 'لكل هدف أدناه، اكتب نصيحة مذاكرة واحدة قصيرة (جملة واحدة) توضح للطالب كيف يراجعه. أجب بمصفوفة JSON فقط: [{"objective": "...", "tip": "..."}]. حافظ على كل الأهداف وبنفس الترتيب.';
  const list = objectives.map((o, i) => `${i + 1}. ${o}`).join("\n");
  return `${ask}\n\n${list}`;
}

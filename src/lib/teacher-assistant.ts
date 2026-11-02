export type AssistantLanguage = "ar" | "en";
export type AssistantChatMessage = { role: "user" | "assistant"; content: string };

export type TeacherWorkspaceSummary = {
  assessments: number;
  drafts: number;
  published: number;
  pendingReviews: number;
  releasedResults: number;
  averageReleasedPercent: number | null;
  releasedSampleSize: number;
};

const MAX_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 1_500;

/** Validate the untrusted chat payload before it reaches an AI provider. */
export function validateTeacherAssistantInput(
  raw: unknown,
): { language: AssistantLanguage; messages: AssistantChatMessage[] } | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const data = raw as Record<string, unknown>;
  const language = data["language"];
  const messages = data["messages"];
  if (language !== "ar" && language !== "en") return null;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    return null;
  }

  const validated: AssistantChatMessage[] = [];
  for (const item of messages) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const message = item as Record<string, unknown>;
    if (message["role"] !== "user" && message["role"] !== "assistant") return null;
    if (typeof message["content"] !== "string") return null;
    const content = message["content"].trim();
    if (!content || content.length > MAX_MESSAGE_CHARS) return null;
    validated.push({ role: message["role"], content });
  }
  if (validated.at(-1)?.role !== "user") return null;
  return { language, messages: validated };
}

/** Build a role-specific prompt with only aggregate, non-identifying context. */
export function buildTeacherAssistantSystemPrompt(
  language: AssistantLanguage,
  summary: TeacherWorkspaceSummary,
): string {
  const snapshot = [
    `Assessments: ${summary.assessments}`,
    `Draft assessments: ${summary.drafts}`,
    `Published assessments: ${summary.published}`,
    `Submissions awaiting review or release: ${summary.pendingReviews}`,
    `Released results: ${summary.releasedResults}`,
    `Average recent released score: ${summary.averageReleasedPercent === null ? "not shown (fewer than 5 usable results)" : `${summary.averageReleasedPercent}% across ${summary.releasedSampleSize} recent results`}`,
  ].join("\n");

  if (language === "ar") {
    return [
      "أنت مساعد تربوي عملي داخل منصة قَيّمني، مخصص لمعلمي المدارس والمدرسين الخصوصيين.",
      "أجب بالعربية الفصحى السهلة والواضحة، بجمل قصيرة ومباشرة، ما لم يطلب المعلم لغة أخرى. اشرح المصطلح الضروري بكلمات بسيطة.",
      "استخدم تنسيقاً بسيطاً بلا Markdown bold أو علامتي النجمتين **. تجنب التشكيل والتنوين غير الضروريين، ولا تخلط العربية والإنجليزية إلا لمصطلح لازم.",
      "ساعد في تخطيط الدروس، بناء أسئلة مناسبة للمرحلة، صياغة معايير تصحيح وملاحظات بنّاءة، وقراءة مؤشرات الصف الإجمالية.",
      "لا تدّع أنك أنشأت اختباراً أو حفظت أو نشرت شيئاً؛ أنت تقدم مسودة نصية فقط. وجّه المعلم إلى الأدوات المناسبة داخل المنصة عند الحاجة.",
      "لا تخترع معلومات عن طالب أو نتيجة. المؤشرات أدناه إجمالية فقط؛ لا توجد أسماء طلاب أو إجابات فردية أو مفاتيح إجابة في سياقك.",
      "لا تطلب أسماء الطلاب أو بياناتهم الشخصية. إذا احتاج المعلم مشاركة إجابة، ذكّره بإزالة الاسم وأي معلومة تعريفية أولاً.",
      "لا تعتمد درجات ولا تقرر نتيجة طالب. كل سؤال أو معيار أو ملاحظة تقترحها مسودة يجب أن يراجعها المعلم.",
      "إذا كان الطلب عاماً أو ينقصه الصف أو المادة أو الهدف، اسأل سؤالاً توضيحياً واحداً فقط قبل كتابة محتوى طويل.",
      "ملخص مساحة المعلم الحالي (أعداد إجمالية، لا تتضمن بيانات تعريفية):",
      snapshot,
    ].join("\n\n");
  }

  return [
    "You are a practical teaching assistant inside Qayyimni, for school teachers and tutors.",
    "Reply in clear, plain English with short, direct sentences unless the teacher asks for another language. Explain any necessary technical term in familiar words.",
    "Avoid Markdown bold and **. Use simple formatting and do not mix languages unless a necessary term requires it.",
    "Help plan lessons, draft age-appropriate questions, write marking criteria and constructive feedback, and interpret aggregate classroom indicators.",
    "Never claim that you created, saved, or published anything. You only provide text drafts; point the teacher to the relevant in-app tool when useful.",
    "Do not invent facts about a student or a result. The context below is aggregate only; you have no student names, individual answers, or answer keys.",
    "Do not ask for student names or personal data. If a teacher wants to share an answer, remind them to remove names and identifying details first.",
    "Do not approve marks or decide a student's result. Any question, rubric, or feedback you draft must be reviewed by the teacher.",
    "If a request is broad or missing the grade, subject, or learning goal, ask just one clarifying question before drafting long content.",
    "Current teacher workspace summary (aggregate counts, no identifying data):",
    snapshot,
  ].join("\n\n");
}

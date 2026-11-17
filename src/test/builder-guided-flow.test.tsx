import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/lib/i18n";
const mocks = vi.hoisted(() => ({
  meta: vi.fn(),
  question: vi.fn(),
  publish: vi.fn(),
  data: {
    assessment: {
      id: "fixture",
      title: "TEST exam",
      status: "draft",
      instructions: "",
      grade_level: "",
      subject_id: null,
      due_at: null,
      starts_at: null,
      duration_minutes: null,
      max_attempts: 1,
      auto_whatsapp_send: 0,
    },
    questions: [
      {
        id: "q1",
        assessment_id: "fixture",
        prompt: "TEST prompt",
        type: "true_false",
        marks: 1,
        options: [],
        objective: "",
        difficulty: "medium",
        position: 0,
        key: { correct_answer: "true", accepted_alternatives: [], rubric: "", explanation: "" },
      },
    ],
    subjects: [],
    students: [],
    assignedIds: [],
    submissionCount: 0,
  },
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: object) => ({
    ...options,
    useParams: () => ({ id: "fixture" }),
  }),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("@/server/d1-assessments", () => ({
  getBuilderDataD1: async () => mocks.data,
  listQuestionBankD1: async () => [],
  updateAssessmentMetaD1: mocks.meta,
  updateQuestionD1: mocks.question,
  setAssessmentStatusD1: mocks.publish,
}));
vi.mock("@/components/whatsapp-auto-send-toggle", () => ({ WhatsAppAutoSendToggle: () => null }));
import { Route } from "@/routes/_authenticated/assessments.$id";
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Builder = (Route as unknown as { component: React.ComponentType }).component;
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <Builder />
      </I18nProvider>
    </QueryClientProvider>,
  );
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe("teacher draft preparation", () => {
  it("keeps availability blocked for an empty roster", async () => {
    mount();
    await screen.findByRole("button", { name: /3 إتاحة للطلاب/ });
    fireEvent.click(screen.getByRole("button", { name: /3 إتاحة للطلاب/ }));
    expect(screen.getByRole("button", { name: "إتاحة الاختبار للطلاب" })).toBeDisabled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("blocks navigation with unsaved details and continues only after successful save", async () => {
    mocks.meta.mockResolvedValue(undefined);
    mount();
    const title = await screen.findByLabelText("العنوان");
    fireEvent.change(title, { target: { value: "TEST changed" } });
    expect(screen.getByRole("button", { name: /2 الأسئلة/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "حفظ التفاصيل والمتابعة" }));
    await waitFor(() => expect(mocks.meta).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /2 الأسئلة/ })).toHaveAttribute(
        "aria-current",
        "step",
      ),
    );
  });
  it.each([
    "If 3 boxes contain 2 pencils each, how many pencils are there in total?",
    "كم عدد الأقلام في 3 صناديق؟",
    "احسب 3 × 2 (pencils) ثم اكتب الإجابة.",
  ])("keeps auto direction without rewriting %s", async (text) => {
    const previous = mocks.data.questions[0]!.prompt;
    mocks.data.questions[0]!.prompt = text;
    try {
      mount();
      await screen.findByRole("button", { name: /2 الأسئلة/ });
      fireEvent.click(screen.getByRole("button", { name: /2 الأسئلة/ }));
      const prompt = await screen.findByDisplayValue(text);
      expect(prompt).toHaveAttribute("dir", "auto");
      expect(prompt).toHaveClass("text-start");
      expect(prompt).toHaveValue(text);
      expect(mocks.question).not.toHaveBeenCalled();
    } finally {
      mocks.data.questions[0]!.prompt = previous;
    }
  });
  it("keeps the draft in details if saving fails", async () => {
    mocks.meta.mockRejectedValue(new Error("TEST save failure"));
    mount();
    await screen.findByRole("button", { name: "حفظ التفاصيل والمتابعة" });
    fireEvent.click(screen.getByRole("button", { name: "حفظ التفاصيل والمتابعة" }));
    await waitFor(() => expect(mocks.meta).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: /1 تفاصيل الاختبار/ })).toHaveAttribute(
      "aria-current",
      "step",
    );
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});

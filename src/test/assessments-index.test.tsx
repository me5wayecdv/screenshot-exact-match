import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { I18nProvider } from "@/lib/i18n";

const navigateMock = vi.fn();
vi.mock("@/server/d1-assessments", () => ({
  createAssessmentD1: vi.fn(),
  listTeacherAssessmentsD1: vi.fn(),
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigateMock,
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
import { createAssessmentD1, listTeacherAssessmentsD1 } from "@/server/d1-assessments";
import { setGenerateHandoff, takeGenerateHandoff, dataUrlToFile } from "@/lib/generate-handoff";
import { Route } from "@/routes/_authenticated/assessments.index";

function mount() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0, throwOnError: false } },
  });
  const Page = Route.options.component!;
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <Page />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);
beforeEach(() => {
  navigateMock.mockReset();
  takeGenerateHandoff();
  vi.mocked(createAssessmentD1)
    .mockReset()
    .mockResolvedValue({ id: "a-1" } as never);
  vi.mocked(listTeacherAssessmentsD1)
    .mockReset()
    .mockResolvedValue({ rows: [], hasNext: false } as never);
});

describe("generate handoff module", () => {
  it("take returns the payload once, then null", () => {
    expect(takeGenerateHandoff()).toBeNull();
    setGenerateHandoff({ text: "نص الدرس" });
    expect(takeGenerateHandoff()).toEqual({ text: "نص الدرس" });
    expect(takeGenerateHandoff()).toBeNull();
  });
  it("dataUrlToFile round-trips name, type and bytes", () => {
    const file = dataUrlToFile("lesson.pdf", "data:application/pdf;base64," + btoa("hello"));
    expect(file.name).toBe("lesson.pdf");
    expect(file.type).toBe("application/pdf");
    expect(file.size).toBe(5);
  });
});

describe("assessments index page layout", () => {
  it("renders the AI card, the manual card and the list heading, with one AI button", async () => {
    mount();
    expect(await screen.findByRole("heading", { name: "اختباراتي" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "توليد بالذكاء الاصطناعي" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "إعداد يدوي" })).toBeInTheDocument();
    // Exactly one AI action on the page: the old header "رفع PDF" button and
    // the empty-state duplicate are gone.
    expect(screen.getAllByRole("button", { name: "توليد اختبار بالذكاء الاصطناعي" })).toHaveLength(
      1,
    );
    expect(screen.queryByRole("link", { name: /رفع PDF/ })).not.toBeInTheDocument();
    // Empty state is a message, not another generate button.
    expect(await screen.findByText("لا توجد اختبارات بعد.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "توليد اختبار بالذكاء الاصطناعي" })).toBeNull();
  });
});

describe("AI card", () => {
  it("keeps the button disabled until text is pasted, then hands the text off", async () => {
    mount();
    const button = await screen.findByRole("button", { name: "توليد اختبار بالذكاء الاصطناعي" });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText("أو الصق نص الدرس"), {
      target: { value: "درس عن الكسور في مادة الرياضيات" },
    });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: "/assessments/generate" }));
    expect(takeGenerateHandoff()).toEqual({ text: "درس عن الكسور في مادة الرياضيات" });
  });
  it("shows the chosen file name and hands the file off", async () => {
    mount();
    const button = await screen.findByRole("button", { name: "توليد اختبار بالذكاء الاصطناعي" });
    const input = screen.getByLabelText("ملف الدرس (PDF)");
    const file = new File(["%PDF-1.4 fake"], "شرح-الدرس.pdf", { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(screen.getByText("شرح-الدرس.pdf")).toBeInTheDocument();
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: "/assessments/generate" }));
    const handed = takeGenerateHandoff();
    expect(handed?.file?.name).toBe("شرح-الدرس.pdf");
    expect(handed?.file?.dataUrl.startsWith("data:application/pdf")).toBe(true);
  });
});

describe("manual card", () => {
  it("shows an Arabic inline error under the field when the title is empty", async () => {
    mount();
    const button = await screen.findByRole("button", { name: "بدء إعداد الاختبار" });
    fireEvent.click(button);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("من فضلك اكتب عنوان الاختبار أولًا.");
    expect(vi.mocked(createAssessmentD1)).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
    // Typing clears the error and the normal create flow still works.
    fireEvent.change(screen.getByLabelText("اختبار جديد"), {
      target: { value: "اختبار الوحدة ٢" },
    });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(button);
    await waitFor(() =>
      expect(vi.mocked(createAssessmentD1)).toHaveBeenCalledWith({
        data: { title: "اختبار الوحدة ٢" },
      }),
    );
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith({
        to: "/assessments/$id",
        params: { id: "a-1" },
      }),
    );
  });
});

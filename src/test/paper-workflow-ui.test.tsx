import { afterEach, it, vi, expect } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/lib/i18n";
vi.mock("@/lib/session", () => ({
  useMe: () => ({ data: { id: "t", role: "school_teacher" }, isLoading: false }),
}));
vi.mock("@/server/d1-handwritten", () => ({
  listHwReferencesD1: vi.fn(async () => [
    {
      id: "ref-1",
      title: "نموذج العلوم",
      kind: "bubble",
      image_path: "t/uuid/reference.png",
      confirmed_text: "س١: ب\nس٢: ج",
      created_at: "2026-11-21T12:00:00Z",
    },
  ]),
  listHwAssessmentsD1: vi.fn(async () => []),
  listHwQuestionsD1: vi.fn(async () => []),
  listHwStudentsD1: vi.fn(async () => []),
  listHwHistoryD1: vi.fn(async () => []),
  confirmHwReferenceD1: vi.fn(),
  getHwReferenceImageD1: vi.fn(),
  deleteHwGradeD1: vi.fn(),
  deleteHwPaperD1: vi.fn(),
  getHwPaperD1: vi.fn(),
  saveHwGradeD1: vi.fn(),
  previewHwGradeD1: vi.fn(),
  uploadHwPaperD1: vi.fn(),
}));
vi.mock("@/server/handwritten", () => ({
  getHandwritingStatus: vi.fn(async () => ({ configured: true, visionModelExplicit: true })),
  ocrHandwrittenImage: vi.fn(),
}));
import { Route } from "@/routes/_authenticated/handwritten";
afterEach(cleanup);
it("shows only the next useful step, with optional settings closed", async () => {
  const Page = Route.options.component!;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>
        <Page />
      </I18nProvider>
    </QueryClientProvider>,
  );
  expect(screen.getByRole("heading", { name: "١. ارفع نموذج الإجابة" })).toBeVisible();
  expect(screen.queryByRole("spinbutton", { name: "الورقة من كام درجة؟" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "صحّح على نموذج الإجابة" })).not.toBeInTheDocument();
  await screen.findByRole("option", { name: /نموذج العلوم/ });
  fireEvent.change(screen.getByLabelText("استخدم نموذج حفظته قبل كده"), {
    target: { value: "ref-1" },
  });
  expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
  expect(
    screen.getByText("النتيجة هتظهر كنسبة من ١٠٠، من غير ما تحتاج تحدد مجموع الورقة."),
  ).toBeVisible();
  expect(screen.getByLabelText("توزيع الدرجات (اختياري)").closest("details")).not.toHaveAttribute(
    "open",
  );
  expect(screen.getByLabelText("تعليمات إضافية (اختياري)")).not.toHaveValue("");
  expect(screen.queryByRole("heading", { name: "٥. احفظ النتيجة" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "صحّح على نموذج الإجابة" })).not.toBeInTheDocument();
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/lib/i18n";
import { PaperReferencePanel } from "@/components/PaperReferencePanel";
import { useState } from "react";
import type { PaperReference } from "@/server/paper-reference";
const fixture = vi.hoisted(() => ({
  id: "reference-1",
  title: "نموذج العلوم",
  kind: "bubble" as const,
  image_path: "t/uuid/reference.png",
  confirmed_text: "1: B\n2: C",
  created_at: "2026-11-21T12:00:00Z",
}));
vi.mock("@/server/d1-handwritten", () => ({
  listHwReferencesD1: vi.fn(async () => [fixture]),
  confirmHwReferenceD1: vi.fn(async () => fixture),
  getHwReferenceImageD1: vi.fn(async () => "data:image/png;base64,aW1hZ2U="),
}));
vi.mock("@/server/handwritten", () => ({
  ocrHandwrittenImage: vi.fn(async () => ({ ok: true, text: "1: B\n2: C", model: "synthetic" })),
}));
import { confirmHwReferenceD1 } from "@/server/d1-handwritten";
import { ocrHandwrittenImage } from "@/server/handwritten";
const compress = vi.fn(async () => ({ dataUrl: "data:image/png;base64,aW1hZ2U=" }));
function Harness({ locked = false }: { locked?: boolean }) {
  const [reference, setReference] = useState<PaperReference | null>(null);
  return (
    <>
      <PaperReferencePanel
        teacherId="t"
        reference={reference}
        onChange={setReference}
        compressImage={compress}
        locked={locked}
      />
      <fieldset disabled={!reference}>
        <input aria-label="Student paper" />
      </fieldset>
    </>
  );
}
function show(locked = false) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <I18nProvider>
        <Harness locked={locked} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});
afterEach(cleanup);
describe("Teacher confirms reference before student papers", () => {
  it("unlocks papers only after explicit selection of a saved reference and locks again when cleared", async () => {
    show();
    expect(screen.getByLabelText("Student paper")).toBeDisabled();
    await screen.findByRole("option", { name: /نموذج العلوم/ });
    fireEvent.change(screen.getByLabelText("مرجع معتمد سابقا"), { target: { value: fixture.id } });
    expect(screen.getByLabelText("Student paper")).toBeEnabled();
    expect(screen.getByText("تم اعتماد المرجع: نموذج العلوم")).toBeInTheDocument();
    expect(screen.getByText(/1: B\s+2: C/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "اختيار أو رفع مرجع آخر" }));
    expect(screen.getByLabelText("Student paper")).toBeDisabled();
  });
  it("keeps reading separate from confirmation and uses the reference/bubble roles", async () => {
    show();
    fireEvent.change(screen.getByLabelText("نوع النموذج"), { target: { value: "bubble" } });
    fireEvent.change(screen.getByLabelText("صورة المرجع فقط، ليست ورقة طالب"), {
      target: { files: [new File(["synthetic"], "key.png", { type: "image/png" })] },
    });
    const read = await screen.findByRole("button", {
      name: "قراءة إجابات النموذج بالذكاء الاصطناعي",
    });
    const confirm = screen.getByRole("button", { name: "اعتماد الصورة والإجابات كمرجع للتصحيح" });
    expect(confirm).toBeDisabled();
    fireEvent.click(read);
    await waitFor(() =>
      expect(ocrHandwrittenImage).toHaveBeenCalledWith({
        data: {
          imageDataUrl: "data:image/png;base64,aW1hZ2U=",
          paperRole: "reference",
          paperKind: "bubble",
        },
      }),
    );
    await waitFor(() => expect(confirm).toBeEnabled());
    expect(confirmHwReferenceD1).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Student paper")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("راجع الإجابات وصححها قبل الاعتماد"), {
      target: { value: "1: A\n2: C" },
    });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(confirmHwReferenceD1).toHaveBeenCalledWith({
        data: {
          title: "key",
          kind: "bubble",
          dataUrl: "data:image/png;base64,aW1hZ2U=",
          confirmedText: "1: A\n2: C",
        },
      }),
    );
    await waitFor(() => expect(screen.getByLabelText("Student paper")).toBeEnabled());
  });
  it("cannot replace the reference while a student grading operation is in flight", async () => {
    show(true);
    expect(screen.getByLabelText("مرجع معتمد سابقا")).toBeDisabled();
    expect(screen.getByLabelText("نوع النموذج")).toBeDisabled();
    expect(screen.getByLabelText("صورة المرجع فقط، ليست ورقة طالب")).toBeDisabled();
  });
});

/**
 * Component tests for the AI-F4 display fix (src/components/AiGradeSuggestion.tsx).
 *
 * The bug, live-verified 2026-11-14: after a teacher generated a suggestion
 * on /grading and reloaded the page, the suggestion box was gone — the
 * component only ever showed a suggestion it had just generated in-memory.
 * The fix: the grading page passes the persisted suggestion (read back from
 * answers.ai_suggestion) as `initialSuggestion`, and the component renders
 * it on mount, advisory-only, exactly like a fresh suggestion.
 *
 * Also covers the AI-F4 usage-linkage gap found on live: the suggest call
 * never sent questionId/submissionId, so ai_usage_events rows were logged
 * with question_id NULL. The component now forwards both ids it receives
 * from the grading page.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { AiGradeSuggestion } from "@/components/AiGradeSuggestion";

const { suggestGradeMock } = vi.hoisted(() => ({ suggestGradeMock: vi.fn() }));

vi.mock("@/server/ai-grade", () => ({
  getAiGradingStatus: vi.fn(async () => ({ configured: true })),
  suggestGrade: suggestGradeMock,
}));

const PERSISTED = {
  suggestedScore: 10,
  feedback: "الإجابة صحيحة ووافية.",
  confidence: "high" as const,
};

const BASE_PROPS = {
  answerId: "a1",
  questionPrompt: "ما هي عاصمة المملكة العربية السعودية؟",
  rubric: "العاصمة + أكبر مدينة",
  acceptedAlternatives: [] as string[],
  studentAnswer: "عاصمة المملكة العربية السعودية هي الرياض.",
  maxMarks: 10,
  onAccept: () => {},
};

function renderSuggestion(props: Partial<Parameters<typeof AiGradeSuggestion>[0]> = {}) {
  return render(
    <I18nProvider>
      <AiGradeSuggestion {...BASE_PROPS} {...props} />
    </I18nProvider>,
  );
}

describe("AiGradeSuggestion: persisted suggestion (AI-F4 display fix)", () => {
  it("shows a persisted suggestion on mount, without a Suggest click", () => {
    renderSuggestion({ initialSuggestion: PERSISTED });
    // The suggestion box: score + feedback + confidence, no AI call made.
    expect(screen.getByText(/الدرجة المقترحة: 10 \/ 10/)).toBeTruthy();
    expect(screen.getByText("الإجابة صحيحة ووافية.")).toBeTruthy();
    expect(screen.getByText(/ثقة عالية/)).toBeTruthy();
    expect(suggestGradeMock).not.toHaveBeenCalled();
  });

  it("without a persisted suggestion it shows only the Suggest button", () => {
    renderSuggestion();
    expect(screen.getByText("اقتراح درجة بالذكاء الاصطناعي")).toBeTruthy();
    expect(screen.queryByText(/ثقة عالية/)).toBeNull();
  });

  it("Accept on a persisted suggestion fills the parent fields (advisory only)", () => {
    const onAccept = vi.fn();
    renderSuggestion({ initialSuggestion: PERSISTED, onAccept });
    fireEvent.click(screen.getByText("اعتماد"));
    expect(onAccept).toHaveBeenCalledWith({ score: 10, feedback: "الإجابة صحيحة ووافية." });
  });

  it("Suggest passes questionId and submissionId to the server (AI-F4 linkage)", async () => {
    suggestGradeMock.mockResolvedValue({
      ok: true,
      suggestion: { suggestedScore: 8, feedback: "جيد.", confidence: "medium" },
    });
    renderSuggestion({ questionId: "q-1", submissionId: "sub-1" });
    fireEvent.click(screen.getByText("اقتراح درجة بالذكاء الاصطناعي"));
    expect(await screen.findByText(/الدرجة المقترحة: 8 \/ 10/)).toBeTruthy();
    expect(suggestGradeMock).toHaveBeenCalledTimes(1);
    const call = suggestGradeMock.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(call.data["questionId"]).toBe("q-1");
    expect(call.data["submissionId"]).toBe("sub-1");
    expect(call.data["answerId"]).toBe("a1");
  });
});

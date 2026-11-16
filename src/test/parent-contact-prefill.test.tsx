import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "@/lib/i18n";
vi.mock("@/server/d1-report", () => ({
  updateParentContactD1: vi.fn().mockResolvedValue({ ok: true }),
}));
import { updateParentContactD1 } from "@/server/d1-report";
import { ParentContactForm } from "@/components/parent-contact-form";
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const form = (phone: string | null, consent = false, studentId = "local-student") => (
  <I18nProvider>
    <ParentContactForm studentId={studentId} initialPhone={phone} initialConsent={consent} />
  </I18nProvider>
);
describe("parent contact draft refresh safety", () => {
  it("uses DB phone when async profile data arrives after mount", () => {
    const { rerender } = render(form(null));
    expect(screen.getByRole("textbox")).toHaveValue("");
    rerender(form("+201012345678"));
    expect(screen.getByRole("textbox")).toHaveValue("+201012345678");
  });
  it("refreshes untouched fields without treating a number as consent", () => {
    const { rerender } = render(form(null));
    rerender(form("+201012345678"));
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    rerender(form("+201512345678", true));
    expect(screen.getByRole("textbox")).toHaveValue("+201512345678");
    expect(screen.getByRole("checkbox")).toBeChecked();
  });
  it("a late refresh cannot overwrite an edited phone or explicit empty draft", () => {
    const { rerender } = render(form("+201012345678"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "01112345678" } });
    rerender(form("+201512345678", true));
    expect(screen.getByRole("textbox")).toHaveValue("01112345678");
    expect(screen.getByRole("checkbox")).toBeChecked();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
    rerender(form("+201212345678", true));
    expect(screen.getByRole("textbox")).toHaveValue("");
  });
  it("keeps consent withdrawal when phone refreshes", () => {
    const { rerender } = render(form("+201012345678", true));
    fireEvent.click(screen.getByRole("checkbox"));
    rerender(form("+201512345678", true));
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("textbox")).toHaveValue("+201512345678");
  });
  it("keeps an explicit consent choice even if it matches the old props", () => {
    const { rerender } = render(form("+201012345678", false));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("checkbox"));
    rerender(form("+201012345678", true));
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });
  it("never carries drafts across students", () => {
    const { rerender } = render(form("+201012345678", true));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "01112345678" } });
    fireEvent.click(screen.getByRole("checkbox"));
    rerender(form("+201512345678", true, "other-student"));
    expect(screen.getByRole("textbox")).toHaveValue("+201512345678");
    expect(screen.getByRole("checkbox")).toBeChecked();
  });
  it("a completed save cannot replace a newer edit", async () => {
    let finish!: () => void;
    vi.mocked(updateParentContactD1).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(form("+201012345678", true));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "01112345678" } });
    fireEvent.click(screen.getByRole("button"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "01212345678" } });
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => {
      finish();
    });
    expect(screen.getByRole("textbox")).toHaveValue("01212345678");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(updateParentContactD1).toHaveBeenCalledWith({
      data: { studentId: "local-student", phone: "+201112345678", consent: true },
    });
  });
  it("a failed save keeps the draft and consent", async () => {
    vi.mocked(updateParentContactD1).mockRejectedValueOnce(new Error("NETWORK"));
    const { rerender } = render(form("+201012345678", true));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "01112345678" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(screen.getByRole("button")).toBeEnabled());
    rerender(form("+201512345678", true));
    expect(screen.getByRole("textbox")).toHaveValue("01112345678");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });
  it("normalizes a saved draft, then releases it once the server echoes the save", async () => {
    const { rerender } = render(form("+201012345678", false));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "01112345678" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("+201112345678"));
    rerender(form("+201112345678", true));
    rerender(form("+201512345678", false));
    expect(screen.getByRole("textbox")).toHaveValue("+201512345678");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });
});

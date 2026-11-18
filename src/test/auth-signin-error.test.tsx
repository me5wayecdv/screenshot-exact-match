import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { I18nProvider } from "@/lib/i18n";

vi.mock("@/server/d1-auth-fns", () => ({
  getMeD1: vi.fn().mockRejectedValue(new Error("no session")),
  requestPasswordResetD1: vi.fn(),
  signInD1: vi.fn(),
  signUpD1: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

import { signInD1 } from "@/server/d1-auth-fns";
import { Route } from "@/routes/auth";

function mountAuth() {
  const Page = Route.options.component!;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>
        <Page />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

function invalidCredentials() {
  return Object.assign(new Error("Invalid email or password"), {
    code: "INVALID_CREDENTIALS",
  });
}

afterEach(() => {
  cleanup();
  vi.mocked(signInD1).mockReset();
});

describe("Persistent sign-in error", () => {
  it("keeps the failed sign-in error visible until the user edits a field", async () => {
    vi.mocked(signInD1).mockRejectedValue(invalidCredentials());
    mountAuth();

    fireEvent.change(screen.getByLabelText("البريد الإلكتروني"), {
      target: { value: "someone@example.com" },
    });
    fireEvent.change(screen.getByLabelText("كلمة المرور"), {
      target: { value: "WrongPass123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "تسجيل الدخول" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("البريد أو كلمة السر مش صح.");
    // The error stays put - nothing dismisses it on a timer.
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.getByRole("alert")).toHaveTextContent("البريد أو كلمة السر مش صح.");
    // The typed password is still there too.
    expect(screen.getByLabelText("كلمة المرور")).toHaveValue("WrongPass123");

    fireEvent.change(screen.getByLabelText("كلمة المرور"), {
      target: { value: "WrongPass1234" },
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("clears the error on a new attempt and shows it again on the next failure", async () => {
    vi.mocked(signInD1).mockRejectedValue(invalidCredentials());
    mountAuth();

    fireEvent.change(screen.getByLabelText("البريد الإلكتروني"), {
      target: { value: "someone@example.com" },
    });
    fireEvent.change(screen.getByLabelText("كلمة المرور"), {
      target: { value: "WrongPass123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "تسجيل الدخول" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("البريد أو كلمة السر مش صح.");

    // Resubmitting clears the old error while the attempt is in flight,
    // then shows the fresh one.
    fireEvent.click(screen.getByRole("button", { name: "تسجيل الدخول" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("البريد أو كلمة السر مش صح.");
  });
});

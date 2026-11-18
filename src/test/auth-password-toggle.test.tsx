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

let mockSearchMode: string | undefined;
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
  useSearch: () => ({ mode: mockSearchMode }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

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

afterEach(() => {
  cleanup();
  mockSearchMode = undefined;
});

describe("Password visibility toggle on /auth", () => {
  it("lets a user see and hide the password while typing on the sign-in form", () => {
    mountAuth();

    const password = screen.getByLabelText("كلمة المرور");
    expect(password).toHaveAttribute("type", "text");

    const hide = screen.getByRole("button", { name: "إخفاء كلمة المرور" });
    expect(hide).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(hide);
    expect(password).toHaveAttribute("type", "password");

    const show = screen.getByRole("button", { name: "إظهار كلمة المرور" });
    expect(show).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(show);
    expect(password).toHaveAttribute("type", "text");
  });

  it("keeps the toggle working on the signup form", () => {
    mockSearchMode = "signup";
    mountAuth();

    const password = screen.getByLabelText("كلمة المرور");
    expect(password).toHaveAttribute("type", "text");

    fireEvent.click(screen.getAllByRole("button", { name: "إخفاء كلمة المرور" })[0]!);
    expect(password).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("تأكيد كلمة المرور")).toHaveAttribute("type", "password");
  });
});

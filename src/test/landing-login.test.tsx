import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { I18nProvider } from "@/lib/i18n";
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  Link: ({
    children,
    to,
    search,
    ...props
  }: { children: ReactNode; to: string; search?: { mode?: string } } & Omit<
    ComponentProps<"a">,
    "href"
  >) => (
    <a href={to + (search?.mode ? `?mode=${search.mode}` : "")} {...props}>
      {children}
    </a>
  ),
}));
import { Route } from "@/routes/index";
afterEach(cleanup);
describe("Homepage login entry", () => {
  it("puts sign-in in the top header on every screen size and keeps signup separate", () => {
    const Page = Route.options.component!;
    render(
      <I18nProvider>
        <Page />
      </I18nProvider>,
    );
    const header = screen.getByRole("banner");
    const login = within(header).getByRole("link", { name: "تسجيل الدخول" });
    expect(login).toHaveAttribute("href", "/auth");
    expect(login.className).not.toMatch(/(?:^|\s)(?:\S+:)?hidden(?:\s|$)/);
    expect(login).toHaveClass("inline-flex", "min-h-11");
    expect(within(header).getAllByRole("link")[1]).toBe(login);
    expect(within(header).getByRole("link", { name: "إنشاء حساب" })).toHaveAttribute(
      "href",
      "/auth?mode=signup",
    );
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { I18nProvider } from "@/lib/i18n";
vi.mock("@/server/d1-auth-fns", () => ({ getMeD1: vi.fn(), signOutD1: vi.fn() }));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
  useRouterState: () => "/dashboard",
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  Outlet: () => <div>Authenticated content</div>,
}));
import { getMeD1 } from "@/server/d1-auth-fns";
import { Route } from "@/routes/_authenticated/route";
const student = {
  id: "student-1",
  email: "student@example.invalid",
  fullName: "Synthetic Student",
  role: "student" as const,
  joinCode: null,
};
function mount(
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0, throwOnError: false } },
  }),
) {
  const Shell = Route.options.component!;
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <Shell />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return qc;
}
afterEach(cleanup);
beforeEach(() => {
  vi.mocked(getMeD1).mockReset();
});
describe("session failure recovery and role cache", () => {
  it("shows recovery, not endless loading or guessed role navigation, on failure", async () => {
    vi.mocked(getMeD1).mockRejectedValue(new Error("network failure"));
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("حاول مرة أخرى");
    expect(screen.queryByText("Authenticated content")).not.toBeInTheDocument();
    expect(screen.queryByText(/التحميل/)).not.toBeInTheDocument();
    expect(screen.queryByText("اختباراتي")).not.toBeInTheDocument();
  });
  it("retry recovers the actual student session", async () => {
    vi.mocked(getMeD1)
      .mockRejectedValueOnce(new Error("network failure"))
      .mockRejectedValueOnce(new Error("network failure"))
      .mockResolvedValue(student);
    mount();
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "حاول مرة أخرى" }));
    expect(await screen.findByText("Authenticated content")).toBeInTheDocument();
    expect(screen.getAllByText("اختباراتي").length).toBeGreaterThan(0);
  });
  it("does not call the session twice after the route guard already verified it", async () => {
    const qc = new QueryClient();
    qc.setQueryData(["me"], student);
    mount(qc);
    expect(screen.getByText("Authenticated content")).toBeInTheDocument();
    await waitFor(() => expect(getMeD1).not.toHaveBeenCalled());
  });
  it("legacy cached null shows recovery instead of endless loading", async () => {
    const qc = new QueryClient();
    qc.setQueryData(["me"], null);
    mount(qc);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(/التحميل/)).not.toBeInTheDocument();
  });
  it("fresh guard identity replaces a cached teacher identity", async () => {
    const qc = new QueryClient();
    qc.setQueryData(["me"], { ...student, id: "teacher-1", role: "school_teacher" });
    vi.mocked(getMeD1).mockResolvedValue(student);
    await (
      Route.options.beforeLoad as unknown as (input: {
        context: { queryClient: QueryClient };
      }) => Promise<void>
    )({ context: { queryClient: qc } });
    expect(qc.getQueryData(["me"])).toEqual(student);
  });
});

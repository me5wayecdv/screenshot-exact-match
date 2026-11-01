import { createFileRoute, Link, Outlet, redirect, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  Home,
  ClipboardList,
  CheckSquare,
  Users,
  LogOut,
  BookOpen,
  Shield,
  History,
  TrendingUp,
  GraduationCap,
  MessageSquare,
  MessageSquareText,
  User,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Brand, LangToggle } from "@/components/Brand";
import { useI18n } from "@/lib/i18n";
import { useMe } from "@/lib/session";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data } = await supabase.auth.getUser();
    if (!data.user) throw redirect({ to: "/auth" });
  },
  component: AppShell,
});

function AppShell() {
  const { t } = useI18n();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  // Sidebar sections for teachers (work / assistant / follow-up / account).
  // Destinations are unchanged; only the grouping and section headers are new.
  const nav =
    me?.role === "school_teacher"
      ? [
          {
            header: t("navWork"),
            items: [
              { to: "/dashboard", label: t("dashboard"), icon: Home },
              { to: "/assessments", label: t("assessments"), icon: ClipboardList },
              { to: "/grading", label: t("grading"), icon: CheckSquare },
            ],
          },
          {
            header: t("navAssistant"),
            items: [{ to: "/assistant", label: t("assistantTitle"), icon: MessageSquareText }],
          },
          {
            header: t("navFollow"),
            items: [
              { to: "/analytics", label: t("anTitle"), icon: TrendingUp },
              { to: "/audit", label: t("auditHistory"), icon: History },
              { to: "/reviews", label: t("reviewsTitle"), icon: MessageSquare },
            ],
          },
          {
            header: t("navAccount"),
            items: [
              { to: "/students", label: t("students"), icon: Users },
              { to: "/profile", label: t("profile"), icon: User },
            ],
          },
        ]
      : me?.role === "tutor"
        ? [
            {
              header: t("navWork"),
              items: [
                { to: "/dashboard", label: t("dashboard"), icon: Home },
                { to: "/lessons", label: t("lessons"), icon: BookOpen },
              ],
            },
            {
              header: t("navAssistant"),
              items: [{ to: "/assistant", label: t("assistantTitle"), icon: MessageSquareText }],
            },
            {
              header: t("navFollow"),
              items: [
                { to: "/analytics", label: t("anTitle"), icon: TrendingUp },
                { to: "/audit", label: t("auditHistory"), icon: History },
                { to: "/reviews", label: t("reviewsTitle"), icon: MessageSquare },
              ],
            },
            {
              header: t("navAccount"),
              items: [
                { to: "/students", label: t("students"), icon: Users },
                { to: "/profile", label: t("profile"), icon: User },
              ],
            },
          ]
        : me?.role === "admin"
          ? [
              {
                header: null,
                items: [
                  { to: "/dashboard", label: t("dashboard"), icon: Home },
                  { to: "/admin", label: t("admin"), icon: Shield },
                  { to: "/audit", label: t("auditHistory"), icon: History },
                  { to: "/profile", label: t("profile"), icon: User },
                ],
              },
            ]
          : [
              {
                header: null,
                items: [
                  { to: "/dashboard", label: t("myAssessments"), icon: Home },
                  { to: "/tutor", label: t("tutorTitle"), icon: GraduationCap },
                  { to: "/reviews", label: t("reviewsTitle"), icon: MessageSquare },
                  { to: "/profile", label: t("profile"), icon: User },
                ],
              },
            ];

  async function signOut() {
    await qc.cancelQueries();
    qc.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  return (
    <div className="app-shell flex min-h-screen flex-col md:flex-row">
      <aside className="app-sidebar z-20 flex shrink-0 flex-col border-b border-sidebar-border text-sidebar-foreground md:min-h-screen md:w-[17rem] md:border-b-0 md:border-e">
        <div className="flex items-center justify-between border-b border-sidebar-border px-4 py-3.5 md:px-5 md:py-5">
          <Link to="/dashboard" className="rounded-sm">
            <Brand onDark />
          </Link>
          <span className="md:hidden">
            <LangToggle className="hover:bg-sidebar-accent" />
          </span>
        </div>

        <nav
          aria-label={t("brand")}
          className="app-nav flex gap-1 overflow-x-auto px-3 py-3 md:flex-col md:px-3 md:py-5"
        >
          {nav.map((section) => (
            <div
              key={section.header ?? "main"}
              className="flex gap-1 md:mt-6 md:flex-col md:first:mt-0"
            >
              {section.header && (
                <p className="hidden px-3 pb-1 text-xs font-semibold text-sidebar-foreground/60 md:block">
                  {section.header}
                </p>
              )}
              {section.items.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  className="app-nav-link flex min-h-10 items-center gap-3 whitespace-nowrap rounded-sm px-3 py-2 text-sm font-medium text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                  activeProps={{ className: "bg-sidebar-accent text-sidebar-primary" }}
                >
                  <item.icon className="size-4 shrink-0" aria-hidden />
                  <span>{item.label}</span>
                </Link>
              ))}
            </div>
          ))}
        </nav>

        <div className="hidden flex-1 md:block" />
        <div className="hidden border-t border-sidebar-border p-4 md:block">
          <div className="flex items-center gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-full border border-sidebar-border bg-sidebar-accent font-display text-sm font-bold text-sidebar-primary">
              {me?.fullName?.trim().slice(0, 1) || "·"}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{me?.fullName}</p>
              <p className="mt-0.5 truncate text-xs text-sidebar-foreground/60">
                {me ? t(me.role) : ""}
              </p>
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between">
            <LangToggle className="hover:bg-sidebar-accent" />
            <button
              type="button"
              onClick={signOut}
              className="flex items-center gap-2 rounded-sm px-3 py-2 text-sm text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-foreground"
            >
              <LogOut className="size-4 rtl:rotate-180" aria-hidden />
              {t("signOut")}
            </button>
          </div>
        </div>

        <div className="flex justify-end border-t border-sidebar-border px-3 py-2 md:hidden">
          <button
            type="button"
            onClick={signOut}
            className="flex items-center gap-2 rounded-sm px-3 py-2 text-sm text-sidebar-foreground/75 hover:bg-sidebar-accent"
          >
            <LogOut className="size-4 rtl:rotate-180" aria-hidden />
            {t("signOut")}
          </button>
        </div>
      </aside>

      <main className="app-main min-h-0 flex-1 px-4 py-6 sm:px-6 md:min-h-screen md:px-8 md:py-9 xl:px-12">
        <div className="mx-auto w-full max-w-[90rem]">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

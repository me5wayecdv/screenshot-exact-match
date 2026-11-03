import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
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
  MoreHorizontal,
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
  /**
   * Simple navigation: everything a person does every day is visible, and
   * everything else hides behind one "More" entry. `primary` is capped at
   * four items so the phone tab bar can hold it without a scroll strip.
   */
  const { primary, secondary } =
    me?.role === "school_teacher"
      ? {
          primary: [
            { to: "/dashboard", label: t("dashboard"), icon: Home },
            { to: "/assessments", label: t("assessments"), icon: ClipboardList },
            { to: "/grading", label: t("grading"), icon: CheckSquare },
            { to: "/assistant", label: t("assistantTitle"), icon: MessageSquareText },
          ],
          secondary: [
            { to: "/students", label: t("students"), icon: Users },
            { to: "/groups", label: t("groups"), icon: Users },
            { to: "/analytics", label: t("anTitle"), icon: TrendingUp },
            { to: "/reviews", label: t("reviewsTitle"), icon: MessageSquare },
            { to: "/audit", label: t("auditHistory"), icon: History },
            { to: "/profile", label: t("profile"), icon: User },
          ],
        }
      : me?.role === "tutor"
        ? {
            primary: [
              { to: "/dashboard", label: t("dashboard"), icon: Home },
              { to: "/assessments", label: t("assessments"), icon: ClipboardList },
              { to: "/lessons", label: t("lessons"), icon: BookOpen },
              { to: "/assistant", label: t("assistantTitle"), icon: MessageSquareText },
            ],
            secondary: [
              { to: "/students", label: t("students"), icon: Users },
              { to: "/groups", label: t("groups"), icon: Users },
              { to: "/analytics", label: t("anTitle"), icon: TrendingUp },
              { to: "/reviews", label: t("reviewsTitle"), icon: MessageSquare },
              { to: "/audit", label: t("auditHistory"), icon: History },
              { to: "/profile", label: t("profile"), icon: User },
            ],
          }
        : me?.role === "admin"
          ? {
              primary: [
                { to: "/dashboard", label: t("dashboard"), icon: Home },
                { to: "/admin", label: t("admin"), icon: Shield },
                { to: "/audit", label: t("auditHistory"), icon: History },
                { to: "/profile", label: t("profile"), icon: User },
              ],
              secondary: [],
            }
          : {
              primary: [
                { to: "/dashboard", label: t("myAssessments"), icon: Home },
                { to: "/tutor", label: t("tutorTitle"), icon: GraduationCap },
                { to: "/reviews", label: t("reviewsTitle"), icon: MessageSquare },
              ],
              secondary: [
                { to: "/groups", label: t("groups"), icon: Users },
                { to: "/profile", label: t("profile"), icon: User },
              ],
            };
  // Remember whether the "More" list is open; one panel serves both navs.
  const [moreOpen, setMoreOpen] = useState(false);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  useEffect(() => setMoreOpen(false), [pathname, me?.role]);

  async function signOut() {
    await qc.cancelQueries();
    qc.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  return (
    <div className="app-shell flex min-h-screen flex-col md:flex-row">
      <aside className="app-sidebar z-20 hidden shrink-0 flex-col border-b border-sidebar-border text-sidebar-foreground md:flex md:min-h-screen md:w-[16rem] md:border-b-0 md:border-e">
        <div className="flex items-center justify-between border-b border-sidebar-border px-4 py-5 md:px-5">
          <Link to="/dashboard" className="rounded-sm">
            <Brand onDark />
          </Link>
        </div>

        <nav aria-label={t("brand")} className="flex flex-col gap-1 px-3 py-5">
          {primary.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="app-nav-link flex min-h-11 items-center gap-3 whitespace-nowrap rounded-sm px-3 py-2 text-sm font-medium text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground"
              activeProps={{ className: "bg-sidebar-accent text-sidebar-primary" }}
            >
              <item.icon className="size-4 shrink-0" aria-hidden />
              <span>{item.label}</span>
            </Link>
          ))}
          {secondary.length > 0 ? (
            <button
              type="button"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((open) => !open)}
              className="flex min-h-11 items-center gap-3 rounded-sm px-3 py-2 text-sm font-medium text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground"
            >
              <MoreHorizontal className="size-4 shrink-0" aria-hidden />
              <span>{t("navMore")}</span>
            </button>
          ) : null}
          {moreOpen
            ? secondary.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  className="flex min-h-10 items-center gap-3 rounded-sm px-3 py-2 ps-9 text-sm text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                  activeProps={{ className: "bg-sidebar-accent text-sidebar-primary" }}
                >
                  <item.icon className="size-4 shrink-0" aria-hidden />
                  <span>{item.label}</span>
                </Link>
              ))
            : null}
        </nav>

        <div className="flex-1" />
        <div className="border-t border-sidebar-border p-4">
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
              <LogOut className="size-4 rtl:rotate-180" aria-hidden /> {t("signOut")}
            </button>
          </div>
        </div>
      </aside>

      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        {/* Phone header: brand, language, sign out. The destinations live in
            the bottom tab bar, where a thumb can reach them. */}
        <header className="app-sidebar flex items-center justify-between px-4 py-2.5 text-sidebar-foreground md:hidden">
          <Link to="/dashboard" className="rounded-sm">
            <Brand onDark />
          </Link>
          <span className="flex items-center gap-1">
            <LangToggle className="hover:bg-sidebar-accent" />
            <button
              type="button"
              onClick={signOut}
              aria-label={t("signOut")}
              className="grid size-10 place-items-center rounded-sm hover:bg-sidebar-accent"
            >
              <LogOut className="size-4 rtl:rotate-180" aria-hidden />
            </button>
          </span>
        </header>

        <main className="app-main min-h-0 flex-1 px-4 pb-6 pt-5 sm:px-6 md:px-8 md:py-9 xl:px-12">
          <div className="mx-auto w-full max-w-[90rem]">
            <Outlet />
          </div>
        </main>

        {moreOpen && secondary.length > 0 ? (
          <div className="fixed inset-x-3 bottom-20 z-40 md:hidden">
            <div className="nav-sheet grid grid-cols-2 gap-1">
              {secondary.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  className="flex min-h-11 items-center gap-2 rounded-sm px-3 py-2 text-sm font-medium hover:bg-muted"
                  activeProps={{ className: "bg-secondary text-primary" }}
                >
                  <item.icon className="size-4 shrink-0" aria-hidden />
                  {item.label}
                </Link>
              ))}
            </div>
          </div>
        ) : null}

        <nav aria-label={t("navMore")} className="tabbar md:hidden">
          {primary.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="tabbar-item"
              activeProps={{ "aria-current": "page" }}
            >
              <item.icon className="size-5" aria-hidden />
              <span className="max-w-full truncate">{item.label}</span>
            </Link>
          ))}
          {secondary.length > 0 ? (
            <button
              type="button"
              onClick={() => setMoreOpen((open) => !open)}
              aria-expanded={moreOpen}
              className="tabbar-item"
            >
              <MoreHorizontal className="size-5" aria-hidden />
              <span>{t("navMore")}</span>
            </button>
          ) : null}
        </nav>
      </div>
    </div>
  );
}

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
  const nav =
    me?.role === "school_teacher"
      ? [
          { to: "/dashboard", label: t("dashboard"), icon: Home },
          { to: "/assessments", label: t("assessments"), icon: ClipboardList },
          { to: "/grading", label: t("grading"), icon: CheckSquare },
          { to: "/audit", label: t("auditHistory"), icon: History },
          { to: "/analytics", label: t("anTitle"), icon: TrendingUp },
          { to: "/reviews", label: t("reviewsTitle"), icon: MessageSquare },
          { to: "/students", label: t("students"), icon: Users },
        ]
      : me?.role === "tutor"
        ? [
            { to: "/dashboard", label: t("dashboard"), icon: Home },
            { to: "/lessons", label: t("lessons"), icon: BookOpen },
            { to: "/audit", label: t("auditHistory"), icon: History },
            { to: "/analytics", label: t("anTitle"), icon: TrendingUp },
            { to: "/reviews", label: t("reviewsTitle"), icon: MessageSquare },
            { to: "/students", label: t("students"), icon: Users },
          ]
        : me?.role === "admin"
          ? [
              { to: "/dashboard", label: t("dashboard"), icon: Home },
              { to: "/admin", label: t("admin"), icon: Shield },
              { to: "/audit", label: t("auditHistory"), icon: History },
            ]
          : [
              { to: "/dashboard", label: t("myAssessments"), icon: Home },
              { to: "/tutor", label: t("tutorTitle"), icon: GraduationCap },
              { to: "/reviews", label: t("reviewsTitle"), icon: MessageSquare },
            ];

  async function signOut() {
    await qc.cancelQueries();
    qc.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      {/*
        Mobile: this becomes a sticky top app bar (brand + language + sign
        out) with a horizontally scrollable nav row underneath, so the page
        never gets pushed below the fold and never scrolls sideways.
        Desktop (md+): the original full-height sidebar.
      */}
      <aside className="sticky top-0 z-30 shrink-0 bg-sidebar text-sidebar-foreground md:static md:flex md:min-h-screen md:w-60 md:flex-col">
        <div className="flex items-center justify-between gap-2 px-4 py-3 md:p-5">
          <Brand />
          <div className="flex items-center gap-1 md:hidden">
            <LangToggle className="hover:bg-sidebar-accent" />
            <button
              onClick={signOut}
              aria-label={t("signOut")}
              className="rounded-md p-2 hover:bg-sidebar-accent"
            >
              <LogOut className="h-4 w-4 rtl:rotate-180" aria-hidden />
            </button>
          </div>
        </div>
        <nav className="scrollbar-none flex gap-1 overflow-x-auto px-3 pb-2 md:flex-col md:overflow-visible md:pb-0">
          {nav.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              className="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-sidebar-accent md:gap-3"
              activeProps={{ className: "bg-sidebar-accent text-sidebar-primary" }}
            >
              <n.icon className="h-4 w-4 shrink-0" aria-hidden /> {n.label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto hidden space-y-2 border-t border-sidebar-border p-4 md:block">
          <p className="truncate text-sm font-medium">{me?.fullName}</p>
          <p className="text-xs opacity-70">{me ? t(me.role) : ""}</p>
          <div className="flex items-center gap-1">
            <LangToggle className="hover:bg-sidebar-accent" />
            <button
              onClick={signOut}
              className="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm hover:bg-sidebar-accent"
            >
              <LogOut className="h-4 w-4 rtl:rotate-180" aria-hidden /> {t("signOut")}
            </button>
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-5 pb-12 md:px-10 md:py-10">
        <Outlet />
      </main>
    </div>
  );
}

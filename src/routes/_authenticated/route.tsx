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
      <aside className="flex shrink-0 flex-col bg-sidebar text-sidebar-foreground md:min-h-screen md:w-60">
        <div className="flex items-center justify-between p-5">
          <Brand onDark />
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 md:flex-col">
          {nav.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              className="flex items-center gap-3 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-sidebar-accent"
              activeProps={{ className: "bg-sidebar-accent text-sidebar-primary" }}
            >
              <n.icon className="h-4 w-4" aria-hidden /> {n.label}
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
        <div className="flex justify-end gap-1 px-3 pb-3 md:hidden">
          <LangToggle className="hover:bg-sidebar-accent" />
          <button
            onClick={signOut}
            className="rounded-md px-3 py-1.5 text-sm hover:bg-sidebar-accent"
          >
            {t("signOut")}
          </button>
        </div>
      </aside>
      <main className="flex-1 p-5 md:p-10">
        <Outlet />
      </main>
    </div>
  );
}

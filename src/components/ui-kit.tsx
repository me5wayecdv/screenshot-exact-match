import type { ReactNode } from "react";

const tone = {
  neutral: "border-border text-muted-foreground",
  primary: "border-primary/35 text-primary",
  success: "border-success/40 text-success",
  warning: "border-warning/50 text-warning-foreground",
  info: "border-info/40 text-info",
  danger: "border-destructive/40 text-destructive",
} as const;
export type Tone = keyof typeof tone;

export function Pill({ children, t = "neutral" }: { children: ReactNode; t?: Tone | undefined }) {
  return (
    <span
      className={`inline-flex items-center rounded-sm border px-2 py-0.5 text-sm font-medium ${tone[t]}`}
    >
      {children}
    </span>
  );
}

export const statusTone: Record<string, Tone> = {
  draft: "neutral",
  published: "success",
  closed: "warning",
  archived: "neutral",
  submitted: "info",
  awaiting_review: "warning",
  approved: "primary",
  partially_released: "info",
  released: "success",
  not_graded: "neutral",
  auto_graded: "primary",
  ai_suggested: "info",
  rejected: "danger",
  // Student-facing assessment states (src/lib/assessment-visibility.ts).
  in_progress: "info",
  available: "success",
  not_open_yet: "info",
  ended: "danger",
  unavailable: "neutral",
};

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-bold leading-tight sm:text-2xl md:text-3xl">{title}</h1>
        {subtitle && (
          <div className="mt-1 text-sm text-muted-foreground break-words">{subtitle}</div>
        )}
      </div>
      {actions && <div className="flex w-full flex-wrap gap-2 sm:w-auto">{actions}</div>}
    </div>
  );
}

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border bg-card p-4 sm:p-6 ${className}`}>{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground sm:p-8">
      {children}
    </div>
  );
}

/**
 * The console hero: the one card that tells a person what to do next. Used at the top of every
 * home screen so the page has a single obvious action instead of a wall of
 * cards. Decorative only: `kicker`/`hint` are optional.
 */
export function Hero({
  kicker,
  title,
  body,
  actions,
  hint,
}: {
  kicker?: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  actions?: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <section className="console-hero mb-6 p-6">
      {kicker ? <p className="section-kicker mb-2">{kicker}</p> : null}
      <h1 className="max-w-2xl text-xl font-bold leading-snug text-foreground sm:text-2xl md:text-[1.7rem]">
        {title}
      </h1>
      {body ? <p className="mt-2 max-w-xl text-sm text-muted-foreground">{body}</p> : null}
      {actions ? <div className="mt-4 flex flex-wrap gap-2">{actions}</div> : null}
      {hint ? <p className="mt-4 text-sm text-muted-foreground">{hint}</p> : null}
    </section>
  );
}

/** A stat card: one big number with a small label under it. */
export function StatCard({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <p className="font-display text-3xl font-bold">{value ?? "—"}</p>
      <p className="mt-2 text-sm text-muted-foreground">{label}</p>
    </div>
  );
}

/** Empty state with exactly one suggested action. */
export function EmptyCard({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-card">
      {icon}
      <p className="font-semibold text-foreground">{title}</p>
      {body ? <p className="max-w-sm text-sm text-muted-foreground">{body}</p> : null}
      {action}
    </div>
  );
}

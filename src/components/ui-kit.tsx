import type { ReactNode } from "react";

const tone = {
  neutral: "bg-muted text-muted-foreground",
  primary: "bg-secondary text-secondary-foreground",
  success: "bg-success/15 text-success",
  warning: "bg-warning/25 text-warning-foreground",
  info: "bg-info/15 text-info",
  danger: "bg-destructive/15 text-destructive",
} as const;
export type Tone = keyof typeof tone;

export function Pill({ children, t = "neutral" }: { children: ReactNode; t?: Tone | undefined }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${tone[t]}`}
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
  released: "success",
  not_graded: "neutral",
  auto_graded: "primary",
  ai_suggested: "info",
  rejected: "danger",
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
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold md:text-3xl">{title}</h1>
        {subtitle && <div className="mt-1 text-sm text-muted-foreground">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border bg-card p-5 shadow-soft ${className}`}>{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

/** Human-readable lines for one audit_log details object (pure, tested).
 *
 * Labels come from the caller (already translated): unknown keys fall back
 * to the raw key, and long values are truncated so one row can never blow
 * up the history view.
 */

export type AuditLine = { label: string; value: string };

export function formatAuditDetails(details: unknown, labels: Record<string, string>): AuditLine[] {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return [];
  }
  const lines: AuditLine[] = [];
  for (const [key, raw] of Object.entries(details as Record<string, unknown>)) {
    if (raw === null || raw === undefined || raw === "") continue;
    const value =
      typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean"
        ? String(raw)
        : JSON.stringify(raw);
    lines.push({
      label: labels[key] ?? key,
      value: value.length > 200 ? `${value.slice(0, 200)}…` : value,
    });
  }
  return lines;
}

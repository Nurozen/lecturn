import type { DesktopActivityRow } from "@lecturn/contracts";

export const checkPresentation = {
  pending: { icon: "◌", label: "Running / queued" },
  "action-required": { icon: "!", label: "Action needed" },
  success: { icon: "✓", label: "Passed" },
  failure: { icon: "×", label: "Failed" },
  skipped: { icon: "−", label: "Skipped" },
  neutral: { icon: "−", label: "Neutral" },
  cancelled: { icon: "⊘", label: "Cancelled" },
} as const;

export function activityCheckSummary(row: Pick<DesktopActivityRow, "checks" | "checkTotal">) {
  const checks = row.checks ?? [];
  const total = Math.max(row.checkTotal ?? checks.length, checks.length);
  const pending = checks.filter((check) => check.status === "pending").length;
  const failed = checks.filter(
    (check) => check.status === "failure" || check.status === "action-required",
  ).length;
  const passed = checks.filter((check) => check.status === "success").length;
  const unknown = total - checks.length;
  return {
    pending,
    total,
    unknown,
    label: `${total} CI ${total === 1 ? "job" : "jobs"}${pending ? ` · ${pending} running / queued` : ""}${failed ? ` · ${failed} need attention` : ""}${passed ? ` · ${passed} passed` : ""}`,
  };
}

/** A finished job is not necessarily a passed job. Keep neutral/cancelled jobs neutral. */
export function activityCheckTally(row: Pick<DesktopActivityRow, "checks" | "checkTotal">): string {
  const summary = activityCheckSummary(row);
  const count = (status: string) =>
    row.checks?.filter((check) => check.status === status).length ?? 0;
  if (count("failure")) return `× ${count("failure")}`;
  if (count("action-required")) return `! ${count("action-required")}`;
  if (summary.pending) return `◌ ${summary.pending}/${summary.total}`;
  if (summary.unknown) return `? ${summary.unknown}`;
  if (count("success")) return `✓ ${count("success")}/${summary.total}`;
  return `− ${summary.total}`;
}

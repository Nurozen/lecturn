// @effect-diagnostics globalDate:off -- UI activity timestamps use the device locale.
import type { OrchestrationMessage } from "@lecturn/contracts";
import type { EnvironmentThreadShell } from "./models.ts";

export type ActivityThreadContext = Pick<
  EnvironmentThreadShell,
  "title" | "session" | "hasPendingApprovals" | "hasPendingUserInput"
> &
  Partial<Pick<EnvironmentThreadShell, "planProgress" | "latestUserMessageAt">>;

/** Report evidence of progress/blocking; elapsed time alone never means stuck. */
export function describeThreadActivity(
  thread: ActivityThreadContext,
  messages: readonly Pick<OrchestrationMessage, "role" | "text" | "createdAt" | "updatedAt">[] = [],
): string {
  const latest = messages.findLast(
    (message) =>
      message.role === "assistant" &&
      message.text.trim().length > 0 &&
      (!thread.latestUserMessageAt || message.createdAt >= thread.latestUserMessageAt),
  );
  const blocker = thread.hasPendingApprovals
    ? "Waiting for your approval."
    : thread.hasPendingUserInput
      ? "Waiting for your answer."
      : thread.session?.status === "error"
        ? `Agent error: ${thread.session.lastError ?? "Open the thread for details."}`
        : thread.session?.status === "interrupted"
          ? "Agent interrupted."
          : null;
  const plan = thread.planProgress
    ? `Current step: ${thread.planProgress.step} (${thread.planProgress.completedSteps}/${thread.planProgress.totalSteps} complete)`
    : null;
  const progress = latest?.text.trim().replace(/\s+/g, " ").slice(0, 650);
  const observedAt = latest?.updatedAt ?? thread.session?.updatedAt;
  return [
    blocker,
    plan,
    progress
      ? `Latest response: ${progress}`
      : !plan
        ? `Task: ${thread.title}. No progress update yet.`
        : null,
    observedAt ? `Last update ${new Date(observedAt).toLocaleString()}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export type ActivityVisualState =
  | "active"
  | "attention"
  | "failed"
  | "complete"
  | "idle"
  | "offline";

/** Shared state language for native activity, web cards, and phone controls. */
export function activityVisualState(input: {
  status?: string | undefined;
  checks?: readonly { status: string }[] | undefined;
  settled?: boolean | undefined;
}): ActivityVisualState {
  const status = input.status ?? "";
  if (/offline|disconnected|unavailable/i.test(status)) return "offline";
  if (
    /approval|needs input|waiting for (your )?answer|blocked|action.required/i.test(status) ||
    input.checks?.some((c) => c.status === "action-required")
  )
    return "attention";
  if (/failed|failing|error/i.test(status) || input.checks?.some((c) => c.status === "failure"))
    return "failed";
  if (input.settled || /settled|merged|completed|\bdone\b/i.test(status)) return "complete";
  if (
    /working|running|starting|monitoring|sending|updating/i.test(status) ||
    input.checks?.some((c) => c.status === "pending")
  )
    return "active";
  return "idle";
}

export const activityVisualPresentation = {
  active: { label: "In progress", color: "#e6bc63", glyph: "◌" },
  attention: { label: "Needs attention", color: "#f0b34d", glyph: "!" },
  failed: { label: "Failed", color: "#f07868", glyph: "×" },
  complete: { label: "Complete", color: "#56c5a1", glyph: "✓" },
  idle: { label: "Idle", color: "#a6adb6", glyph: "•" },
  offline: { label: "Offline", color: "#a6adb6", glyph: "⊘" },
} as const satisfies Record<ActivityVisualState, { label: string; color: string; glyph: string }>;

/** Short evidence-based copy: never infer that silence means a blocked agent. */
export function threadActivityExcerpt(
  thread: ActivityThreadContext,
  messages: readonly Pick<OrchestrationMessage, "role" | "text" | "createdAt" | "updatedAt">[] = [],
): string {
  if (thread.hasPendingApprovals) return "Waiting for your approval";
  if (thread.hasPendingUserInput) return "Waiting for your answer";
  if (thread.session?.status === "error")
    return (thread.session.lastError ?? "Agent error").slice(0, 180);
  const latest = messages.findLast(
    (message) =>
      message.role === "assistant" &&
      message.text.trim() &&
      (!thread.latestUserMessageAt || message.createdAt >= thread.latestUserMessageAt),
  );
  const value =
    latest?.text ??
    thread.planProgress?.step ??
    (thread.session?.status === "interrupted" || thread.session?.status === "stopped"
      ? "Stopped"
      : "No task update yet");
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}

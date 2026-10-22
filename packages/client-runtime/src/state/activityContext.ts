// @effect-diagnostics globalDate:off -- UI activity timestamps use the device locale.
import * as DateTime from "effect/DateTime";

import type { EnvironmentThreadShell } from "./models.ts";

/** Plan step progress, when a caller has it (V2 shells do not carry it). */
export interface ActivityPlanProgress {
  readonly step: string;
  readonly completedSteps: number;
  readonly totalSteps: number;
}

export type ActivityThreadContext = Pick<
  EnvironmentThreadShell,
  "title" | "runtime" | "hasPendingApprovals" | "hasPendingUserInput"
> &
  Partial<Pick<EnvironmentThreadShell, "latestUserMessageAt">> & {
    readonly planProgress?: ActivityPlanProgress | null;
  };

/** V2 projection messages carry DateTime stamps; cached/test messages may carry ISO strings. */
type ActivityTimestamp = string | DateTime.DateTime;

export interface ActivityMessage {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly createdAt: ActivityTimestamp;
  readonly updatedAt: ActivityTimestamp;
}

function timestampMs(value: ActivityTimestamp): number {
  return typeof value === "string" ? Date.parse(value) : DateTime.toEpochMillis(value);
}

function latestCurrentTurnResponse(
  thread: ActivityThreadContext,
  messages: readonly ActivityMessage[],
): ActivityMessage | undefined {
  const turnStartedAt = thread.latestUserMessageAt ? Date.parse(thread.latestUserMessageAt) : null;
  return messages.findLast(
    (message) =>
      message.role === "assistant" &&
      message.text.trim().length > 0 &&
      (turnStartedAt === null || timestampMs(message.createdAt) >= turnStartedAt),
  );
}

/** Report evidence of progress/blocking; elapsed time alone never means stuck. */
export function describeThreadActivity(
  thread: ActivityThreadContext,
  messages: readonly ActivityMessage[] = [],
): string {
  const latest = latestCurrentTurnResponse(thread, messages);
  const runtime = thread.runtime;
  const blocker = thread.hasPendingApprovals
    ? "Waiting for your approval."
    : thread.hasPendingUserInput
      ? "Waiting for your answer."
      : runtime?.status === "failed"
        ? `Agent error: ${runtime.lastError ?? "Open the thread for details."}`
        : runtime?.status === "interrupted"
          ? "Agent interrupted."
          : null;
  const plan = thread.planProgress
    ? `Current step: ${thread.planProgress.step} (${thread.planProgress.completedSteps}/${thread.planProgress.totalSteps} complete)`
    : null;
  const progress = latest?.text.trim().replace(/\s+/g, " ").slice(0, 650);
  const observedAtMs =
    latest !== undefined
      ? timestampMs(latest.updatedAt)
      : runtime
        ? Date.parse(runtime.updatedAt)
        : null;
  return [
    blocker,
    plan,
    progress
      ? `Latest response: ${progress}`
      : !plan
        ? `Task: ${thread.title}. No progress update yet.`
        : null,
    observedAtMs !== null && Number.isFinite(observedAtMs)
      ? `Last update ${new Date(observedAtMs).toLocaleString()}`
      : null,
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

const lightActivityColors = {
  active: "#8a5b16",
  attention: "#925410",
  failed: "#b33f32",
  complete: "#24745b",
  idle: "#626873",
  offline: "#626873",
} as const satisfies Record<ActivityVisualState, string>;

/** Preserve state hues while keeping small indicators legible on light surfaces. */
export function activityVisualColor(
  state: ActivityVisualState,
  appearance: "light" | "dark",
): string {
  return appearance === "light"
    ? lightActivityColors[state]
    : activityVisualPresentation[state].color;
}

/** Short evidence-based copy: never infer that silence means a blocked agent. */
export function threadActivityExcerpt(
  thread: ActivityThreadContext,
  messages: readonly ActivityMessage[] = [],
): string {
  if (thread.hasPendingApprovals) return "Waiting for your approval";
  if (thread.hasPendingUserInput) return "Waiting for your answer";
  const runtime = thread.runtime;
  if (runtime?.status === "failed") return (runtime.lastError ?? "Agent error").slice(0, 180);
  const latest = latestCurrentTurnResponse(thread, messages);
  const value =
    latest?.text ??
    thread.planProgress?.step ??
    (runtime?.status === "interrupted" || runtime?.status === "cancelled"
      ? "Stopped"
      : "No task update yet");
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}

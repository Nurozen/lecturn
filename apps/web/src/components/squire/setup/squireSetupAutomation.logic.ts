import {
  SQUIRE_MAX_TRIGGERS,
  type SquireActionLogEntry,
  type SquireId,
  type SquireRole,
  type SquireTrigger,
  type SquireTriggerRun,
  type SquireTriggerSchedule,
  type SquireWebhookSecret,
} from "@lecturn/contracts";

// ── Schedules and intent sentences (P3.6, OQ27) ───────────────

/** `HH:MM` as the client's clock reads it: "9:00" on 24 h, "9:00 AM" on 12 h. */
function squireLocalTimeLabel(time: string, hour12: boolean): string {
  const [hourText = "0", minute = "00"] = time.split(":");
  const hour = Number(hourText);
  if (!hour12) return `${hour}:${minute}`;
  const period = hour < 12 ? "AM" : "PM";
  return `${hour % 12 === 0 ? 12 : hour % 12}:${minute} ${period}`;
}

export function squireScheduleSentence(schedule: SquireTriggerSchedule, hour12 = false): string {
  if (schedule.kind === "interval") {
    return schedule.hours === 1 ? "Every hour" : `Every ${schedule.hours} hours`;
  }
  const time = squireLocalTimeLabel(schedule.time, hour12);
  return `${schedule.weekdaysOnly ? "Weekdays" : "Daily"} at ${time}`;
}

/** A schedule reads as its slots; a webhook as the "When ..." sentence the user wrote. */
export function squireTriggerSentence(
  trigger: Pick<SquireTrigger, "kind" | "name" | "schedule">,
  hour12 = false,
): string {
  return trigger.kind === "schedule" && trigger.schedule !== null
    ? squireScheduleSentence(trigger.schedule, hour12)
    : trigger.name;
}

// ── Visible controls and the custom-webhook disclosure ────────

export type SquireTriggerControl =
  | "pause"
  | "resume"
  | "runs"
  | "advanced"
  | "url"
  | "secret"
  | "rotate"
  | "revoke"
  | "test";

/**
 * OQ27: a webhook's URL, secret, Rotate, Revoke, and Test now sit behind the collapsed
 * "Advanced: custom webhook" disclosure, never in the default view; a schedule's Test now is.
 */
export function squireTriggerControls(
  trigger: Pick<SquireTrigger, "kind" | "status">,
  advancedOpen: boolean,
): ReadonlyArray<SquireTriggerControl> {
  if (trigger.status === "revoked") return ["runs"];
  const status: SquireTriggerControl = trigger.status === "paused" ? "resume" : "pause";
  if (trigger.kind === "schedule") return [status, "test", "runs"];
  return advancedOpen
    ? [status, "runs", "advanced", "url", "secret", "rotate", "revoke", "test"]
    : [status, "runs", "advanced"];
}

/** Revoked triggers free their slot; the Lead has the sweep instead of triggers. */
export function squireCanAddTrigger(
  role: SquireRole,
  triggers: ReadonlyArray<Pick<SquireTrigger, "status">>,
): boolean {
  return (
    role !== "lead" &&
    triggers.filter((trigger) => trigger.status !== "revoked").length < SQUIRE_MAX_TRIGGERS
  );
}

/** Mirrors the server's hook route; the client joins it with the environment's origin. */
export function squireWebhookPath(triggerId: SquireTrigger["id"]): string {
  return `/api/squire/hooks/${triggerId}`;
}

// ── The one-time secret ───────────────────────────────────────

export interface SquireSecretReveal {
  readonly triggerId: SquireTrigger["id"];
  readonly triggerName: string;
  readonly reason: "created" | "rotated";
  readonly webhook: SquireWebhookSecret;
}

export type SquireSecretRevealAction =
  | {
      readonly type: "created";
      readonly trigger: Pick<SquireTrigger, "id" | "name">;
      readonly webhook: SquireWebhookSecret | null;
    }
  | {
      readonly type: "rotated";
      readonly trigger: Pick<SquireTrigger, "id" | "name">;
      readonly webhook: SquireWebhookSecret;
    }
  | { readonly type: "closed" }
  | { readonly type: "triggers-updated" };

/**
 * The secret lives only here, and only while its dialog is open. A later trigger list never
 * carries it, so nothing but a create or rotate result can bring it back.
 */
export function squireSecretRevealReducer(
  state: SquireSecretReveal | null,
  action: SquireSecretRevealAction,
): SquireSecretReveal | null {
  switch (action.type) {
    case "created":
      return action.webhook === null
        ? state
        : {
            triggerId: action.trigger.id,
            triggerName: action.trigger.name,
            reason: "created",
            webhook: action.webhook,
          };
    case "rotated":
      return {
        triggerId: action.trigger.id,
        triggerName: action.trigger.name,
        reason: "rotated",
        webhook: action.webhook,
      };
    case "closed":
      return null;
    case "triggers-updated":
      return state;
  }
}

// ── Runs, limits, and test results ────────────────────────────

const RUN_ORIGIN_LABELS: Partial<Record<SquireTriggerRun["origin"], string>> = {
  event: "Scheduled",
  webhook: "Webhook",
  test: "Test",
};

function runOutcomeLabel(run: Pick<SquireTriggerRun, "outcome" | "itemCount">): string {
  switch (run.outcome) {
    case "items-raised":
      return run.itemCount === 1 ? "1 item raised" : `${run.itemCount} items raised`;
    case "quiet":
      return "Quiet";
    case "rate-limited":
      return "Rate limited";
    case "failed":
      return "Failed";
    case "pending":
      return "Running";
    default:
      return "Unknown outcome";
  }
}

/** P3.6 run history row: time, origin, outcome, item count. */
export function squireTriggerRunLabel(
  run: SquireTriggerRun,
  formatTime: (iso: string) => string,
): string {
  const origin = RUN_ORIGIN_LABELS[run.origin] ?? run.origin;
  return `${formatTime(run.at)} · ${origin} · ${runOutcomeLabel(run)}`;
}

export function squireTriggerLimitText(
  trigger: Pick<SquireTrigger, "limitedUntil">,
  nowMs: number,
  formatTime: (iso: string) => string,
): string | null {
  if (trigger.limitedUntil === null) return null;
  return Date.parse(trigger.limitedUntil) > nowMs
    ? `limit reached until ${formatTime(trigger.limitedUntil)}`
    : null;
}

export function squireTriggerTestText(
  result: { readonly outcome: string; readonly retryAt: string | null },
  formatTime: (iso: string) => string,
): string {
  if (result.outcome === "queued") return "Test queued";
  if (result.outcome === "rate-limited") {
    return result.retryAt === null
      ? "limit reached"
      : `limit reached until ${formatTime(result.retryAt)}`;
  }
  return "Test sent";
}

// ── Add trigger ───────────────────────────────────────────────

export interface SquireTriggerDraft {
  readonly kind: "schedule" | "webhook";
  /** The webhook's "When ..." sentence; schedules read as their slots. */
  readonly name: string;
  readonly instruction: string;
  readonly scheduleKind: "interval" | "daily";
  readonly hours: number;
  readonly time: string;
  readonly weekdaysOnly: boolean;
}

export const EMPTY_SQUIRE_TRIGGER_DRAFT: SquireTriggerDraft = {
  kind: "schedule",
  name: "",
  instruction: "",
  scheduleKind: "daily",
  hours: 2,
  time: "09:00",
  weekdaysOnly: true,
};

const LOCAL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export type SquireTriggerDraftInput =
  | {
      readonly kind: "schedule";
      readonly squireId: SquireId;
      readonly name: string;
      readonly instruction: string;
      readonly schedule: SquireTriggerSchedule;
    }
  | {
      readonly kind: "webhook";
      readonly squireId: SquireId;
      readonly name: string;
      readonly instruction: string;
    };

/** The create input without its request id, or why it cannot be saved yet. */
export function squireTriggerDraftInput(
  draft: SquireTriggerDraft,
  squireId: SquireId,
): { readonly input: SquireTriggerDraftInput } | { readonly error: string } {
  const instruction = draft.instruction.trim();
  if (instruction === "") return { error: "Write the instruction the Squire receives." };
  if (instruction.length > 2000) return { error: "Keep the instruction under 2,000 characters." };
  if (draft.kind === "webhook") {
    const name = draft.name.trim();
    if (name === "") return { error: "Describe when this webhook fires." };
    if (name.length > 200) return { error: "Keep the sentence under 200 characters." };
    return { input: { kind: "webhook", squireId, name, instruction } };
  }
  let schedule: SquireTriggerSchedule;
  if (draft.scheduleKind === "interval") {
    if (!Number.isInteger(draft.hours) || draft.hours < 1) {
      return { error: "Run at most once an hour." };
    }
    schedule = { kind: "interval", hours: draft.hours };
  } else {
    if (!LOCAL_TIME.test(draft.time)) return { error: "Pick a time of day." };
    schedule = { kind: "daily", time: draft.time, weekdaysOnly: draft.weekdaysOnly };
  }
  return {
    input: {
      kind: "schedule",
      squireId,
      name: squireScheduleSentence(schedule),
      instruction,
      schedule,
    },
  };
}

// ── Sweep (P17.10) ────────────────────────────────────────────

const SQUIRE_SWEEP_ACCEPTANCE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Over the Lead's `sweep.finding` rows, each carrying `{ outcome, findingKey }`. */
export function squireSweepAcceptance(
  entries: ReadonlyArray<Pick<SquireActionLogEntry, "kind" | "data" | "createdAt">>,
  nowMs: number,
): { readonly accepted: number; readonly total: number } {
  const since = nowMs - SQUIRE_SWEEP_ACCEPTANCE_WINDOW_MS;
  let accepted = 0;
  let total = 0;
  for (const entry of entries) {
    if (entry.kind !== "sweep.finding" || Date.parse(entry.createdAt) < since) continue;
    const outcome = entry.data.outcome;
    if (outcome !== "accepted" && outcome !== "dismissed" && outcome !== "outdated") continue;
    total += 1;
    if (outcome === "accepted") accepted += 1;
  }
  return { accepted, total };
}

export function squireSweepAcceptanceText(rate: {
  readonly accepted: number;
  readonly total: number;
}): string {
  return rate.total === 0
    ? "No findings in the last 30 days"
    : `Accepted ${rate.accepted} of ${rate.total} in the last 30 days`;
}

export function squireLeadSweepOutcomeText(
  result: { readonly outcome: string; readonly retryAt: string | null },
  formatTime: (iso: string) => string,
): string {
  switch (result.outcome) {
    case "queued":
      return "Sweep queued";
    case "empty":
      return "Nothing to find";
    case "budget-reached":
      return result.retryAt === null
        ? "Sweep budget reached"
        : `Sweep budget reached until ${formatTime(result.retryAt)}`;
    case "paused":
      return "Paused: resume Squire automation to sweep";
    default:
      return "Sweep requested";
  }
}

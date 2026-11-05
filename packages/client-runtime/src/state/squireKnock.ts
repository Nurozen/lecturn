import type {
  EnvironmentId,
  ExecutionEnvironmentCapabilities,
  SquireCompanion,
  SquireKnockSettings,
} from "@lecturn/contracts";

// The "squire knocks" suggestion: a Squire offers to help a busy user while Squires are off.

/** Threads running at once on one environment before a Squire offers to help. */
export const SQUIRE_KNOCK_MIN_RUNNING = 2;

const SQUIRE_KNOCK_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

export const SQUIRE_KNOCK_TITLE = "You look busy. Can I help?";
export const SQUIRE_KNOCK_BODY =
  "Let me carry the shield while you swing. A Squire watches your threads and steps in when one needs you.";

export interface SquireKnockInput {
  readonly capabilities: Pick<ExecutionEnvironmentCapabilities, "squire" | "squireLiveSwitch">;
  readonly canWriteSettings: boolean;
  /** Null until the environment's settings load. */
  readonly knock: SquireKnockSettings | null;
  readonly runningThreadCount: number;
  readonly now: number;
}

/** True while the user has turned the suggestion away, for good or for now. */
export function squireKnockHidden(knock: SquireKnockSettings, now: number): boolean {
  if (knock.dismissed) return true;
  if (knock.snoozedUntil === "") return false;
  const until = Date.parse(knock.snoozedUntil);
  return Number.isFinite(until) && until > now;
}

/**
 * Only where a click turns Squires on at once: the server applies the switch live, Squires are
 * off, and this client may change the setting.
 */
export function shouldSquireKnock(input: SquireKnockInput): boolean {
  return (
    input.capabilities.squireLiveSwitch === true &&
    input.capabilities.squire !== true &&
    input.canWriteSettings &&
    input.knock !== null &&
    !squireKnockHidden(input.knock, input.now) &&
    input.runningThreadCount >= SQUIRE_KNOCK_MIN_RUNNING
  );
}

/** The `snoozedUntil` that "Not now" saves. */
export function squireKnockSnoozedUntil(now: number): string {
  // @effect-diagnostics-next-line globalDate:off
  return new Date(now + SQUIRE_KNOCK_SNOOZE_MS).toISOString();
}

export type SquireKnockPortrait = Pick<SquireCompanion, "appearance" | "hood" | "palette">;

const APPEARANCES = ["female", "male"] as const;
const HOODS = ["down", "up"] as const;
// Gold is the Lead's.
const PALETTES = ["brass", "moonstone", "sage", "rose"] as const;

const pick = <A>(values: ReadonlyArray<A>, random: () => number): A =>
  values[Math.min(values.length - 1, Math.floor(random() * values.length))]!;

/** A different Squire knocks each time. */
export function randomSquireKnockPortrait(random: () => number = Math.random): SquireKnockPortrait {
  return {
    appearance: pick(APPEARANCES, random),
    hood: pick(HOODS, random),
    palette: pick(PALETTES, random),
  };
}

/** At most one knock per environment per app session, whatever the user does with it. */
export function createSquireKnockSession() {
  const knocked = new Set<EnvironmentId>();
  return {
    /** True the first time; the caller shows the suggestion then. */
    claim(environmentId: EnvironmentId): boolean {
      if (knocked.has(environmentId)) return false;
      knocked.add(environmentId);
      return true;
    },
    /** After "Show again" in settings, so the reset is not held back until the next session. */
    release(environmentId: EnvironmentId): void {
      knocked.delete(environmentId);
    },
  };
}

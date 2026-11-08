import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  ForwardCompatibleLiteral,
  ForwardCompatibleUnion,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  SquireCardId,
  SquireId,
  SquireRoomPostId,
  SquireRoomId,
  SquireRuleId,
  SquireTaskId,
  SquireTriggerId,
  SquireVoiceNoteId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  OrchestrationV2Actor,
  OrchestrationV2RunStatus,
  OrchestrationV2UserInputQuestion,
} from "./orchestrationV2.ts";
import {
  ProviderApprovalDecision,
  ProviderApprovalOption,
  ProviderUserInputAnswers,
} from "./providerPolicy.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

const text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const nonEmptyText = (max: number) => TrimmedNonEmptyString.check(Schema.isMaxLength(max));
const maxItems = <S extends Schema.Top>(item: S, max: number) =>
  Schema.Array(item).check(Schema.isMaxLength(max));
const RequestId = nonEmptyText(200);
const LocalTime = Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/));
const LocalDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/));
const defaulted = <S extends Schema.Top>(schema: S, value: S["Encoded"]) =>
  schema.pipe(Schema.withDecodingDefault(Effect.succeed(value)));

// ── Shared vocabulary ─────────────────────────────────────────

export const SquirePalette = Schema.Literals(["brass", "moonstone", "sage", "rose", "gold"]);
export type SquirePalette = typeof SquirePalette.Type;

export const SquireCardKind = Schema.Literals(["steer", "question", "overlap", "proposal", "fyi"]);
export type SquireCardKind = typeof SquireCardKind.Type;

export const SquireRole = Schema.Literals(["lead", "squire"]);
export type SquireRole = typeof SquireRole.Type;

export const SquireStatus = Schema.Literals(["active", "paused"]);
export type SquireStatus = typeof SquireStatus.Type;

export const SquireLifecycle = ForwardCompatibleLiteral(
  ["creating", "ready", "rehoming", "deleting", "needs_provider"],
  "unknown",
);
export type SquireLifecycle = typeof SquireLifecycle.Type;

/** Squire-dispatched turn origins, read from the `message:squire:<origin>:` id prefix. */
export const SquireTurnOrigin = ForwardCompatibleLiteral(
  ["event", "voice", "webhook", "test", "sweep", "message", "room", "lead"],
  "unknown",
);
export type SquireTurnOrigin = typeof SquireTurnOrigin.Type;

/** A card also records `user` when the user raised it, e.g. by pressing Undo. */
export const SquireCardOrigin = ForwardCompatibleLiteral(
  ["event", "voice", "webhook", "test", "sweep", "message", "room", "lead", "user"],
  "unknown",
);
export type SquireCardOrigin = typeof SquireCardOrigin.Type;

/** The Squire's own label; `other` never matches a rule, so an unknown kind falls back to it. */
export const SquireSteerKind = ForwardCompatibleLiteral(
  ["rebase", "rerun-checks", "fix-failing-check", "address-review", "continue", "other"],
  "other",
);
export type SquireSteerKind = typeof SquireSteerKind.Type;

export const SquirePermissionLevel = Schema.Literals(["off", "recommend", "auto"]);
export type SquirePermissionLevel = typeof SquirePermissionLevel.Type;
export const SquireNotifyLevel = Schema.Literals(["off", "on"]);
export type SquireNotifyLevel = typeof SquireNotifyLevel.Type;

// ── Scope ─────────────────────────────────────────────────────

export const SquireGrantKind = Schema.Literals([
  "thread",
  "project",
  "staveSpace",
  "staveSaga",
  "exclusion",
]);
export type SquireGrantKind = typeof SquireGrantKind.Type;

export const SquireGrantInput = Schema.Struct({
  kind: SquireGrantKind,
  targetId: TrimmedNonEmptyString,
});
export type SquireGrantInput = typeof SquireGrantInput.Type;

export const SquireGrant = Schema.Struct({
  ...SquireGrantInput.fields,
  /** `created` labels a thread the Squire launched itself ("created by Squire · <name>"). */
  origin: Schema.Literals(["granted", "created"]),
  createdAt: IsoDateTime,
});
export type SquireGrant = typeof SquireGrant.Type;

// ── Config ────────────────────────────────────────────────────

const squirePermissionsStruct = Schema.Struct({
  steer: defaulted(SquirePermissionLevel, "recommend"),
  createThread: defaulted(SquirePermissionLevel, "recommend"),
  notify: defaulted(SquireNotifyLevel, "on"),
  /** Lead only; absent on every other Squire. */
  manageSquires: Schema.optionalKey(SquirePermissionLevel),
});
export const SquirePermissions = squirePermissionsStruct.pipe(
  Schema.withDecodingDefault(Effect.succeed({})),
);
export type SquirePermissions = typeof SquirePermissions.Type;
export const DEFAULT_SQUIRE_PERMISSIONS = Schema.decodeSync(SquirePermissions)({});
export const DEFAULT_LEAD_SQUIRE_PERMISSIONS: SquirePermissions = {
  ...DEFAULT_SQUIRE_PERMISSIONS,
  manageSquires: "recommend",
};

const squireBudgetsStruct = Schema.Struct({
  steersPerDay: defaulted(NonNegativeInt, 10),
  threadsPerDay: defaulted(NonNegativeInt, 3),
  steersPerThreadPerHour: defaulted(NonNegativeInt, 2),
  /** The Lead's default is {@link DEFAULT_LEAD_MESSAGES_PER_DAY}. */
  messagesPerDay: defaulted(NonNegativeInt, 20),
  roomPostsPerRoomPerDay: defaulted(NonNegativeInt, 30),
});
export const SquireBudgets = squireBudgetsStruct.pipe(
  Schema.withDecodingDefault(Effect.succeed({})),
);
export type SquireBudgets = typeof SquireBudgets.Type;
export const DEFAULT_SQUIRE_BUDGETS = Schema.decodeSync(SquireBudgets)({});
export const DEFAULT_LEAD_MESSAGES_PER_DAY = 40;

const squireEventTogglesStruct = Schema.Struct({
  turnFinished: defaulted(Schema.Boolean, true),
  threadStopped: defaulted(Schema.Boolean, true),
  waitingOnUser: defaulted(Schema.Boolean, true),
  pullRequestChanged: defaulted(Schema.Boolean, true),
  waitingThresholdMinutes: defaulted(PositiveInt, 30),
});
export const SquireEventToggles = squireEventTogglesStruct.pipe(
  Schema.withDecodingDefault(Effect.succeed({})),
);
export type SquireEventToggles = typeof SquireEventToggles.Type;

export const SQUIRE_UNDO_WINDOW_MAX_SECONDS = 60;
export const SquireUndoWindowSeconds = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: SQUIRE_UNDO_WINDOW_MAX_SECONDS }),
);

/** In the Lead's `timezone`, which lives on the record so it exists while the digest is off. */
export const SquireDigest = Schema.Struct({
  time: LocalTime,
  push: defaulted(Schema.Boolean, false),
});
export type SquireDigest = typeof SquireDigest.Type;

export const SquireSweepSchedule = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("off") }),
  /** At the digest time. */
  Schema.Struct({ kind: Schema.Literal("daily") }),
  Schema.Struct({
    kind: Schema.Literal("interval"),
    hours: Schema.Int.check(Schema.isGreaterThanOrEqualTo(4)),
  }),
]);
export type SquireSweepSchedule = typeof SquireSweepSchedule.Type;

const squireSweepSettingsStruct = Schema.Struct({
  schedule: defaulted(SquireSweepSchedule, { kind: "daily" }),
  sweepsPerDay: defaulted(NonNegativeInt, 4),
  findingsPerSweep: defaulted(NonNegativeInt, 3),
  findingsPerDay: defaulted(NonNegativeInt, 6),
});
export const SquireSweepSettings = squireSweepSettingsStruct.pipe(
  Schema.withDecodingDefault(Effect.succeed({})),
);
export type SquireSweepSettings = typeof SquireSweepSettings.Type;

// ── Companion ─────────────────────────────────────────────────
// Only the persisted keys of the v5 exported appearance; runtime keys are stripped on decode and
// an unknown value reads as the default, so a newer client's choice never fails an older
// client's snapshot.

const companionField = <const L extends ReadonlyArray<string>, const D extends L[number]>(
  literals: L,
  fallback: D,
) => defaulted(ForwardCompatibleLiteral(literals, fallback), fallback);

const squireCompanionStruct = Schema.Struct({
  /** v5 writes `"companion"` for the figure, which this fallback absorbs. */
  presence: companionField(["figure", "emblem"], "figure"),
  appearance: companionField(["female", "male"], "female"),
  hood: companionField(["down", "up"], "down"),
  equipment: companionField(
    ["helmet", "lance", "astrolabe", "grimoire", "armillary", "none"],
    "helmet",
  ),
  palette: companionField(SquirePalette.literals, "brass"),
  frame: companionField(["bare", "orbit", "seal"], "orbit"),
  weight: companionField(["regular", "fine", "bold"], "regular"),
  glow: companionField(["soft", "bright", "none"], "soft"),
  motion: companionField(["subtle", "lively", "still"], "subtle"),
});
export const SquireCompanion = squireCompanionStruct.pipe(
  Schema.withDecodingDefault(Effect.succeed({})),
);
export type SquireCompanion = typeof SquireCompanion.Type;
/** For an optional companion key: absent stays absent instead of decoding to the default. */
export const SquireCompanionStruct = squireCompanionStruct;
export const DEFAULT_SQUIRE_COMPANION = Schema.decodeSync(SquireCompanion)({});

const notGold = Schema.makeFilter(
  (companion: SquireCompanion) => companion.palette !== "gold" || "gold is reserved for the Lead",
);
/** A companion a user or the Lead picks for a new Squire: gold is the Lead's alone. */
export const SquireCompanionChoice = SquireCompanion.check(notGold);
// Without the whole-struct default, so an absent create companion stays absent
// and the server can pick a distinct one.
const squireCompanionChoiceStruct = squireCompanionStruct.check(notGold);
/** For an optional choice key, as `SquireCompanionStruct` is for a companion. */
export const SquireCompanionChoiceStruct = squireCompanionChoiceStruct;

/**
 * The Lead's own figure: gold, and the armillary sphere no other default
 * holds, so the leader reads apart from every Squire at panel size.
 */
export const SQUIRE_LEAD_COMPANION: SquireCompanion = {
  ...DEFAULT_SQUIRE_COMPANION,
  palette: "gold",
  equipment: "armillary",
};

const DISTINCT_LOOKS = [
  ["female", "down"],
  ["male", "down"],
  ["female", "up"],
  ["male", "up"],
] as const;
const DISTINCT_PALETTES = ["brass", "moonstone", "sage", "rose"] as const;
const DISTINCT_EQUIPMENT = ["helmet", "lance", "astrolabe", "grimoire", "armillary"] as const;
const lookKey = (companion: Pick<SquireCompanion, "appearance" | "hood">) =>
  `${companion.appearance}/${companion.hood}`;
/** Appearance, hood, and palette: what tells two Squires apart at sidebar size. */
export const squireCompanionLookKey = (companion: SquireCompanion) =>
  `${lookKey(companion)}/${companion.palette}`;

/**
 * What `taken` holds once the Lead is counted: gold is the Lead's alone, so
 * without a gold companion the Lead is still to come, with its default look.
 * Brass reads as the Lead's gold at row size, so it is taken with it, and the
 * Lead's equipment is never another Squire's.
 */
const takenLooks = (taken: ReadonlyArray<SquireCompanion>) => {
  const lead = taken.find((companion) => companion.palette === "gold") ?? SQUIRE_LEAD_COMPANION;
  const all = taken.includes(lead) ? taken : [...taken, lead];
  const palettes = new Set<string>(all.map((companion) => companion.palette));
  palettes.add("brass");
  return {
    all,
    leadEquipment: lead.equipment,
    looks: new Set(all.map(lookKey)),
    palettes,
    triples: new Set(all.map(squireCompanionLookKey)),
  };
};

/** The first equipment no companion holds, else the first that is not the Lead's. */
const freeEquipment = (
  all: ReadonlyArray<SquireCompanion>,
  leadEquipment: SquireCompanion["equipment"],
): SquireCompanion["equipment"] => {
  const held = new Set<string>(all.map((companion) => companion.equipment));
  const open = DISTINCT_EQUIPMENT.filter((tool) => tool !== leadEquipment);
  return open.find((tool) => !held.has(tool)) ?? open[0] ?? "none";
};

/**
 * The companion a new Squire gets when none was chosen, distinct from `taken` (every other Squire;
 * the Lead counts even before it exists): a free appearance and hood, then a free palette (never
 * the Lead's gold, brass only when nothing else is free), then free equipment (never the Lead's).
 * Ties keep `base`'s own look, palette, and equipment; its other keys stay.
 */
export const squireDistinctCompanion = (
  taken: ReadonlyArray<SquireCompanion>,
  base: SquireCompanion = DEFAULT_SQUIRE_COMPANION,
): SquireCompanion => {
  const { all, leadEquipment, looks, palettes, triples } = takenLooks(taken);
  const equipment = new Set<string>(all.map((companion) => companion.equipment));
  const full = new Set(
    all.map((companion) => `${squireCompanionLookKey(companion)}/${companion.equipment}`),
  );
  let best = base;
  let bestScore = -1;
  for (const [appearance, hood] of DISTINCT_LOOKS) {
    for (const palette of DISTINCT_PALETTES) {
      for (const tool of DISTINCT_EQUIPMENT) {
        if (tool === leadEquipment) continue;
        const look = `${appearance}/${hood}`;
        const triple = `${look}/${palette}`;
        const score =
          (looks.has(look) ? 0 : 256) +
          (palettes.has(palette) ? 0 : 128) +
          (triples.has(triple) ? 0 : 64) +
          (equipment.has(tool) ? 0 : 32) +
          (full.has(`${triple}/${tool}`) ? 0 : 16) +
          (look === lookKey(base) ? 4 : 0) +
          (palette === base.palette ? 2 : 0) +
          (tool === base.equipment ? 1 : 0);
        if (score <= bestScore) continue;
        bestScore = score;
        best = { ...base, appearance, hood, palette, equipment: tool };
      }
    }
  }
  return best;
};

/**
 * A chosen companion (the Lead's proposal) against `taken`, as `squireDistinctCompanion` counts
 * it: it stands while its appearance and hood are free (or none is and its full look is) and its
 * palette is not gold or brass; otherwise it moves to a free look, keeping what it can. The Lead's
 * equipment is never kept: a look that stands only trades it for free equipment.
 */
export const squireDistinctChoice = (
  taken: ReadonlyArray<SquireCompanion>,
  chosen: SquireCompanion,
): SquireCompanion => {
  const { all, leadEquipment, looks, triples } = takenLooks(taken);
  const anyFree = DISTINCT_LOOKS.some(([appearance, hood]) => !looks.has(`${appearance}/${hood}`));
  const lookOk = anyFree
    ? !looks.has(lookKey(chosen))
    : !triples.has(squireCompanionLookKey(chosen));
  const paletteOk = chosen.palette !== "gold" && chosen.palette !== "brass";
  if (!lookOk || !paletteOk) return squireDistinctCompanion(taken, chosen);
  return chosen.equipment === leadEquipment
    ? { ...chosen, equipment: freeEquipment(all, leadEquipment) }
    : chosen;
};

// ── Record ────────────────────────────────────────────────────

export const Squire = Schema.Struct({
  id: SquireId,
  role: SquireRole,
  name: nonEmptyText(80),
  lifecycle: SquireLifecycle,
  status: SquireStatus,
  homeProjectId: ProjectId,
  /** Null only while `lifecycle` is `needs_provider`. */
  homeThreadId: Schema.NullOr(ThreadId),
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  modelSelection: Schema.NullOr(ModelSelection),
  summaryModelSelection: Schema.NullOr(ModelSelection),
  brief: text(4000),
  grants: Schema.Array(SquireGrant),
  events: SquireEventToggles,
  permissions: SquirePermissions,
  budgets: SquireBudgets,
  undoWindowSeconds: SquireUndoWindowSeconds,
  companion: SquireCompanion,
  /** Lead only. */
  digest: Schema.NullOr(SquireDigest),
  /** Lead only. */
  sweep: Schema.NullOr(SquireSweepSettings),
  onboardedAt: Schema.NullOr(IsoDateTime),
  /** Lead only (IANA): the zone of the digest and daily trigger times; absent until a client reports it. */
  timezone: Schema.optionalKey(TrimmedNonEmptyString),
  /** Lead only: set when the inactivity pause stopped triggers and the sweep. */
  automationPausedAt: Schema.NullOr(IsoDateTime),
  revision: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Squire = typeof Squire.Type;

// ── Rules ─────────────────────────────────────────────────────

export const SquireRuleEffect = Schema.Literals(["allow", "ask-first"]);
export type SquireRuleEffect = typeof SquireRuleEffect.Type;
export const SquireRuleActionClass = Schema.Literals(["steer", "createThread"]);
export type SquireRuleActionClass = typeof SquireRuleActionClass.Type;
export const SquireRuleTargetKind = Schema.Literals([
  "thread",
  "project",
  "staveSpace",
  "staveSaga",
]);
export type SquireRuleTargetKind = typeof SquireRuleTargetKind.Type;
export const SQUIRE_MAX_ALLOW_RULES = 10;
export const SQUIRE_MAX_ASK_FIRST_RULES = 20;

export const SquireRule = Schema.Struct({
  id: SquireRuleId,
  squireId: SquireId,
  effect: SquireRuleEffect,
  actionClass: SquireRuleActionClass,
  targetKind: SquireRuleTargetKind,
  targetId: TrimmedNonEmptyString,
  /** Steer rules only. */
  steerKind: Schema.NullOr(SquireSteerKind),
  /** `disabled` once the target leaves the Squire's scope. */
  status: Schema.Literals(["active", "disabled"]),
  matchCount: NonNegativeInt,
  lastMatchedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
});
export type SquireRule = typeof SquireRule.Type;

export const SQUIRE_RULE_LIMIT_TEXT = "Rule limit reached; remove one in setup";

/**
 * "Always allow this" (after an accept) or "Always ask first for this"
 * (after an Undo), prefilled from the card. Saving it is `squire.rule.create`
 * with these fields. At the cap `text` is the limit message and nothing can
 * be saved.
 */
export const SquireRuleOffer = Schema.Struct({
  effect: SquireRuleEffect,
  actionClass: SquireRuleActionClass,
  targetKind: SquireRuleTargetKind,
  targetId: TrimmedNonEmptyString,
  steerKind: Schema.optionalKey(SquireSteerKind),
  /** The exact rule text, e.g. "Release may auto-send rebase steers on threads in billing-service". */
  text: Schema.String,
  /** The target thread's granted container, the one other target offered. */
  alternative: Schema.optionalKey(
    Schema.Struct({
      targetKind: SquireRuleTargetKind,
      targetId: TrimmedNonEmptyString,
      text: Schema.String,
    }),
  ),
  capReached: Schema.Boolean,
});
export type SquireRuleOffer = typeof SquireRuleOffer.Type;

// ── Triggers ──────────────────────────────────────────────────

export const SQUIRE_MAX_TRIGGERS = 5;

export const SquireTriggerSchedule = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("interval"),
    hours: PositiveInt,
  }),
  /** In the Lead's timezone. */
  Schema.Struct({
    kind: Schema.Literal("daily"),
    time: LocalTime,
    weekdaysOnly: defaulted(Schema.Boolean, false),
  }),
]);
export type SquireTriggerSchedule = typeof SquireTriggerSchedule.Type;

export const SquireTriggerKind = Schema.Literals(["schedule", "webhook"]);
export type SquireTriggerKind = typeof SquireTriggerKind.Type;
export const SquireTriggerStatus = Schema.Literals(["active", "paused", "revoked"]);
export type SquireTriggerStatus = typeof SquireTriggerStatus.Type;

/** Never carries the webhook secret; only create and rotate results do, once. */
export const SquireTrigger = Schema.Struct({
  id: SquireTriggerId,
  squireId: SquireId,
  /** For a webhook, the user-written intent sentence. */
  name: nonEmptyText(200),
  kind: SquireTriggerKind,
  instruction: nonEmptyText(2000),
  status: SquireTriggerStatus,
  schedule: Schema.NullOr(SquireTriggerSchedule),
  nextSlotAt: Schema.NullOr(IsoDateTime),
  secretGeneration: NonNegativeInt,
  /** Set while a run limit holds; the setup sheet shows "limit reached until <time>". */
  limitedUntil: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
});
export type SquireTrigger = typeof SquireTrigger.Type;

export const SquireWebhookSecret = Schema.Struct({
  secret: TrimmedNonEmptyString,
  /** Origin-relative, so the client joins it with whatever origin it reached the server on. */
  path: TrimmedNonEmptyString,
});
export type SquireWebhookSecret = typeof SquireWebhookSecret.Type;

export const SquireTriggerRun = Schema.Struct({
  at: IsoDateTime,
  origin: SquireTurnOrigin,
  outcome: ForwardCompatibleLiteral(
    ["items-raised", "quiet", "rate-limited", "failed", "pending"],
    "unknown",
  ),
  itemCount: NonNegativeInt,
});
export type SquireTriggerRun = typeof SquireTriggerRun.Type;

// ── Summary ───────────────────────────────────────────────────

export const SQUIRE_SUMMARY_MAX_CHARS = 1200;

export const SquireTurnOutcome = Schema.Literals([
  "finished",
  "stopped",
  "error",
  "waiting-on-approval",
  "waiting-on-input",
]);
export type SquireTurnOutcome = typeof SquireTurnOutcome.Type;
export const SquireSummaryStatus = Schema.Literals(["complete", "partial"]);
export type SquireSummaryStatus = typeof SquireSummaryStatus.Type;
export const SquireFileChange = Schema.Literals(["added", "modified", "deleted"]);
export type SquireFileChange = typeof SquireFileChange.Type;

export const SquireFileEntry = Schema.Struct({
  /** Repo-relative. */
  path: TrimmedNonEmptyString,
  change: SquireFileChange,
});
export type SquireFileEntry = typeof SquireFileEntry.Type;

export const SquireCommandEntry = Schema.Struct({
  command: TrimmedNonEmptyString,
  exitCode: Schema.Int,
  pass: Schema.Boolean,
});
export type SquireCommandEntry = typeof SquireCommandEntry.Type;

export const SquireBlockedEntry = Schema.Struct({
  item: TrimmedNonEmptyString,
  reason: TrimmedNonEmptyString,
});
export type SquireBlockedEntry = typeof SquireBlockedEntry.Type;

export const SquirePullRequestReview = Schema.Literals([
  "approved",
  "changes-requested",
  "review-required",
  "none",
]);
export const SquirePullRequestMergeable = Schema.Literals([
  "mergeable",
  "blocked-by-checks",
  "blocked-by-review",
  "conflicts",
]);

export const SquirePullRequestSnapshot = Schema.Struct({
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  headSha: TrimmedNonEmptyString,
  /** The changed field and its new value, e.g. `checks:failed` or `merged`. */
  transition: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  checks: Schema.Struct({
    passed: NonNegativeInt,
    failed: NonNegativeInt,
    failingJobs: Schema.Array(TrimmedNonEmptyString),
  }),
  review: SquirePullRequestReview,
  /** Null when unknown. */
  mergeable: Schema.NullOr(SquirePullRequestMergeable),
  merged: Schema.Boolean,
  closed: Schema.Boolean,
});
export type SquirePullRequestSnapshot = typeof SquirePullRequestSnapshot.Type;

const SquireModelWrittenFields = {
  goal: Schema.String,
  completed: maxItems(Schema.String, 5),
  remaining: maxItems(Schema.String, 3),
  blocked: maxItems(SquireBlockedEntry, 3),
  pendingQuestion: Schema.NullOr(Schema.String),
  suggestedNextStep: Schema.NullOr(Schema.String),
};

/** The only fields the summary model writes; everything else is deterministic. */
export const SquireSummaryModelOutput = Schema.Struct(SquireModelWrittenFields);
export type SquireSummaryModelOutput = typeof SquireSummaryModelOutput.Type;

export const SquireTurnSummary = Schema.Struct({
  threadId: ThreadId,
  threadTitle: Schema.String,
  /** Project name, as shown. */
  project: Schema.String,
  /** Repository identity for multi-repo spaces; never rendered. */
  projectId: Schema.optionalKey(ProjectId),
  provider: ProviderDriverKind,
  /** Keeps the canonical key name; holds the run id. */
  turnId: RunId,
  outcome: SquireTurnOutcome,
  summaryStatus: SquireSummaryStatus,
  ...SquireModelWrittenFields,
  files: Schema.Struct({
    entries: maxItems(SquireFileEntry, 10),
    counts: Schema.Struct({
      added: NonNegativeInt,
      modified: NonNegativeInt,
      deleted: NonNegativeInt,
    }),
  }),
  commands: maxItems(SquireCommandEntry, 5),
  pullRequest: Schema.NullOr(SquirePullRequestSnapshot),
});
export type SquireTurnSummary = typeof SquireTurnSummary.Type;

export const SquireStoredSummary = Schema.Struct({
  threadId: ThreadId,
  runId: RunId,
  /** `terminal`, or `request:<requestId>` for a provisional summary taken while waiting. */
  stage: TrimmedNonEmptyString,
  status: Schema.Literals(["generating", "complete", "partial"]),
  summary: Schema.NullOr(SquireTurnSummary),
  updatedAt: IsoDateTime,
});
export type SquireStoredSummary = typeof SquireStoredSummary.Type;

const SquireSummaryPathCall = (kind: "read" | "edit" | "create" | "delete") =>
  Schema.Struct({
    kind: Schema.Literal(kind),
    path: TrimmedNonEmptyString,
    note: Schema.optionalKey(Schema.String),
  });

/** The summary builder's one input type; live orchestration state is converted into it. */
export const SquireSummaryInput = Schema.Struct({
  thread: Schema.Struct({
    threadId: ThreadId,
    title: Schema.String,
    project: Schema.String,
    projectId: Schema.optionalKey(ProjectId),
    provider: ProviderDriverKind,
  }),
  turnId: RunId,
  session: Schema.Struct({
    status: OrchestrationV2RunStatus,
    pendingRuntimeRequest: Schema.NullOr(
      Schema.Struct({
        /** A runtime request kind, or `secret` for a pending secret request. */
        kind: TrimmedNonEmptyString,
        requestId: TrimmedNonEmptyString,
        question: Schema.NullOr(Schema.String),
      }),
    ),
    /** Who interrupted or cancelled the run; null when it was not interrupted. */
    interruptedBy: Schema.NullOr(OrchestrationV2Actor),
  }),
  messages: Schema.Array(
    Schema.Struct({
      role: Schema.Literals(["user", "assistant"]),
      text: Schema.String,
      final: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  toolCalls: Schema.Array(
    Schema.Union([
      SquireSummaryPathCall("read"),
      SquireSummaryPathCall("edit"),
      SquireSummaryPathCall("create"),
      SquireSummaryPathCall("delete"),
      Schema.Struct({
        kind: Schema.Literal("command"),
        command: TrimmedNonEmptyString,
        exitCode: Schema.NullOr(Schema.Int),
        note: Schema.optionalKey(Schema.String),
      }),
      Schema.Struct({
        kind: Schema.Literal("other"),
        name: TrimmedNonEmptyString,
        note: Schema.optionalKey(Schema.String),
      }),
    ]),
  ),
  files: Schema.Array(SquireFileEntry),
  diffStats: Schema.Struct({
    added: NonNegativeInt,
    modified: NonNegativeInt,
    deleted: NonNegativeInt,
    insertions: NonNegativeInt,
    deletions: NonNegativeInt,
  }),
  pullRequest: Schema.NullOr(SquirePullRequestSnapshot),
});
export type SquireSummaryInput = typeof SquireSummaryInput.Type;

// ── Evidence ──────────────────────────────────────────────────

export const SquireDiffStats = Schema.Struct({
  insertions: NonNegativeInt,
  deletions: NonNegativeInt,
  files: NonNegativeInt,
});
export type SquireDiffStats = typeof SquireDiffStats.Type;

export const SquireAnswerOption = Schema.Struct({
  label: TrimmedNonEmptyString,
  description: Schema.optionalKey(Schema.String),
});
export type SquireAnswerOption = typeof SquireAnswerOption.Type;

export const SquireCiLog = Schema.Struct({
  status: ForwardCompatibleLiteral(["annotations", "log", "unavailable"], "unknown"),
  headSha: TrimmedNonEmptyString,
  jobs: maxItems(Schema.Struct({ name: Schema.String, url: Schema.NullOr(Schema.String) }), 2),
  /** A log was read only up to its byte bound. */
  truncated: Schema.Boolean,
});
export type SquireCiLog = typeof SquireCiLog.Type;

/** Stored on the event and the card, never in the summary, so the summary cap holds. */
export const SquireEvidence = Schema.Struct({
  /** The first lines of the failing job's log. */
  errorLines: Schema.optionalKey(maxItems(Schema.String, 5)),
  headBranch: Schema.optionalKey(TrimmedNonEmptyString),
  diffStats: Schema.optionalKey(SquireDiffStats),
  pendingRequest: Schema.optionalKey(
    Schema.Struct({
      question: TrimmedNonEmptyString,
      options: Schema.Array(SquireAnswerOption),
    }),
  ),
  /** The exact text the "Why" quotes. */
  triggerText: Schema.optionalKey(Schema.String),
  pullRequest: Schema.optionalKey(SquirePullRequestSnapshot),
  /** Where `errorLines` came from, or `unavailable` with the checks to link instead. */
  ciLog: Schema.optionalKey(SquireCiLog),
});
export type SquireEvidence = typeof SquireEvidence.Type;

// ── References and participants ───────────────────────────────

export const SQUIRE_MESSAGE_MAX_CHARS = 2000;

export const SquireRef = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("thread"), threadId: ThreadId }),
  Schema.Struct({
    kind: Schema.Literal("pullRequest"),
    number: PositiveInt,
    repository: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  Schema.Struct({ kind: Schema.Literal("project"), projectId: ProjectId }),
  Schema.Struct({ kind: Schema.Literal("item"), cardId: SquireCardId }),
]);
export type SquireRef = typeof SquireRef.Type;

export const SquireParticipant = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("squire"), squireId: SquireId }),
  Schema.Struct({ kind: Schema.Literal("lead"), squireId: SquireId }),
  Schema.Struct({ kind: Schema.Literal("user") }),
  Schema.Struct({ kind: Schema.Literal("system") }),
]);
export type SquireParticipant = typeof SquireParticipant.Type;

// ── Events ────────────────────────────────────────────────────

export const SquireSweepCandidate = Schema.Struct({
  threadId: ThreadId,
  kind: ForwardCompatibleLiteral(["idle-unmerged-pr", "failing-checks-no-turn"], "unknown"),
  pullRequestNumber: Schema.NullOr(PositiveInt),
  headSha: Schema.NullOr(TrimmedNonEmptyString),
});
export type SquireSweepCandidate = typeof SquireSweepCandidate.Type;

export const SQUIRE_DIGEST_MAX_SQUIRES = 12;
export const SQUIRE_DIGEST_MAX_LINES = 5;

/** One digest line; the ids are its links. */
export const SquireDigestLine = Schema.Struct({
  text: text(200),
  threadId: Schema.NullOr(ThreadId),
  cardId: Schema.NullOr(SquireCardId),
});
export type SquireDigestLine = typeof SquireDigestLine.Type;

const digestLines = maxItems(SquireDigestLine, SQUIRE_DIGEST_MAX_LINES);
const digestUsage = Schema.Struct({ used: NonNegativeInt, limit: NonNegativeInt });

/**
 * Built by the server from stored items, summaries, and the action log
 * over the last 24 h, never from transcripts, and bounded so the digest turn
 * stays small.
 */
export const SquireDigestInput = Schema.Struct({
  since: IsoDateTime,
  squires: maxItems(
    Schema.Struct({
      squireId: SquireId,
      name: Schema.String,
      status: SquireStatus,
      moved: digestLines,
      blocked: digestLines,
      waiting: digestLines,
      /** Auto actions that executed without the user's accept. */
      onItsOwn: digestLines,
      budget: Schema.Struct({ steers: digestUsage, threads: digestUsage }),
    }),
    SQUIRE_DIGEST_MAX_SQUIRES,
  ),
  /** Sweep findings over the last 30 days. */
  sweep: Schema.Struct({ accepted: NonNegativeInt, total: NonNegativeInt }),
});
export type SquireDigestInput = typeof SquireDigestInput.Type;

export const SQUIRE_ONBOARDING_MAX_PROJECTS = 20;
export const SQUIRE_ONBOARDING_MAX_THREADS = 8;

/**
 * The Lead's first-run scan: metadata and stored summary headlines
 * only, never transcripts, bounded so one onboarding turn stays small.
 */
export const SquireOnboardingContext = Schema.Struct({
  projects: maxItems(
    Schema.Struct({
      projectId: ProjectId,
      name: text(200),
      /** The Stave space the project belongs to, when it has one. */
      staveSpaceId: Schema.optionalKey(TrimmedNonEmptyString),
      lastActivityAt: Schema.NullOr(IsoDateTime),
      threadCount: NonNegativeInt,
      threads: maxItems(
        Schema.Struct({
          threadId: ThreadId,
          title: text(200),
          status: text(40),
          lastActivityAt: Schema.NullOr(IsoDateTime),
          pullRequests: maxItems(
            Schema.Struct({ number: PositiveInt, state: Schema.optionalKey(text(20)) }),
            5,
          ),
          /** The newest stored summary's headline. */
          headline: Schema.optionalKey(text(280)),
        }),
        SQUIRE_ONBOARDING_MAX_THREADS,
      ),
    }),
    SQUIRE_ONBOARDING_MAX_PROJECTS,
  ),
});
export type SquireOnboardingContext = typeof SquireOnboardingContext.Type;

const threadEventFields = {
  summary: SquireTurnSummary,
  evidence: Schema.optionalKey(SquireEvidence),
};

const squireEventMembers = [
  Schema.Struct({ type: Schema.Literal("turn-finished"), ...threadEventFields }),
  Schema.Struct({ type: Schema.Literal("thread-stopped"), ...threadEventFields }),
  Schema.Struct({
    type: Schema.Literal("waiting-on-user"),
    /** The pending runtime request or secret item; the dedupe key. */
    pendingItemId: TrimmedNonEmptyString,
    waitingMinutes: NonNegativeInt,
    thresholdMinutes: PositiveInt,
    ...threadEventFields,
  }),
  Schema.Struct({ type: Schema.Literal("pull-request-changed"), ...threadEventFields }),
  Schema.Struct({
    type: Schema.Literal("digest-due"),
    date: LocalDate,
    digest: Schema.optionalKey(SquireDigestInput),
  }),
  Schema.Struct({
    type: Schema.Literal("voice-note"),
    voiceNoteId: SquireVoiceNoteId,
    transcript: TrimmedNonEmptyString,
    speakerVerified: Schema.Boolean,
    source: Schema.Literals(["dictation", "plaud"]),
  }),
  Schema.Struct({
    type: Schema.Literal("onboarding"),
    context: Schema.optionalKey(SquireOnboardingContext),
  }),
  Schema.Struct({
    type: Schema.Literal("item-raised"),
    cardId: SquireCardId,
    squireId: SquireId,
    cardKind: SquireCardKind,
    title: Schema.String,
    targetThreadId: Schema.NullOr(ThreadId),
  }),
  Schema.Struct({
    type: Schema.Literal("item-resolved"),
    cardId: SquireCardId,
    squireId: SquireId,
    cardKind: SquireCardKind,
    title: Schema.String,
    targetThreadId: Schema.NullOr(ThreadId),
    resolution: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("routed-task"),
    taskId: SquireTaskId,
    text: nonEmptyText(4000),
    reason: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("schedule-due"),
    triggerId: SquireTriggerId,
    slot: IsoDateTime,
    instruction: nonEmptyText(2000),
  }),
  Schema.Struct({
    type: Schema.Literal("webhook-received"),
    triggerId: SquireTriggerId,
    deliveryId: TrimmedNonEmptyString,
    instruction: nonEmptyText(2000),
    /** Untrusted outside input, marked as such in the event message. */
    payloadExcerpt: text(2000),
  }),
  Schema.Struct({
    type: Schema.Literal("sweep-due"),
    /** The slot time, or the `squire.lead.sweep` request id. */
    sweepKey: TrimmedNonEmptyString,
    source: Schema.Literals(["schedule", "request"]),
    candidates: maxItems(SquireSweepCandidate, 10),
  }),
  Schema.Struct({
    type: Schema.Literal("message"),
    messageKey: TrimmedNonEmptyString,
    from: SquireParticipant,
    /** Room deliveries only; a direct message has no row outside this event. */
    roomId: Schema.optionalKey(SquireRoomId),
    postId: Schema.optionalKey(SquireRoomPostId),
    hop: NonNegativeInt,
    body: nonEmptyText(SQUIRE_MESSAGE_MAX_CHARS),
    refs: Schema.optionalKey(Schema.Array(SquireRef)),
    /** The message key of the message this answers. */
    replyTo: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("room-proposed"),
    proposalId: TrimmedNonEmptyString,
    fromSquireId: SquireId,
    members: Schema.Array(SquireId).check(Schema.isMinLength(2), Schema.isMaxLength(6)),
    topic: nonEmptyText(120),
    about: Schema.Array(SquireRef),
    reason: Schema.String,
  }),
] as const;

export const SquireEvent = ForwardCompatibleUnion(squireEventMembers, "type");
export type SquireEvent = typeof SquireEvent.Type;
export const SquireEventType = Schema.Literals(
  squireEventMembers.map((member) => member.fields.type.literal),
);
export type SquireEventType = (typeof squireEventMembers)[number]["Type"]["type"];

// ── Cards ─────────────────────────────────────────────────────

export const SquireCardStatus = ForwardCompatibleLiteral(
  ["held", "open", "accepting", "executing", "resolved", "executed", "dismissed", "outdated"],
  "unknown",
);
export type SquireCardStatus = typeof SquireCardStatus.Type;

export const SquireCardResolution = ForwardCompatibleLiteral(
  [
    "accepted",
    "answered",
    "declined",
    "cancelled",
    "dismissed",
    "undone",
    "executed",
    "outdated",
    "expired",
    /** The user denied it; the same slot is refused until they write in the Squire's chat. */
    "denied",
    "failed",
  ],
  "unknown",
);
export type SquireCardResolution = typeof SquireCardResolution.Type;

const squireQuestionRequestMembers = [
  Schema.Struct({
    type: Schema.Literal("approval"),
    /** Absent when the thread offers its default approval options. */
    options: Schema.optionalKey(ForwardCompatibleArray(ProviderApprovalOption)),
    canRespond: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("user-input"),
    /** Every question: the answer is keyed by question id and needs them all. */
    questions: Schema.Array(OrchestrationV2UserInputQuestion),
    canRespond: Schema.Boolean,
  }),
] as const;

/**
 * The target thread's pending request in its own shape, read live
 * when the card loads, so a card answers exactly as the thread would.
 */
export const SquireQuestionRequest = ForwardCompatibleUnion(squireQuestionRequestMembers, "type");
export type SquireQuestionRequest = typeof SquireQuestionRequest.Type;

/** What raised an FYI; `inactivity` is the Lead's inactivity check, answered with Keep or Pause. */
export const SquireFyiSource = ForwardCompatibleLiteral(
  ["summary", "notify", "digest", "inactivity"],
  "unknown",
);
export type SquireFyiSource = typeof SquireFyiSource.Type;

const squireCardPayloadMembers = [
  Schema.Struct({
    type: Schema.Literal("steer"),
    threadId: ThreadId,
    steer: nonEmptyText(4000),
    steerKind: SquireSteerKind,
  }),
  Schema.Struct({
    type: Schema.Literal("question"),
    threadId: ThreadId,
    /** Secret requests are answered through the secret store, never through the card. */
    requestKind: Schema.Literals(["runtime", "secret"]),
    requestId: TrimmedNonEmptyString,
    question: Schema.String,
    options: Schema.Array(SquireAnswerOption),
    /** Runtime requests only, while the request is pending; never for secrets. */
    request: Schema.optionalKey(SquireQuestionRequest),
    /** The Squire's suggested answer or next step, shown above the options. */
    recommendation: Schema.optionalKey(Schema.String),
    /** When the thread raised the request; absent from cards raised before it was recorded. */
    requestedAt: Schema.optionalKey(IsoDateTime),
  }),
  Schema.Struct({
    type: Schema.Literal("overlap"),
    repository: TrimmedNonEmptyString,
    threads: Schema.Array(
      Schema.Struct({
        threadId: ThreadId,
        squireId: SquireId,
        branch: Schema.NullOr(Schema.String),
        /** The thread's open linked PR the recommendation names, shown beside the branch. */
        pullRequest: Schema.optionalKey(PositiveInt),
        /** The driver the thread ran on when the overlap was found. */
        provider: ProviderDriverKind,
        /** The thread's provider instance then, which names it as the thread does. */
        providerInstanceId: Schema.optionalKey(ProviderInstanceId),
      }),
    ).check(Schema.isMinLength(2)),
    paths: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
    recommendation: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("thread-proposal"),
    projectId: ProjectId,
    provider: ProviderDriverKind,
    providerInstanceId: Schema.NullOr(ProviderInstanceId),
    model: Schema.NullOr(TrimmedNonEmptyString),
    firstPrompt: nonEmptyText(8000),
  }),
  Schema.Struct({
    type: Schema.Literal("squire-proposal"),
    name: nonEmptyText(80),
    brief: text(4000),
    grants: Schema.Array(SquireGrantInput),
    permissions: SquirePermissions,
    companion: SquireCompanionChoice,
  }),
  Schema.Struct({
    type: Schema.Literal("control"),
    action: Schema.Literals(["pause", "resume", "rescope", "forward", "merge"]),
    squireId: Schema.NullOr(SquireId),
    grants: Schema.optionalKey(Schema.Array(SquireGrantInput)),
    exclusions: Schema.optionalKey(Schema.Array(ThreadId)),
    cardIds: Schema.optionalKey(Schema.Array(SquireCardId)),
    toSquireId: Schema.optionalKey(SquireId),
  }),
  Schema.Struct({
    type: Schema.Literal("room-proposal"),
    proposalId: Schema.NullOr(TrimmedNonEmptyString),
    members: Schema.Array(SquireId).check(Schema.isMinLength(2), Schema.isMaxLength(6)),
    includesLead: Schema.Boolean,
    topic: nonEmptyText(120),
    about: Schema.Array(SquireRef),
  }),
  Schema.Struct({
    type: Schema.Literal("fyi"),
    source: SquireFyiSource,
    text: Schema.String,
    threadId: Schema.NullOr(ThreadId),
  }),
] as const;

export const SquireCardPayload = ForwardCompatibleUnion(squireCardPayloadMembers, "type");
export type SquireCardPayload = typeof SquireCardPayload.Type;

export const SquireCardTrigger = Schema.Struct({
  runId: Schema.optionalKey(RunId),
  requestId: Schema.optionalKey(TrimmedNonEmptyString),
  /** `<host>/<repo>#<number>`. */
  prKey: Schema.optionalKey(TrimmedNonEmptyString),
  headSha: Schema.optionalKey(TrimmedNonEmptyString),
  transition: Schema.optionalKey(TrimmedNonEmptyString),
  /** The message "Open in thread" links to, when one exists. */
  triggerMessageId: Schema.optionalKey(MessageId),
  /**
   * A question card for a pending secret request: the `secret_request` item
   * whose label and reason the card reads. Never the secret itself.
   */
  secretTurnItemId: Schema.optionalKey(TurnItemId),
  quote: Schema.optionalKey(Schema.String),
  /** A card a voice-note turn raised or last updated; whether its speaker was verified. */
  speakerVerified: Schema.optionalKey(Schema.Boolean),
});
export type SquireCardTrigger = typeof SquireCardTrigger.Type;

export const SquireCardAsk = Schema.Struct({
  requestId: RequestId,
  question: nonEmptyText(4000),
  status: ForwardCompatibleLiteral(["running", "answered", "failed"], "unknown"),
  answer: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  askedAt: IsoDateTime,
});
export type SquireCardAsk = typeof SquireCardAsk.Type;

/** The longest `SquireCardRow.outcome`; longer outcomes end in an ellipsis. */
export const SQUIRE_CARD_OUTCOME_MAX_CHARS = 40;

export const SquireCardRow = Schema.Struct({
  id: SquireCardId,
  /** The raiser. */
  squireId: SquireId,
  /** Differs from the raiser for Lead-raised items on a Squire's thread. */
  ownerSquireId: SquireId,
  kind: SquireCardKind,
  status: SquireCardStatus,
  title: Schema.String,
  targetThreadId: Schema.NullOr(ThreadId),
  projectId: Schema.NullOr(ProjectId),
  origin: SquireCardOrigin,
  steerKind: Schema.NullOr(SquireSteerKind),
  ruleId: Schema.NullOr(SquireRuleId),
  routedTaskId: Schema.NullOr(SquireTaskId),
  /** Overrides the budget line, e.g. "budget reached, recommending only until <time>". */
  caption: Schema.NullOr(Schema.String),
  replacedCount: NonNegativeInt,
  /** FYI rows only, so a row's actions never depend on its title. */
  fyiSource: Schema.optionalKey(SquireFyiSource),
  /**
   * Turn summary FYI rows only: what happened, short (at most
   * `SQUIRE_CARD_OUTCOME_MAX_CHARS`), so the row reads "<thread> · <outcome>"
   * without fetching the card. Absent when the text adds nothing to the title.
   */
  outcome: Schema.optionalKey(Schema.String),
  /** Thread proposals only: who would run the new thread, so the row names it like any row. */
  proposalProvider: Schema.optionalKey(
    Schema.Struct({
      provider: ProviderDriverKind,
      providerInstanceId: Schema.NullOr(ProviderInstanceId),
    }),
  ),
  /**
   * Overlap rows only: every Squire whose thread the overlap names, so a team
   * filter on any of them keeps the row.
   */
  relatedSquireIds: Schema.optionalKey(Schema.Array(SquireId)),
  /**
   * Overlap rows only: each named thread's provider, in payload order, so a row can say how many
   * threads collide and who runs them without reading the card.
   */
  overlapProviders: Schema.optionalKey(Schema.Array(ProviderDriverKind)),
  /**
   * Overlap rows only: each named thread's provider instance, in payload order, so the row names
   * them as the threads do. Absent from cards raised before it was recorded; a thread whose
   * instance was unknown is null.
   */
  overlapProviderInstanceIds: Schema.optionalKey(Schema.Array(Schema.NullOr(ProviderInstanceId))),
  /**
   * Question rows only: when the thread raised the request, so "waiting <age>" counts from the
   * ask rather than from when the card was raised. Absent from cards raised before it was recorded.
   */
  requestedAt: Schema.optionalKey(IsoDateTime),
  /**
   * Only on a card a voice-note turn raised or last updated, whether the
   * note's speaker was verified. Absent on every other card.
   */
  speakerVerified: Schema.optionalKey(Schema.Boolean),
  /**
   * Why a closed item closed, so a chat row can read Expired or Denied without fetching the card.
   * Absent while open and on older servers.
   */
  resolution: Schema.optionalKey(SquireCardResolution),
  /**
   * The "Always allow" rule this approval could become, prefilled as {@link SquireRuleOffer}. Absent
   * where a rule cannot apply (voice, webhook, test, sweep, message, Lead, and `other` steers), so
   * the button is hidden rather than offered and refused.
   */
  allowRuleOffer: Schema.optionalKey(SquireRuleOffer),
  executesAt: Schema.NullOr(IsoDateTime),
  openedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SquireCardRow = typeof SquireCardRow.Type;

export const SquireCard = Schema.Struct({
  ...SquireCardRow.fields,
  why: Schema.String,
  payload: SquireCardPayload,
  evidence: SquireEvidence,
  trigger: SquireCardTrigger,
  ask: Schema.NullOr(SquireCardAsk),
  timeline: Schema.Array(Schema.Struct({ at: IsoDateTime, text: Schema.String })),
  resolution: Schema.NullOr(SquireCardResolution),
});
export type SquireCard = typeof SquireCard.Type;

// ── Action log ────────────────────────────────────────────────

export const SquireActionLogKind = ForwardCompatibleLiteral(
  [
    "event.received",
    "tool.called",
    "decision.recorded",
    "card.created",
    "action.held",
    "action.executed",
    "action.undone",
    "action.cancelled",
    /** The user's accept request, its attempt, and once settled its result (replayed on retry). */
    "action.accepted",
    "notification.pushed",
    "notification.delivery",
    "quiet.recorded",
    "control.reverted",
    "task.routed",
    "rule.created",
    "rule.removed",
    "rule.matched",
    "sweep.ran",
    "sweep.finding",
    "trigger.received",
    "trigger.rate-limited",
    "trigger.rejected",
    "automation.prompted",
    "automation.paused",
    "automation.resumed",
    "message.sent",
    "message.rejected",
    "room.proposed",
    "room.opened",
    "room.closed",
    "room.reopened",
    "room.routed",
    "room.rerouted",
    "room.routing-fallback",
  ],
  "unknown",
);
export type SquireActionLogKind = typeof SquireActionLogKind.Type;

export const SquireActionLogEntry = Schema.Struct({
  id: NonNegativeInt,
  squireId: SquireId,
  kind: SquireActionLogKind,
  threadId: Schema.NullOr(ThreadId),
  cardId: Schema.NullOr(SquireCardId),
  eventId: Schema.NullOr(NonNegativeInt),
  runId: Schema.NullOr(RunId),
  roomId: Schema.NullOr(SquireRoomId),
  postId: Schema.NullOr(SquireRoomPostId),
  triggerId: Schema.NullOr(SquireTriggerId),
  taskId: Schema.NullOr(SquireTaskId),
  /** Bounded detail; never transcripts or tool output. */
  data: Schema.Record(Schema.String, Schema.Unknown),
  createdAt: IsoDateTime,
});
export type SquireActionLogEntry = typeof SquireActionLogEntry.Type;

/** Assembled from the log, the routed-task event, and the cards it raised; never stored. */
export const SquireRoutingReceipt = Schema.Struct({
  taskId: SquireTaskId,
  toSquireId: SquireId,
  text: Schema.String,
  status: ForwardCompatibleLiteral(["sent", "acted", "quiet", "rejected"], "unknown"),
  quietReason: Schema.NullOr(Schema.String),
  items: Schema.Array(
    Schema.Struct({ cardId: SquireCardId, kind: SquireCardKind, status: SquireCardStatus }),
  ),
  createdAt: IsoDateTime,
});
export type SquireRoutingReceipt = typeof SquireRoutingReceipt.Type;

// ── Rooms and room posts ──────────────────────────────────────

export const SQUIRE_MAX_HOP = 3;

const squireRoutingMembers = [
  Schema.Struct({
    kind: Schema.Literal("rule"),
    /** `none`: routed to nobody (bot messaging off, only the user addressed); `match` says why. */
    rule: Schema.Literals(["mention", "reply", "scope", "recent", "lead", "none"]),
    match: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("jev"),
    confidence: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
    noReplyNeeded: Schema.Boolean,
    shownToLead: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("fallback"),
    reason: ForwardCompatibleLiteral(
      [
        "unfunded",
        "pending",
        "revoked",
        "unavailable",
        "rate-limited",
        "allowance",
        "error",
        "invalid",
        "timeout",
      ],
      "unknown",
    ),
  }),
  Schema.Struct({ kind: Schema.Literal("pending") }),
] as const;

export const SquireRouting = Schema.Struct({
  via: ForwardCompatibleUnion(squireRoutingMembers, "kind"),
  /** Empty when the post wakes nobody. */
  recipients: Schema.Array(SquireId),
});
export type SquireRouting = typeof SquireRouting.Type;

export const SquireRoomPost = Schema.Struct({
  id: SquireRoomPostId,
  messageKey: TrimmedNonEmptyString,
  roomId: SquireRoomId,
  author: SquireParticipant,
  body: nonEmptyText(SQUIRE_MESSAGE_MAX_CHARS),
  replyTo: Schema.NullOr(SquireRoomPostId),
  refs: Schema.Array(SquireRef),
  hop: NonNegativeInt,
  routing: SquireRouting,
  reroutedFrom: Schema.NullOr(SquireRoomPostId),
  createdAt: IsoDateTime,
});
export type SquireRoomPost = typeof SquireRoomPost.Type;

export const SQUIRE_MAX_OPEN_ROOMS = 6;
export const SQUIRE_MAX_OPEN_ROOMS_PER_SQUIRE = 3;
const RoomMembers = Schema.Array(SquireId).check(Schema.isMinLength(2), Schema.isMaxLength(6));
const RoomIdleTtlHours = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 168 }));

export const SquireRoom = Schema.Struct({
  id: SquireRoomId,
  topic: nonEmptyText(120),
  about: Schema.Array(SquireRef),
  status: Schema.Literals(["open", "closed"]),
  muted: Schema.Boolean,
  botMessaging: Schema.Boolean,
  idleTtlSeconds: PositiveInt,
  creator: Schema.Literals(["user", "lead", "proposal"]),
  /** Squire members; the Lead and the user are flagged apart. */
  members: RoomMembers,
  includesLead: Schema.Boolean,
  includesUser: Schema.Boolean,
  lastPostAt: Schema.NullOr(IsoDateTime),
  closedReason: Schema.NullOr(Schema.String),
  revision: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SquireRoom = typeof SquireRoom.Type;

export const SquireRoomRow = Schema.Struct({
  id: SquireRoomId,
  topic: nonEmptyText(120),
  status: Schema.Literals(["open", "closed"]),
  muted: Schema.Boolean,
  members: Schema.Array(SquireId),
  includesLead: Schema.Boolean,
  /** The user is a member and posts arrived since they last viewed it; false while muted. */
  unread: Schema.Boolean,
  lastPostAt: Schema.NullOr(IsoDateTime),
});
export type SquireRoomRow = typeof SquireRoomRow.Type;

// ── Snapshot ──────────────────────────────────────────────────

export const SquireGesture = ForwardCompatibleLiteral(
  ["greet", "ponder", "listen", "nod", "flourish", "glance"],
  "unknown",
);
export type SquireGesture = typeof SquireGesture.Type;

/**
 * The record as the always-on stream carries it (about 0.5 KB per Squire): the brief, up to
 * 4,000 characters that only the setup sheet reads, is left out and fetched on demand.
 */
export const SquireSnapshotRecord = Squire.mapFields(({ brief: _brief, ...fields }) => fields);
export type SquireSnapshotRecord = typeof SquireSnapshotRecord.Type;

export const SquireSnapshot = Schema.Struct({
  squire: SquireSnapshotRecord,
  /**
   * The badge: decision items waiting in this Squire's view, its "Needs a decision" group (open,
   * accepting, or executing; never FYI or held). A Squire's counts what it raised or owns,
   * Lead-raised items on its threads included; the Lead's counts only what the Lead raised.
   */
  openDecisionCount: NonNegativeInt,
  /**
   * Squires only: how many of `openDecisionCount` the Lead raised, which the Lead's own count
   * also holds, so a team total subtracts them once. Absent when none.
   */
  leadRaisedDecisionCount: Schema.optionalKey(NonNegativeInt),
  countsByKind: Schema.Struct({
    steer: NonNegativeInt,
    question: NonNegativeInt,
    overlap: NonNegativeInt,
    proposal: NonNegativeInt,
    fyi: NonNegativeInt,
  }),
  held: Schema.Array(
    Schema.Struct({
      cardId: SquireCardId,
      kind: SquireCardKind,
      targetThreadId: Schema.NullOr(ThreadId),
      /**
       * The open card of the same raiser, target thread, and kind that this hold sits
       * beside (a hold is not an item, so it does not replace it). Clients show the two as one
       * block. Absent when no such card is open.
       */
      heldOverCardId: Schema.optionalKey(SquireCardId),
      /** Remaining time, since no client corrects its clock skew. */
      executesInMs: NonNegativeInt,
    }),
  ),
  budget: Schema.Struct({
    steersLeft: NonNegativeInt,
    threadsLeft: NonNegativeInt,
    recommendingUntil: Schema.optionalKey(IsoDateTime),
  }),
  /** Threads where another Squire holds steer Auto. */
  conflicts: Schema.Array(Schema.Struct({ threadId: ThreadId, autoHolderSquireId: SquireId })),
  trackedCount: NonNegativeInt,
  containerNames: Schema.Array(Schema.String),
  recentActivity: maxItems(
    Schema.Struct({
      sequence: NonNegativeInt,
      kind: SquireActionLogKind,
      at: IsoDateTime,
      /**
       * The gesture this entry plays, decided by the server from the log
       * row, since one log kind covers several gestures (a batch start and a
       * voice note are both `event.received`). Absent plays nothing.
       */
      gesture: Schema.optionalKey(SquireGesture),
    }),
    8,
  ),
  itemsRevision: NonNegativeInt,
  /** Bumped by decision items only, so FYI writes do not wake decision badges. */
  decisionRevision: NonNegativeInt,
  /** The Squire's newest visible chat message, for sidebar unread. Absent until it has spoken. */
  lastMessageAt: Schema.optionalKey(IsoDateTime),
});
export type SquireSnapshot = typeof SquireSnapshot.Type;

export const SquireEnvironmentSnapshot = Schema.Struct({
  /** Null until `squire.lead.ensure` creates the Lead. */
  lead: Schema.NullOr(SquireId),
  squires: Schema.Array(SquireSnapshot),
  rooms: Schema.Array(SquireRoomRow),
});
export type SquireEnvironmentSnapshot = typeof SquireEnvironmentSnapshot.Type;

const squireSubscribeMembers = [
  Schema.Struct({ type: Schema.Literal("snapshot"), snapshot: SquireEnvironmentSnapshot }),
  Schema.Struct({ type: Schema.Literal("squire"), entry: SquireSnapshot }),
  Schema.Struct({ type: Schema.Literal("squire-removed"), squireId: SquireId }),
  Schema.Struct({ type: Schema.Literal("lead"), lead: Schema.NullOr(SquireId) }),
  Schema.Struct({ type: Schema.Literal("room"), row: SquireRoomRow }),
] as const;

/** Unknown update types decode as unknown members, which clients skip. */
export const SquireSubscribeEvent = ForwardCompatibleUnion(squireSubscribeMembers, "type");
export type SquireSubscribeEvent = typeof SquireSubscribeEvent.Type;

// ── Errors ────────────────────────────────────────────────────

export const SquireErrorCode = ForwardCompatibleLiteral(
  [
    "disabled_by_server",
    "not_available",
    "provider_unsupported",
    "not_found",
    "invalid_request",
    "revision_conflict",
    "out_of_scope",
    "permission_denied",
    "budget_exhausted",
    "limit_reached",
    "lead_exists",
    "paused",
    "outdated",
    "rate_limited",
  ],
  "unknown",
);
export type SquireErrorCode = typeof SquireErrorCode.Type;

export class SquireError extends Schema.TaggedError<SquireError>()("SquireError", {
  code: SquireErrorCode,
  message: Schema.String,
}) {}

// ── RPC reads ─────────────────────────────────────────────────

const PageLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }));

export const SquireSubscribeInput = Schema.Struct({});

export const SquireItemsListInput = Schema.Struct({
  /** The Lead's id lists its combined queue. */
  squireId: SquireId,
  scope: defaulted(Schema.Literals(["open", "all"]), "open"),
  kinds: Schema.optionalKey(Schema.Array(SquireCardKind)),
  before: Schema.optionalKey(IsoDateTime),
  limit: Schema.optionalKey(PageLimit),
});
export const SquireItemsListResult = Schema.Struct({
  items: Schema.Array(SquireCardRow),
  nextBefore: Schema.NullOr(IsoDateTime),
  itemsRevision: NonNegativeInt,
});

export const SquireItemGetInput = Schema.Struct({ cardId: SquireCardId });
export const SquireItemGetResult = Schema.Struct({ card: SquireCard });

export const SquireSummaryGetInput = Schema.Struct({
  threadId: ThreadId,
  /** Latest when absent. */
  runId: Schema.optionalKey(RunId),
});
export const SquireSummaryGetResult = Schema.Struct({
  summary: Schema.NullOr(SquireStoredSummary),
});

export const SquireActionLogListInput = Schema.Struct({
  squireId: SquireId,
  kinds: Schema.optionalKey(Schema.Array(SquireActionLogKind)),
  before: Schema.optionalKey(NonNegativeInt),
  limit: Schema.optionalKey(PageLimit),
});
export const SquireActionLogListResult = Schema.Struct({
  entries: Schema.Array(SquireActionLogEntry),
  nextBefore: Schema.NullOr(NonNegativeInt),
});

/** Transcription hints: Squire names, tracked thread titles, project names. */
export const SquireVocabularyInput = Schema.Struct({});
export const SquireVocabularyResult = Schema.Struct({ terms: Schema.Array(Schema.String) });

export const SquireRoomPostsInput = Schema.Struct({
  roomId: SquireRoomId,
  before: Schema.optionalKey(SquireRoomPostId),
  limit: Schema.optionalKey(PageLimit),
});
export const SquireRoomPostsResult = Schema.Struct({
  room: SquireRoom,
  posts: Schema.Array(SquireRoomPost),
  nextBefore: Schema.NullOr(SquireRoomPostId),
});

/** The full record, brief included, which the snapshot leaves out. */
export const SquireGetInput = Schema.Struct({ squireId: SquireId });

/** Every provider instance on the server, with whether it can run a Squire. */
export const SquireProviderSupportInput = Schema.Struct({});
export const SquireProviderSupportResult = Schema.Struct({
  instances: Schema.Array(
    Schema.Struct({
      instanceId: ProviderInstanceId,
      supported: Schema.Boolean,
      /** User-facing; set when unsupported. */
      reason: Schema.NullOr(Schema.String),
    }),
  ),
});

export const SquireRuleListInput = Schema.Struct({ squireId: SquireId });
export const SquireRuleListResult = Schema.Struct({ rules: Schema.Array(SquireRule) });

export const SquireTriggerListInput = Schema.Struct({ squireId: SquireId });
export const SquireTriggerListResult = Schema.Struct({ triggers: Schema.Array(SquireTrigger) });

export const SquireTriggerRunsInput = Schema.Struct({ triggerId: SquireTriggerId });
export const SquireTriggerRunsResult = Schema.Struct({ runs: maxItems(SquireTriggerRun, 20) });

export const SquireLeadReceiptsInput = Schema.Struct({
  before: Schema.optionalKey(IsoDateTime),
  limit: Schema.optionalKey(PageLimit),
});
export const SquireLeadReceiptsResult = Schema.Struct({
  receipts: Schema.Array(SquireRoutingReceipt),
  nextBefore: Schema.NullOr(IsoDateTime),
});

// ── RPC mutations ─────────────────────────────────────────────
// Every mutation carries a `requestId`; a retry with the same id is idempotent.

export const SquireResult = Schema.Struct({ squire: Squire });

const squireEditableFields = {
  name: nonEmptyText(80),
  brief: text(4000),
  modelSelection: ModelSelection,
  summaryModelSelection: Schema.NullOr(ModelSelection),
  events: SquireEventToggles,
  permissions: SquirePermissions,
  budgets: SquireBudgets,
  undoWindowSeconds: SquireUndoWindowSeconds,
};

export const SquireCreateInput = Schema.Struct({
  requestId: RequestId,
  homeProjectId: ProjectId,
  providerInstanceId: ProviderInstanceId,
  name: squireEditableFields.name,
  brief: squireEditableFields.brief,
  modelSelection: Schema.optionalKey(squireEditableFields.modelSelection),
  summaryModelSelection: Schema.optionalKey(squireEditableFields.summaryModelSelection),
  grants: Schema.Array(SquireGrantInput),
  events: squireEditableFields.events,
  permissions: squireEditableFields.permissions,
  budgets: squireEditableFields.budgets,
  undoWindowSeconds: defaulted(SquireUndoWindowSeconds, 10),
  /** The server picks a distinct default when absent. */
  companion: Schema.optionalKey(squireCompanionChoiceStruct),
});

// Absent keys stay absent: the whole-struct decoding defaults would turn a
// partial update into a reset of every omitted section.
export const SquireUpdateInput = Schema.Struct({
  requestId: RequestId,
  squireId: SquireId,
  expectedRevision: NonNegativeInt,
  name: Schema.optionalKey(squireEditableFields.name),
  brief: Schema.optionalKey(squireEditableFields.brief),
  /** Changing provider is checked against `squireSupport` before it applies. */
  providerInstanceId: Schema.optionalKey(ProviderInstanceId),
  modelSelection: Schema.optionalKey(squireEditableFields.modelSelection),
  summaryModelSelection: Schema.optionalKey(squireEditableFields.summaryModelSelection),
  /** Replaces the whole grant set, exclusions included. */
  grants: Schema.optionalKey(Schema.Array(SquireGrantInput)),
  events: Schema.optionalKey(squireEventTogglesStruct),
  permissions: Schema.optionalKey(squirePermissionsStruct),
  budgets: Schema.optionalKey(squireBudgetsStruct),
  undoWindowSeconds: Schema.optionalKey(squireEditableFields.undoWindowSeconds),
  /** The server keeps the Lead on gold and refuses gold for any other Squire. */
  companion: Schema.optionalKey(squireCompanionStruct),
  digest: Schema.optionalKey(Schema.NullOr(SquireDigest)),
  /** Lead only (IANA). */
  timezone: Schema.optionalKey(TrimmedNonEmptyString),
  sweep: Schema.optionalKey(squireSweepSettingsStruct),
});

export const SquireSetStatusInput = Schema.Struct({
  requestId: RequestId,
  squireId: SquireId,
  status: SquireStatus,
});

export const SquireDeleteInput = Schema.Struct({ requestId: RequestId, squireId: SquireId });
export const SquireDeleteResult = Schema.Struct({ squireId: SquireId });

/** Untracking a thread that a container grant covers adds an exclusion. */
export const SquireTrackInput = Schema.Struct({
  requestId: RequestId,
  squireId: SquireId,
  grant: SquireGrantInput,
});
export const SquireUntrackInput = SquireTrackInput;

export const SquireItemAction = Schema.Literals(["accept", "dismiss", "undo"]);
export type SquireItemAction = typeof SquireItemAction.Type;

export const SquireItemsActInput = Schema.Struct({
  requestId: RequestId,
  cardIds: Schema.Array(SquireCardId).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
  action: SquireItemAction,
  /** The user's edited steer or first prompt; accept only. */
  text: Schema.optionalKey(nonEmptyText(8000)),
  /**
   * A question card's answer, in the target thread's own request shape; accept
   * only. Secrets never come this way (`secrets.answerRequest`).
   */
  answer: Schema.optionalKey(
    Schema.Struct({
      decision: Schema.optionalKey(ProviderApprovalDecision),
      answers: Schema.optionalKey(ProviderUserInputAnswers),
    }),
  ),
});
export const SquireItemsActResult = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      cardId: SquireCardId,
      status: SquireCardStatus,
      error: Schema.NullOr(Schema.Struct({ code: SquireErrorCode, message: Schema.String })),
      ruleOffer: Schema.optionalKey(SquireRuleOffer),
    }),
  ),
});

export const SquireItemAskInput = Schema.Struct({
  requestId: RequestId,
  cardId: SquireCardId,
  question: nonEmptyText(4000),
});
export const SquireItemAskResult = Schema.Struct({ ask: SquireCardAsk });

export const SquireVoiceNoteInput = Schema.Struct({
  requestId: RequestId,
  squireId: SquireId,
  transcript: nonEmptyText(8000),
  speakerVerified: Schema.Boolean,
  source: Schema.Literals(["dictation", "plaud"]),
});
export const SquireVoiceNoteResult = Schema.Struct({ voiceNoteId: SquireVoiceNoteId });

export const SquireLeadEnsureInput = Schema.Struct({ requestId: RequestId });
export const SquireLeadOpenInput = Schema.Struct({
  requestId: RequestId,
  /** The client's IANA zone; stored on the Lead when it has none. */
  timezone: Schema.optionalKey(TrimmedNonEmptyString),
  /** `defer` opens without queuing the paid first-run onboarding, so the client can
      show the fixed intro first; `start` queues it if it has not run. Absent means
      `start`, the behavior of clients older than the intro. */
  onboarding: Schema.optionalKey(Schema.Literals(["start", "defer"])),
});
export const SquireLeadOpenResult = Schema.Struct({
  squireId: SquireId,
  /** True when this open enqueued the first-run onboarding. */
  onboardingQueued: Schema.Boolean,
});

export const SquireControlRevertInput = Schema.Struct({
  requestId: RequestId,
  /** The control action's `action.executed` log row. */
  logEntryId: NonNegativeInt,
});

/** No card ids means a Squire view opened, which still counts as activity. */
export const SquireItemsMarkOpenedInput = Schema.Struct({
  requestId: RequestId,
  cardIds: Schema.Array(SquireCardId).check(Schema.isMaxLength(50)),
});
export const SquireItemsMarkOpenedResult = Schema.Struct({});

/**
 * A desktop showed an OS or in-app alert for a card's notification intent:
 * one `notification.delivery` row with outcome `alerted` per card and
 * surface, however often it is retried.
 */
export const SquireNotificationAlertedInput = Schema.Struct({
  requestId: RequestId,
  squireId: SquireId,
  /** The card whose `notification.pushed` intent was shown. */
  cardId: SquireCardId,
  surface: Schema.Literal("desktop"),
});
export const SquireNotificationAlertedResult = Schema.Struct({});

export const SquireRuleCreateInput = Schema.Struct({
  requestId: RequestId,
  squireId: SquireId,
  effect: SquireRuleEffect,
  actionClass: SquireRuleActionClass,
  targetKind: SquireRuleTargetKind,
  targetId: TrimmedNonEmptyString,
  steerKind: Schema.optionalKey(SquireSteerKind),
  /** The accepted or undone card the offer came from. */
  fromCardId: Schema.optionalKey(SquireCardId),
});
export const SquireRuleResult = Schema.Struct({ rule: SquireRule });
export const SquireRuleRemoveInput = Schema.Struct({ requestId: RequestId, ruleId: SquireRuleId });
export const SquireRuleRemoveResult = Schema.Struct({ ruleId: SquireRuleId });

export const SquireTriggerCreateInput = Schema.Union([
  Schema.Struct({
    requestId: RequestId,
    squireId: SquireId,
    kind: Schema.Literal("schedule"),
    name: nonEmptyText(200),
    instruction: nonEmptyText(2000),
    schedule: SquireTriggerSchedule,
  }),
  Schema.Struct({
    requestId: RequestId,
    squireId: SquireId,
    kind: Schema.Literal("webhook"),
    name: nonEmptyText(200),
    instruction: nonEmptyText(2000),
  }),
]);
export const SquireTriggerCreateResult = Schema.Struct({
  trigger: SquireTrigger,
  /** Webhooks only; shown once and never readable again. */
  webhook: Schema.NullOr(SquireWebhookSecret),
});
export const SquireTriggerUpdateInput = Schema.Struct({
  requestId: RequestId,
  triggerId: SquireTriggerId,
  status: Schema.optionalKey(Schema.Literals(["active", "paused"])),
  name: Schema.optionalKey(nonEmptyText(200)),
  instruction: Schema.optionalKey(nonEmptyText(2000)),
  schedule: Schema.optionalKey(SquireTriggerSchedule),
});
export const SquireTriggerResult = Schema.Struct({ trigger: SquireTrigger });
export const SquireTriggerRotateInput = Schema.Struct({
  requestId: RequestId,
  triggerId: SquireTriggerId,
});
export const SquireTriggerRotateResult = Schema.Struct({
  trigger: SquireTrigger,
  webhook: SquireWebhookSecret,
});
export const SquireTriggerRevokeInput = SquireTriggerRotateInput;
export const SquireTriggerTestInput = Schema.Struct({
  requestId: RequestId,
  triggerId: SquireTriggerId,
  /** A pasted sample body for a webhook; the last received payload when absent. */
  samplePayload: Schema.optionalKey(text(65536)),
});
export const SquireTriggerTestResult = Schema.Struct({
  outcome: ForwardCompatibleLiteral(["queued", "rate-limited"], "unknown"),
  retryAt: Schema.NullOr(IsoDateTime),
});

/** Resumes the named triggers, or every trigger and the sweep when none are named. */
export const SquireAutomationResumeInput = Schema.Struct({
  requestId: RequestId,
  triggerIds: Schema.optionalKey(Schema.Array(SquireTriggerId)),
});
export const SquireAutomationResumeResult = Schema.Struct({});

export const SquireLeadSweepInput = Schema.Struct({ requestId: RequestId });
export const SquireLeadSweepResult = Schema.Struct({
  outcome: ForwardCompatibleLiteral(["queued", "empty", "budget-reached", "paused"], "unknown"),
  retryAt: Schema.NullOr(IsoDateTime),
});

export const SquireRoomCreateInput = Schema.Struct({
  requestId: RequestId,
  topic: nonEmptyText(120),
  members: RoomMembers,
  includesLead: defaulted(Schema.Boolean, false),
  about: Schema.optionalKey(Schema.Array(SquireRef)),
  /** The environment's `squire.roomIdleTtlHours` when absent. */
  idleTtlHours: Schema.optionalKey(RoomIdleTtlHours),
});
export const SquireRoomUpdateInput = Schema.Struct({
  requestId: RequestId,
  roomId: SquireRoomId,
  expectedRevision: NonNegativeInt,
  topic: Schema.optionalKey(nonEmptyText(120)),
  members: Schema.optionalKey(RoomMembers),
  includesLead: Schema.optionalKey(Schema.Boolean),
  muted: Schema.optionalKey(Schema.Boolean),
  botMessaging: Schema.optionalKey(Schema.Boolean),
  idleTtlHours: Schema.optionalKey(RoomIdleTtlHours),
});
export const SquireRoomCloseInput = Schema.Struct({ requestId: RequestId, roomId: SquireRoomId });
export const SquireRoomReopenInput = SquireRoomCloseInput;
export const SquireRoomResult = Schema.Struct({ room: SquireRoom });

/** The `requestId` is the message key. */
export const SquireRoomPostInput = Schema.Struct({
  requestId: RequestId,
  roomId: SquireRoomId,
  body: nonEmptyText(SQUIRE_MESSAGE_MAX_CHARS),
  replyTo: Schema.optionalKey(SquireRoomPostId),
  refs: Schema.optionalKey(Schema.Array(SquireRef)),
});
export const SquireRoomRerouteInput = Schema.Struct({
  requestId: RequestId,
  postId: SquireRoomPostId,
  /** A member, or the Lead. */
  to: SquireId,
});
export const SquireRoomPostResult = Schema.Struct({ post: SquireRoomPost });

/** Clears the room's unread dot up to `throughPostId`; the seen cursor never moves back. */
export const SquireRoomMarkReadInput = Schema.Struct({
  requestId: RequestId,
  roomId: SquireRoomId,
  throughPostId: SquireRoomPostId,
});
export const SquireRoomMarkReadResult = Schema.Struct({});

/** Tools that put something in front of the user, so a run that calls one is not quiet. */
export const SQUIRE_SPEAKING_TOOLS: ReadonlySet<string> = new Set([
  "squire_notify",
  "squire_recommend_steer",
  "squire_send_steer",
  "squire_propose_thread",
  "squire_create_thread",
  "squire_propose_room",
  "squire_open_room",
  "squire_propose_squire",
  "squire_raise_overlap",
  "squire_pause",
  "squire_resume",
  "squire_rescope",
  "squire_forward_item",
  "squire_publish_showcase",
]);

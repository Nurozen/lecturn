/**
 * Squire test fixtures: B2 scenarios, `squireFake` scripts, and summary golds.
 * Decoded by the reactor test seam, the dev fixture route, and
 * `squire load-fixture`. Version 1 files carry no `schemaVersion`; every
 * version 2 addition is optional, so they still decode.
 */
import * as Schema from "effect/Schema";

import {
  ForwardCompatibleLiteral,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  SquireId,
  SquireRoomId,
  SquireTriggerId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";
import {
  SquireCompanionStruct,
  SquireEvent,
  SquireEventType,
  SquirePermissionLevel,
  SquireNotifyLevel,
  SquireRuleActionClass,
  SquireRuleEffect,
  SquireSteerKind,
  SquireSummaryInput,
  SquireSweepSettings,
  SquireTriggerSchedule,
  SquireTriggerStatus,
  SquireTurnSummary,
  SquireUndoWindowSeconds,
} from "./squire.ts";

const SchemaVersion = Schema.optionalKey(Schema.Literals([1, 2]));
/** The Squire's provider: a driver kind, or `under-test` for the one B2 is judging. */
const FixtureProvider = Schema.Union([Schema.Literal("under-test"), ProviderDriverKind]);

// ── Setup ─────────────────────────────────────────────────────
// Containers are named, not id'd: `loadSetup` resolves names to the projects
// it creates. Fixture thread, trigger, room, and Squire ids become real ids.

const ProjectName = TrimmedNonEmptyString;

export const SquireFixtureContainer = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("project"), name: ProjectName }),
  Schema.Struct({ kind: Schema.Literal("thread"), threadId: ThreadId }),
  /** A synthetic Stave space over the named projects. */
  Schema.Struct({
    kind: Schema.Literal("staveSpace"),
    name: TrimmedNonEmptyString,
    covers: Schema.Array(ProjectName).check(Schema.isMinLength(1)),
  }),
  /** A synthetic `project.stave` saga over the named projects. */
  Schema.Struct({
    kind: Schema.Literal("staveSaga"),
    name: TrimmedNonEmptyString,
    covers: Schema.Array(ProjectName).check(Schema.isMinLength(1)),
  }),
]);
export type SquireFixtureContainer = typeof SquireFixtureContainer.Type;

export const SquireFixtureThread = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  project: ProjectName,
  provider: ProviderDriverKind,
  /** The thread's own branch, which overlap items name. */
  branch: Schema.optionalKey(TrimmedNonEmptyString),
});

export const SquireFixturePermissions = Schema.Struct({
  steer: SquirePermissionLevel,
  createThread: SquirePermissionLevel,
  notify: SquireNotifyLevel,
  manageSquires: Schema.optionalKey(SquirePermissionLevel),
});

/** Seeded as `squire_budget_usage` rows, never log rows, so seeding is never a B2 effect. */
export const SquireFixtureBudgetUsage = Schema.Struct({
  steersPerDay: Schema.Struct({ used: NonNegativeInt, limit: NonNegativeInt }),
  threadsPerDay: Schema.Struct({ used: NonNegativeInt, limit: NonNegativeInt }),
  steersPerThreadPerHour: Schema.Struct({
    limit: NonNegativeInt,
    usedByThread: Schema.Record(ThreadId, NonNegativeInt),
  }),
});

const SquireFixtureIdentity = {
  squireId: Schema.optionalKey(SquireId),
  name: TrimmedNonEmptyString,
  brief: Schema.String,
  provider: FixtureProvider,
  /** The single-Auto tie-break reads it. */
  createdAt: Schema.optionalKey(IsoDateTime),
  timezone: Schema.optionalKey(TrimmedNonEmptyString),
};

export const SquireFixtureRule = Schema.Struct({
  effect: SquireRuleEffect,
  actionClass: SquireRuleActionClass,
  target: SquireFixtureContainer,
  steerKind: Schema.optionalKey(SquireSteerKind),
});

/** Webhook triggers get a generated secret; fixtures never carry one. */
export const SquireFixtureTrigger = Schema.Union([
  Schema.Struct({
    triggerId: Schema.optionalKey(SquireTriggerId),
    kind: Schema.Literal("schedule"),
    name: TrimmedNonEmptyString,
    instruction: TrimmedNonEmptyString,
    schedule: SquireTriggerSchedule,
    status: Schema.optionalKey(SquireTriggerStatus),
  }),
  Schema.Struct({
    triggerId: Schema.optionalKey(SquireTriggerId),
    kind: Schema.Literal("webhook"),
    name: TrimmedNonEmptyString,
    instruction: TrimmedNonEmptyString,
    status: Schema.optionalKey(SquireTriggerStatus),
  }),
]);

/** Per-Squire config every fixture Squire may set; the main Squire's lives on `setup`. */
const squireConfigFields = {
  scope: Schema.optionalKey(Schema.Array(SquireFixtureContainer)),
  exclusions: Schema.optionalKey(Schema.Array(ThreadId)),
  permissions: Schema.optionalKey(SquireFixturePermissions),
  undoWindowSeconds: Schema.optionalKey(SquireUndoWindowSeconds),
  budgetUsage: Schema.optionalKey(SquireFixtureBudgetUsage),
  // A fixture without one leaves the Squire's companion as it is.
  companion: Schema.optionalKey(SquireCompanionStruct),
  waitingThresholdMinutes: Schema.optionalKey(PositiveInt),
  rules: Schema.optionalKey(Schema.Array(SquireFixtureRule)),
  triggers: Schema.optionalKey(Schema.Array(SquireFixtureTrigger)),
};

/** Another Squire, upserted by name. */
export const SquireFixtureExtraSquire = Schema.Struct({
  ...SquireFixtureIdentity,
  ...squireConfigFields,
});

export const SquireFixtureRoomRef = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("thread"), threadId: ThreadId }),
  Schema.Struct({ kind: Schema.Literal("pullRequest"), number: PositiveInt }),
  Schema.Struct({ kind: Schema.Literal("project"), name: ProjectName }),
]);

export const SquireFixtureRoom = Schema.Struct({
  roomId: Schema.optionalKey(SquireRoomId),
  topic: TrimmedNonEmptyString,
  /** Squire names; `lead` adds the Lead. */
  members: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(2)),
  about: Schema.optionalKey(Schema.Array(SquireFixtureRoomRef)),
  muted: Schema.optionalKey(Schema.Boolean),
  botMessaging: Schema.optionalKey(Schema.Boolean),
  idleTtlHours: Schema.optionalKey(PositiveInt),
});

export const SquireFixtureSetup = Schema.Struct({
  /** `lead` makes the fixture's Squire the environment's Lead (`ensureLead`). */
  role: Schema.optionalKey(Schema.Literals(["lead", "squire"])),
  /** Required unless `role` is `lead`, which uses the Lead's own defaults. */
  squire: Schema.optionalKey(Schema.Struct(SquireFixtureIdentity)),
  squires: Schema.optionalKey(Schema.Array(SquireFixtureExtraSquire)),
  threads: Schema.optionalKey(Schema.Array(SquireFixtureThread)),
  ...squireConfigFields,
  /** Lead only. */
  sweep: Schema.optionalKey(SquireSweepSettings),
  rooms: Schema.optionalKey(Schema.Array(SquireFixtureRoom)),
}).check(
  Schema.makeFilter(
    (setup) => setup.role === "lead" || setup.squire !== undefined || "setup.squire is required",
  ),
);
export type SquireFixtureSetup = typeof SquireFixtureSetup.Type;

// ── Timeline ──────────────────────────────────────────────────
// Applied in order after the events drain, on the test clock, while a hold
// may still be pending.

export const SquireFixtureTimelineAction = Schema.Union([
  /** Presses Undo on the pending hold. */
  Schema.Struct({ action: Schema.Literal("undo") }),
  Schema.Struct({ action: Schema.Literal("advance"), seconds: PositiveInt }),
  /** Inserts budget usage rows as if other actions had executed meanwhile. */
  Schema.Struct({
    action: Schema.Literal("seedUsage"),
    kind: Schema.Literals(["steer", "thread", "message"]),
    count: PositiveInt,
    threadId: Schema.optionalKey(ThreadId),
  }),
  /** Stops the server, advances the clock by the downtime, and starts it again. */
  Schema.Struct({ action: Schema.Literal("restart"), downtimeSeconds: PositiveInt }),
  /** A new commit on the thread's PR head, which obsoletes a PR trigger. */
  Schema.Struct({
    action: Schema.Literal("moveHead"),
    threadId: ThreadId,
    headSha: TrimmedNonEmptyString,
  }),
]);
export type SquireFixtureTimelineAction = typeof SquireFixtureTimelineAction.Type;

// ── Expected ──────────────────────────────────────────────────

export const SquireFixtureEffect = Schema.Literals([
  "card_created",
  "proposal_created",
  "action_held",
  "steer_sent",
  "thread_created",
  "notification_pushed",
  "quiet_recorded",
]);
export type SquireFixtureEffect = typeof SquireFixtureEffect.Type;

/**
 * Checks beyond effect counts. An assertion this build does not know reads as
 * `unknown`, which a runner must fail rather than skip.
 */
export const SquireFixtureAssertion = ForwardCompatibleLiteral(
  [
    // Nothing reached the target while the test clock was before `executes_at`.
    "no_send_before_undo_window",
    "one_execution_budget_row",
    "no_execution_budget_row",
    // The executed steer's message carries `createdBy: "agent"`.
    "steer_created_by_agent",
    // `steer_active` where the target provider supports active steering, else `queue_after_active`.
    "steer_dispatch_mode_d12",
    "card_origin_voice",
    // A `decision.recorded` row with reason `voice` for the downgraded send.
    "decision_recorded_voice",
    // The Lead holds one open overlap item naming both threads and the shared path.
    "overlap_item_raised",
  ],
  "unknown",
);
export type SquireFixtureAssertion = typeof SquireFixtureAssertion.Type;

const ToolName = TrimmedNonEmptyString;

export const SquireFixtureExpected = Schema.Struct({
  /** Events the queue delivers after dedupe; all of them when absent. */
  deliveredEvents: Schema.optionalKey(NonNegativeInt),
  toolCalls: Schema.Array(
    Schema.Union([ToolName, Schema.Struct({ anyOf: Schema.Array(ToolName) })]),
  ),
  cardTarget: Schema.NullOr(
    Schema.Union([
      Schema.String,
      Schema.Struct({
        newThread: Schema.Literal(true),
        project: ProjectName,
        provider: ProviderDriverKind,
      }),
    ]),
  ),
  effects: Schema.Struct({
    card_created: Schema.optionalKey(NonNegativeInt),
    proposal_created: Schema.optionalKey(NonNegativeInt),
    action_held: Schema.optionalKey(NonNegativeInt),
    steer_sent: Schema.optionalKey(NonNegativeInt),
    thread_created: Schema.optionalKey(NonNegativeInt),
    notification_pushed: Schema.optionalKey(NonNegativeInt),
    quiet_recorded: Schema.optionalKey(NonNegativeInt),
  }),
  /** `<time>` matches any time. */
  cardCaption: Schema.optionalKey(Schema.String),
  mustNotHappen: Schema.Array(SquireFixtureEffect),
  ignore: Schema.Array(ToolName),
  assertions: Schema.optionalKey(Schema.Array(SquireFixtureAssertion)),
  note: Schema.optionalKey(Schema.String),
});
export type SquireFixtureExpected = typeof SquireFixtureExpected.Type;

// ── Scenario ──────────────────────────────────────────────────

export const SquireFixtureScenario = Schema.Struct({
  schemaVersion: SchemaVersion,
  id: TrimmedNonEmptyString,
  /** The fake script's id when it differs from the scenario's. */
  fake: Schema.optionalKey(TrimmedNonEmptyString),
  setup: SquireFixtureSetup,
  events: Schema.Array(SquireEvent),
  timeline: Schema.optionalKey(Schema.Array(SquireFixtureTimelineAction)),
  /** Absent on setup-only fixtures that B1 loads for stills. */
  expected: Schema.optionalKey(SquireFixtureExpected),
});
export type SquireFixtureScenario = typeof SquireFixtureScenario.Type;

// ── Fake provider scripts ─────────────────────────────────────

const TEMPLATE = /\{\{([^}]*)\}\}/g;
const EVENT_PATH = /^event(\.[A-Za-z0-9_]+)+$/;

/** Every `{{...}}` in a string argument must name an `event.*` path. */
const hasOnlyEventTemplates = (value: unknown): boolean => {
  if (typeof value === "string") {
    for (const match of value.matchAll(TEMPLATE)) {
      if (!EVENT_PATH.test(match[1]!.trim())) return false;
    }
    return true;
  }
  if (Array.isArray(value)) return value.every(hasOnlyEventTemplates);
  if (typeof value === "object" && value !== null) {
    return Object.values(value).every(hasOnlyEventTemplates);
  }
  return true;
};

export const SquireFakeToolCall = Schema.Struct({
  name: ToolName,
  /** String values may hold `{{event.<path>}}`, filled from the delivered event. */
  args: Schema.Record(Schema.String, Schema.Unknown).check(
    Schema.makeFilter(
      (args) => hasOnlyEventTemplates(args) || "templates must reference {{event.<path>}}",
    ),
  ),
});
export type SquireFakeToolCall = typeof SquireFakeToolCall.Type;

export const SquireFakeStep = Schema.Struct({
  /**
   * An event type, `user-message` for a message the user typed to the Squire,
   * or `*` for anything, user messages included. The first matching step runs.
   */
  onEvent: Schema.Union([SquireEventType, Schema.Literals(["user-message", "*"])]),
  toolCalls: Schema.optionalKey(Schema.Array(SquireFakeToolCall)),
  /** Raises a real `user_input` request on the Squire's run. */
  askUser: Schema.optionalKey(
    Schema.Struct({
      question: TrimmedNonEmptyString,
      options: Schema.Array(TrimmedNonEmptyString),
    }),
  ),
  /** Keeps the run open after the step until the user stops it. */
  hold: Schema.optionalKey(Schema.Literal(true)),
}).check(
  Schema.makeFilter(
    (step) =>
      step.toolCalls !== undefined ||
      step.askUser !== undefined ||
      step.hold !== undefined ||
      "a step needs toolCalls, askUser, or hold",
  ),
);
export type SquireFakeStep = typeof SquireFakeStep.Type;

export const SquireFakeScript = Schema.Struct({
  schemaVersion: SchemaVersion,
  steps: Schema.Array(SquireFakeStep).check(Schema.isMinLength(1)),
});
export type SquireFakeScript = typeof SquireFakeScript.Type;

// ── Summary fixtures ──────────────────────────────────────────

const SummaryKey = TrimmedNonEmptyString.check(
  Schema.makeFilter((key) => key in SquireTurnSummary.fields || `not a summary key: ${key}`),
);

export const SquireSummaryGoldFixture = Schema.Struct({
  schemaVersion: SchemaVersion,
  id: TrimmedNonEmptyString,
  fixture: SquireSummaryInput,
  gold: SquireTurnSummary,
  exactMatch: Schema.Array(SummaryKey),
  judged: Schema.Array(SummaryKey),
  failIf: Schema.Array(Schema.String),
});
export type SquireSummaryGoldFixture = typeof SquireSummaryGoldFixture.Type;

/** A summary at every schema maximum, for the rendered-length cap. */
export const SquireSummaryStressFixture = Schema.Struct({
  schemaVersion: SchemaVersion,
  id: TrimmedNonEmptyString,
  summary: SquireTurnSummary,
  note: Schema.optionalKey(Schema.String),
});
export type SquireSummaryStressFixture = typeof SquireSummaryStressFixture.Type;

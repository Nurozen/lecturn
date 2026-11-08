// @effect-diagnostics nodeBuiltinImport:off -- the invocation key is a durable deterministic hash
/**
 * Scope, permission, rules, and budgets are enforced here, never by the prompt. The `tool.called` row, unique on the
 * invocation key, commits with the tool's card and log rows, so a retried call returns the stored result.
 * Auto commits a `held` card with its immutable execution intent, which `SquireActions` runs after the undo window.
 * @module squire/SquireTools
 */
import * as NodeCrypto from "node:crypto";

import {
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderDriverKind,
  RunId,
  type SquireCardOrigin,
  SquireCardId,
  SquireCardPayload,
  SquireCardTrigger,
  SquireBudgets,
  SquireEvent,
  SquireId,
  SquirePermissions,
  type SquireRole,
  SquireRule,
  SquireSteerKind,
  SquireTaskId,
  SquireTurnOrigin,
  type SquireTurnSummary,
  ThreadId,
  TrimmedNonEmptyString,
  DEFAULT_SQUIRE_BUDGETS,
  DEFAULT_SQUIRE_PERMISSIONS,
  isUnknownUnionMember,
  mergeSquireSummaryOverlay,
  renderSquireTurnSummary,
} from "@lecturn/contracts";
import type { ProviderInstance } from "@lecturn/provider-core/server/driver";
import { stableStringify } from "@lecturn/shared/relaySigning";
import { threadPullRequestKeyOf } from "../sourceControl/threadPullRequests.ts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as SquireContainers from "./SquireContainers.ts";
import {
  type SquireActionIntent,
  captureSquirePrecondition,
  encodeSquireActionIntent,
  squireActionCommandId,
  steerDispatchMode,
} from "./squireActionIntent.ts";
import * as SquireDelivery from "./SquireDelivery.ts";
import * as SquireLaunchAction from "./SquireLaunchAction.ts";
import * as SquirePresence from "./SquirePresence.ts";
import { isFixtureWorkspaceRoot } from "./SquireReactor.ts";
import * as SquireRepository from "./SquireRepository.ts";
import { writeLeadItemEvent } from "./squireLeadItems.ts";
import { readSquireText } from "./squireMessageGuards.ts";
import * as SquireScope from "./SquireScope.ts";
import * as SquireSummaries from "./SquireSummaries.ts";
import * as SquireSweep from "./SquireSweep.ts";
import { SquireEventPayloadJson, isSummaryBearing } from "./squireEvents.ts";
import * as squirePolicy from "./squirePolicy.ts";
import {
  type SquireToolCaller,
  type SquireToolContext,
  type SquireToolDefinition,
  type SquireToolKit,
  type SquireToolResult,
  SquireToolRegistry,
} from "./squireToolKit.ts";
import { primaryLink } from "./SquireCardDetail.ts";
import { squireSteerTitle } from "./squireSteerTitle.ts";
import { SQUIRE_TOOL_NAMES } from "./squireToolNames.ts";

// ── Schemas ───────────────────────────────────────────────────

const nonEmpty = (max: number) => TrimmedNonEmptyString.check(Schema.isMaxLength(max));
const steerKindArg = SquireSteerKind.pipe(Schema.withDecodingDefault(Effect.succeed("other")));

const ThreadReadArgs = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optionalKey(RunId),
});
/**
 * The gold scenarios pin a steer at under 280 characters, so 280 itself is refused. Enforced
 * as a readable refusal, not a schema bound, so the model reads why and
 * retries with a shorter steer.
 */
export const SQUIRE_STEER_MAX_CHARS = 280;
/** `steerKind` is optional and defaults to `other`, so older fixtures stay valid. */
export const SquireSteerArgs = Schema.Struct({
  threadId: ThreadId,
  reason: nonEmpty(2000),
  steer: nonEmpty(4000),
  steerKind: steerKindArg,
});
const ThreadProposalArgs = Schema.Struct({
  project: nonEmpty(200),
  provider: nonEmpty(100),
  model: Schema.optionalKey(nonEmpty(200)),
  firstPrompt: nonEmpty(8000),
  reason: nonEmpty(2000),
});
const NotifyArgs = Schema.Struct({
  message: nonEmpty(2000),
  threadId: Schema.optionalKey(ThreadId),
});
const QuietArgs = Schema.Struct({
  reason: nonEmpty(2000),
  threadId: Schema.optionalKey(ThreadId),
});
const NoArgs = Schema.Struct({});
/** The Lead names the Squire that will track the thread; `aboutThreadId` names a sweep candidate. */
const LeadProposalArgs = Schema.Struct({
  ...ThreadProposalArgs.fields,
  squireId: SquireId,
  aboutThreadId: Schema.optionalKey(ThreadId),
});
const ITEM_TYPES = ["action", "question", "overlap", "proposal", "fyi"] as const;
const ListItemsArgs = Schema.Struct({
  squireId: Schema.optionalKey(SquireId),
  type: Schema.optionalKey(Schema.Literals(ITEM_TYPES)),
});
const RouteTaskArgs = Schema.Struct({
  toSquireId: SquireId,
  text: nonEmpty(4000),
  reason: nonEmpty(2000),
});

export type { SquireToolCaller, SquireToolDefinition, SquireToolResult } from "./squireToolKit.ts";

export class SquireTools extends Context.Service<
  SquireTools,
  {
    readonly definitions: (role: SquireRole) => ReadonlyArray<SquireToolDefinition>;
    /** Never fails: refusals and unexpected failures are `isError` results. */
    readonly call: (
      caller: SquireToolCaller,
      name: string,
      args: unknown,
    ) => Effect.Effect<SquireToolResult>;
  }
>()("lecturn/squire/SquireTools") {}

// ── Definitions ───────────────────────────────────────────────

const str = (description: string) => ({ type: "string", description });
const object = (
  properties: Record<string, unknown>,
  required: ReadonlyArray<string> = [],
): SquireToolDefinition["inputSchema"] => ({
  type: "object",
  properties,
  ...(required.length === 0 ? {} : { required }),
  additionalProperties: false,
});
const threadIdProp = str("A tracked thread's id, from squire_list_tracked.");
const turnIdProp = str("The turn (run) id; the latest turn when omitted.");
const steerKindProp = {
  type: "string",
  enum: ["rebase", "rerun-checks", "fix-failing-check", "address-review", "continue", "other"],
  description: "What kind of steer this is. Use `other` when none fits.",
};
const steerProps = {
  threadId: threadIdProp,
  reason: str("Why, quoting the evidence that triggered it."),
  steer: str("The exact message to send to the thread: one action, under 280 characters."),
  steerKind: steerKindProp,
};
const proposalProps = {
  project: str("A project in your scope, by name or id."),
  provider: str("The provider to run the thread on, e.g. `claudeAgent` or `codex`."),
  model: str("The model; the provider's default when omitted."),
  firstPrompt: str("The thread's first message."),
  reason: str("Why this thread should exist, quoting the evidence."),
};

const DEFINITIONS: Readonly<Record<string, SquireToolDefinition>> = {
  squire_list_tracked: {
    name: "squire_list_tracked",
    description: "List the threads you track, with their status and last summary.",
    inputSchema: object({}),
  },
  squire_get_summary: {
    name: "squire_get_summary",
    description: "Read the stored summary of a tracked thread's turn.",
    inputSchema: object({ threadId: threadIdProp, turnId: turnIdProp }, ["threadId"]),
  },
  squire_get_detail: {
    name: "squire_get_detail",
    description:
      "Read a bounded excerpt (at most 4,000 characters) of a tracked thread's turn. Logged; use only when the summary is not enough.",
    inputSchema: object({ threadId: threadIdProp, turnId: turnIdProp }, ["threadId"]),
  },
  squire_recommend_steer: {
    name: "squire_recommend_steer",
    description: "Create a recommendation card proposing one steer for a tracked thread.",
    inputSchema: object(steerProps, ["threadId", "reason", "steer"]),
  },
  squire_send_steer: {
    name: "squire_send_steer",
    description:
      "Send a steer to a tracked thread when your permissions allow it; otherwise it becomes a recommendation card.",
    inputSchema: object(steerProps, ["threadId", "reason", "steer"]),
  },
  squire_propose_thread: {
    name: "squire_propose_thread",
    description: "Create a card proposing a new thread in a project in your scope.",
    inputSchema: object(proposalProps, ["project", "provider", "firstPrompt", "reason"]),
  },
  squire_create_thread: {
    name: "squire_create_thread",
    description:
      "Create a new thread in a project in your scope when your permissions allow it; otherwise it becomes a proposal card.",
    inputSchema: object(proposalProps, ["project", "provider", "firstPrompt", "reason"]),
  },
  squire_list_items: {
    name: "squire_list_items",
    description:
      "List the open items your Squires raised, and your own, newest first. Filter by the Squire that raised or owns them, or by type.",
    inputSchema: object({
      squireId: str("Only this Squire's items."),
      type: {
        type: "string",
        enum: [...ITEM_TYPES],
        description: "Only items of this type; `action` is a steer.",
      },
    }),
  },
  squire_route_task: {
    name: "squire_route_task",
    description:
      "Pass a task the user typed to you on to one Squire, which acts on it with its own tools and permissions. Only in a turn the user's message started.",
    inputSchema: object(
      {
        toSquireId: str("The Squire whose scope fits the task."),
        text: str("The task as that Squire should read it."),
        reason: str("Why this Squire."),
      },
      ["toSquireId", "text", "reason"],
    ),
  },
  squire_notify: {
    name: "squire_notify",
    description:
      "Push a message to the user when no card covers it, e.g. a thread waiting on them. Cards already push on their own.",
    inputSchema: object(
      { message: str("One or two sentences for the user."), threadId: threadIdProp },
      ["message"],
    ),
  },
  squire_stay_quiet: {
    name: "squire_stay_quiet",
    description: "Record that no action is needed, with the reason.",
    inputSchema: object({ reason: str("Why nothing needs doing."), threadId: threadIdProp }, [
      "reason",
    ]),
  },
};

/** The Lead's variants: its steers and proposals act for the owning Squire. */
const LEAD_DEFINITIONS: Readonly<Record<string, SquireToolDefinition>> = {
  squire_recommend_steer: {
    name: "squire_recommend_steer",
    description:
      "Create a recommendation card proposing one steer for a thread one of your Squires tracks. The card belongs to that thread's Squire, at the lower of your and its Steer permission.",
    inputSchema: object(steerProps, ["threadId", "reason", "steer"]),
  },
  squire_send_steer: {
    name: "squire_send_steer",
    description:
      "Send a steer to a thread one of your Squires tracks when both your and its Steer permission allow it; otherwise it becomes a recommendation card. Charged to that Squire's budget.",
    inputSchema: object(steerProps, ["threadId", "reason", "steer"]),
  },
  squire_propose_thread: {
    name: "squire_propose_thread",
    description:
      "Create a card proposing a new thread, owned by the Squire that will track it. The project must be in that Squire's scope.",
    inputSchema: object(
      {
        ...proposalProps,
        project: str("A project in that Squire's scope, by name or id."),
        squireId: str("The Squire that will track the new thread."),
        aboutThreadId: str("On a sweep: the candidate thread this finding is about."),
      },
      ["project", "provider", "firstPrompt", "reason", "squireId"],
    ),
  },
};

// ── Helpers ───────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
export const SQUIRE_DETAIL_MAX_CHARS = 4000;
const LIST_MAX_THREADS = 25;
const LIST_SUMMARY_CHARS = 320;
const LIST_MAX_ITEMS = 25;
const SWEEP_UNAVAILABLE = "Sweep findings are not available on this server, so nothing was raised.";

const encodeLogData = Schema.encodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeLogData = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encodeCardPayload = Schema.encodeSync(Schema.fromJsonString(SquireCardPayload));
const encodeCardTrigger = Schema.encodeSync(Schema.fromJsonString(SquireCardTrigger));
const decodePermissions = Schema.decodeUnknownOption(Schema.fromJsonString(SquirePermissions));
const decodeBudgets = Schema.decodeUnknownOption(Schema.fromJsonString(SquireBudgets));
const decodeRule = Schema.decodeUnknownOption(SquireRule);
const decodeEventPayload = Schema.decodeUnknownOption(SquireEventPayloadJson);
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(SquireEvent));

/** The PR states a steer kind answers, by transition prefix (`squirePullRequestStates`). */
const STEER_PULL_REQUEST_AREA: Partial<Record<SquireSteerKind, string>> = {
  "rerun-checks": "checks:",
  "fix-failing-check": "checks:",
  rebase: "mergeable:",
  "address-review": "review:",
};
const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(SquireEvent));
const decodeTurnOrigin = Schema.decodeUnknownSync(SquireTurnOrigin);
const decodeStoredResult = Schema.decodeUnknownOption(
  Schema.Struct({
    isError: Schema.Boolean,
    text: Schema.String,
    structuredContent: Schema.optionalKey(Schema.Unknown),
    _meta: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  }),
);

const cut = (value: string, max: number) =>
  value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
const firstLine = (value: string, max: number) => cut(value.split("\n")[0]!.trim(), max);

/**
 * The key is Squire-owned, since MCP command ids are random. It names
 * the Squire too: calls outside a run all share the run id `none`.
 */
const squireInvocationKey = (squireId: string, runId: string, tool: string, args: unknown) =>
  NodeCrypto.createHash("sha256")
    .update(`${squireId}\n${runId}\n${tool}\n${stableStringify(args ?? null)}`)
    .digest("hex");

// Models send `null` for an omitted optional argument.
const withoutNulls = (args: unknown): unknown =>
  args !== null && typeof args === "object" && !Array.isArray(args)
    ? Object.fromEntries(Object.entries(args).filter(([, value]) => value !== null))
    : args;

const ok = (text: string, structuredContent?: unknown): SquireToolResult =>
  structuredContent === undefined
    ? { isError: false, text }
    : { isError: false, text, structuredContent };
const refused = (reason: string, text: string): SquireToolResult => ({
  isError: true,
  text,
  structuredContent: { outcome: "refused", reason },
});

type Reason = squirePolicy.SquirePolicyReason;

const reasonText = (reason: Reason, origin: SquireCardOrigin, until: string | undefined) => {
  switch (reason) {
    case "permission":
      return "this Squire's permission is Recommend";
    case "budget":
      return until === undefined
        ? "budget reached, recommending only"
        : `budget reached, recommending only until ${until}`;
    case "voice":
      return "a voice note never sends on its own";
    case "origin":
      return `a ${origin} turn only recommends`;
    case "single-auto":
      return "another Squire holds Auto on this thread";
    case "rule":
      return "an ask-first rule matched";
    case "intersection":
      return "the owning Squire's permission is lower";
    case "paused":
      return "this Squire is paused";
  }
};

// Policy origins that never raise a class level.
const recommendOnlyOrigins: ReadonlySet<SquireCardOrigin> = new Set([
  "voice",
  "webhook",
  "test",
  "sweep",
  "message",
  "unknown",
]);

/** The repository's card origin column has no `unknown`; such turns read as events. */
const storedOrigin = (origin: SquireCardOrigin): SquireRepository.SquireCardRow["origin"] =>
  origin === "unknown" ? "event" : origin;

export const policySquireOf = (
  row: SquireRepository.SquireRow,
): squirePolicy.SquirePolicySquire => ({
  id: row.id,
  role: row.role,
  status: row.status,
  permissions: Option.getOrElse(
    decodePermissions(row.permissions_json),
    () => DEFAULT_SQUIRE_PERMISSIONS,
  ),
  budgets: Option.getOrElse(decodeBudgets(row.budgets_json), () => DEFAULT_SQUIRE_BUDGETS),
  createdAt: row.created_at,
});

export const toRule = (row: SquireRepository.SquireRuleRow) =>
  decodeRule({
    id: row.id,
    squireId: row.squire_id,
    effect: row.effect,
    actionClass: row.action_class,
    targetKind: row.target_kind,
    targetId: row.target_id,
    steerKind: row.steer_kind,
    status: row.status,
    matchCount: row.match_count,
    lastMatchedAt: row.last_matched_at,
    createdAt: row.created_at,
  });

/** The card's budget line. */
export const squireBudgetCaption = (input: {
  readonly actionClass: "steer" | "createThread";
  readonly budgets: squirePolicy.SquirePolicySquire["budgets"];
  readonly threadId: ThreadId | null;
  readonly budgetRows: ReadonlyArray<squirePolicy.SquirePolicyBudgetRow>;
  readonly now: string;
}) => {
  const check = squirePolicy.checkBudget(input);
  if (check.exhausted) {
    return check.recommendingUntil === undefined
      ? "budget reached, recommending only"
      : `budget reached, recommending only until ${check.recommendingUntil}`;
  }
  const kind = input.actionClass === "steer" ? "steer" : "thread";
  const limit =
    input.actionClass === "steer" ? input.budgets.steersPerDay : input.budgets.threadsPerDay;
  const since = Date.parse(input.now) - DAY_MS;
  const used = input.budgetRows.filter(
    (row) => row.kind === kind && Date.parse(row.executedAt) > since,
  ).length;
  return `${Math.max(0, limit - used)} of ${limit} ${kind}s left today`;
};

/** A bounded excerpt: the start of the request, then as much of the end as fits. */
const squireDetailExcerpt = (text: string, max = SQUIRE_DETAIL_MAX_CHARS) => {
  if (text.length <= max) return text;
  const marker = "\n…\n";
  const head = Math.floor(max / 4);
  return `${text.slice(0, head)}${marker}${text.slice(text.length - (max - head - marker.length))}`;
};

// ── Service ───────────────────────────────────────────────────

type Ctx = SquireToolContext;
type CallRun = Ctx["run"];

const make = Effect.gen(function* () {
  const repository = yield* SquireRepository.SquireRepository;
  const scope = yield* SquireScope.SquireScope;
  const containers = yield* SquireContainers.SquireContainers;
  const summaries = yield* SquireSummaries.SquireSummaries;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const providers = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const config = yield* ServerConfig.ServerConfig;
  const delivery = yield* Effect.serviceOption(SquireDelivery.SquireDelivery);
  const launcher = yield* Effect.serviceOption(SquireLaunchAction.SquireLaunchAction);
  const presence = yield* Effect.serviceOption(SquirePresence.SquirePresence);
  const registry = yield* Effect.serviceOption(SquireToolRegistry);
  const sweep = yield* Effect.serviceOption(SquireSweep.SquireSweep);

  const locks = new Map<SquireId, Semaphore.Semaphore>();
  const lockFor = (squireId: SquireId) => {
    let lock = locks.get(squireId);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(squireId, lock);
    }
    return lock;
  };

  /** Built-ins win on a name clash; a registered handler serves only its roles. */
  const registered = (role: SquireRole, name: string) =>
    Option.isNone(registry)
      ? Option.none()
      : Option.filter(registry.value.get(name), (handler) => handler.roles.includes(role));

  const definitionOf = (role: SquireRole, name: string): SquireToolDefinition | undefined =>
    (role === "lead" ? LEAD_DEFINITIONS[name] : undefined) ??
    DEFINITIONS[name] ??
    Option.getOrUndefined(registered(role, name))?.definition;

  const definitions: SquireTools["Service"]["definitions"] = (role) =>
    (SQUIRE_TOOL_NAMES[role] as ReadonlyArray<string>).flatMap((name) => {
      const definition = definitionOf(role, name);
      return definition === undefined ? [] : [definition];
    });

  // ── Log rows ──

  const logRow = (
    ctx: Ctx,
    kind: string,
    data: Record<string, unknown>,
    extra: {
      readonly threadId?: ThreadId | null;
      readonly cardId?: SquireCardId | null;
      readonly taskId?: string | null;
      readonly invocationKey?: string | null;
    } = {},
  ) =>
    repository.insertActionLog({
      squire_id: ctx.squire.id,
      kind,
      room_id: null,
      post_id: null,
      trigger_id: null,
      task_id: extra.taskId ?? null,
      thread_id: extra.threadId ?? null,
      card_id: extra.cardId ?? null,
      event_id: null,
      run_id: ctx.run.runId,
      invocation_key: extra.invocationKey ?? null,
      execution_key: null,
      data_json: encodeLogData(data),
      created_at: ctx.now,
    });

  // The origin is the sending turn's, read back when a Lead message or post is delivered.
  const toolCalled = (ctx: Ctx, result: SquireToolResult, threadId: ThreadId | null) =>
    logRow(
      ctx,
      "tool.called",
      { tool: ctx.tool, result, origin: ctx.run.origin },
      { threadId, invocationKey: ctx.key },
    );

  /** A keyed tool call that only records its refusal. */
  const refuse = (
    ctx: Ctx,
    reason: string,
    text: string,
    options: {
      readonly threadId?: ThreadId | null;
      readonly decision?: Record<string, unknown>;
    } = {},
  ) =>
    repository
      .transaction(
        Effect.gen(function* () {
          const result = refused(reason, text);
          yield* toolCalled(ctx, result, options.threadId ?? null);
          if (options.decision !== undefined) {
            yield* logRow(
              ctx,
              "decision.recorded",
              { tool: ctx.tool, outcome: "refused", reason, ...options.decision },
              { threadId: options.threadId ?? null },
            );
          }
          return result;
        }),
      )
      .pipe(Effect.orElseSucceed(() => refused(reason, text)));

  // ── Reads shared by tools ──

  const budgetRowsOf = (squireId: SquireId, now: string) =>
    repository
      .listBudgetUsage({
        squireId,
        since: DateTime.formatIso(
          DateTime.subtract(DateTime.makeUnsafe(now), { milliseconds: DAY_MS }),
        ),
      })
      .pipe(
        Effect.map((rows) =>
          rows.map((row): squirePolicy.SquirePolicyBudgetRow => ({
            kind: row.kind,
            threadId: row.thread_id,
            executedAt: row.executed_at,
          })),
        ),
      );

  const rulesOf = (squireId: SquireId) =>
    repository
      .listRules({ squireId })
      .pipe(Effect.map((rows) => rows.flatMap((row) => Option.toArray(toRule(row)))));

  const trackersFor = Effect.fn("SquireTools.trackersFor")(function* (threadId: ThreadId) {
    const ids = yield* scope.trackersOf(threadId);
    const trackers: Array<squirePolicy.SquirePolicyTracker> = [];
    for (const id of ids) {
      const row = yield* repository.getSquire(id);
      if (Option.isNone(row)) continue;
      trackers.push({ squire: policySquireOf(row.value), rules: yield* rulesOf(id) });
    }
    return trackers;
  });

  /**
   * The Squire whose item the Lead acts on. A thread several Squires
   * track resolves deterministically: the raiser of the newest item-raised
   * event for it in the Lead's batch, else the owner of its newest open
   * decision item, else its earliest-created tracker.
   */
  const ownerOf = Effect.fn("SquireTools.ownerOf")(function* (ctx: Ctx, threadId: ThreadId) {
    const trackers: Array<SquireRepository.SquireRow> = [];
    for (const id of yield* scope.trackersOf(threadId)) {
      const row = yield* repository.getSquire(id);
      if (Option.isSome(row) && row.value.role !== "lead" && row.value.lifecycle !== "deleting") {
        trackers.push(row.value);
      }
    }
    const tracker = (id: string) => Option.fromNullishOr(trackers.find((row) => row.id === id));
    for (const row of (yield* batchEvents(ctx)).toReversed()) {
      if (row.kind !== "item-raised") continue;
      const event = Option.getOrUndefined(decodeEvent(row.payload_json ?? ""));
      if (event === undefined || isUnknownUnionMember(event)) continue;
      if (event.type !== "item-raised" || event.targetThreadId !== threadId) continue;
      const found = tracker(event.squireId);
      if (Option.isSome(found)) return found;
    }
    const open = yield* repository.listCards({
      targetThreadId: threadId,
      statuses: ["open", "held"],
      kinds: ["steer", "question", "overlap", "proposal"],
    });
    for (const card of open.toReversed()) {
      const found = tracker(card.owner_squire_id);
      if (Option.isSome(found)) return found;
    }
    // `trackersOf` lists in creation order (created_at, then rowid).
    return Option.fromNullishOr(trackers[0]);
  });

  /** A Lead sweep finding, admitted inside the card's transaction. */
  const admitFinding = Effect.fn("SquireTools.admitFinding")(function* (
    ctx: Ctx,
    finding: NonNullable<CardPlan["finding"]>,
  ) {
    if (Option.isNone(sweep)) {
      return { ok: false, reason: "sweep-unavailable", text: SWEEP_UNAVAILABLE } as const;
    }
    return yield* sweep.value.admitFinding({
      lead: ctx.squire,
      batchEvents: yield* batchEvents(ctx),
      threadId: finding.threadId,
      kind: finding.kind,
      now: ctx.now,
    });
  });

  /** The Lead reads any thread one of its Squires tracks. */
  const readable = (ctx: Ctx, threadId: ThreadId) =>
    ctx.squire.role === "lead"
      ? scope.trackersOf(threadId).pipe(Effect.map((ids) => ids.length > 0))
      : scope.isTracked(ctx.squire.id, threadId);

  const notInScope = (threadId: ThreadId) =>
    `Thread ${threadId} is not tracked by this Squire, so it is out of scope.`;

  const projectTitle = (projectId: ProjectId) =>
    projects
      .get(projectId, { includeDeleted: true })
      .pipe(Effect.map((row) => Option.match(row, { onNone: () => "", onSome: (p) => p.title })));

  // ── Run and origin ──

  /**
   * Read once on arrival: the turn in flight, else the last one. Only a run the user's own message started is
   * `user`; an unreadable or missing run is `unknown`, which only recommends. A run that read another Squire's room
   * posts acts as `message` from then on.
   */
  const callRun = Effect.fn("SquireTools.callRun")(function* (
    squireId: SquireId,
    homeThreadId: ThreadId,
  ) {
    const shell = yield* projections.getThreadShell(homeThreadId);
    const runId = shell?.activeRunId ?? shell?.latestRunId ?? null;
    if (runId === null) {
      return { runId: "none", origin: "unknown", batchId: null } satisfies CallRun;
    }
    const { runs } = yield* projections.getThreadRecords(homeThreadId, ["runs"], {
      runIds: [runId],
    });
    const run = runs.find((entry) => entry.id === runId);
    if (run === undefined) return { runId, origin: "unknown", batchId: null } satisfies CallRun;
    const parsed = SquireDelivery.parseSquireMessageId(run.userMessageId);
    const started: SquireCardOrigin = Option.match(parsed, {
      onNone: () => "user",
      onSome: ({ origin: value }) => decodeTurnOrigin(value),
    });
    const origin: SquireCardOrigin =
      !recommendOnlyOrigins.has(started) &&
      (yield* readSquireText(repository, { squireId, runId })).tainted
        ? "message"
        : started;
    const batchId = Option.match(parsed, {
      onNone: () => null,
      onSome: ({ batchId: value }) => value,
    });
    return { runId, origin, batchId } satisfies CallRun;
  });

  // ── Read tools ──

  const latestEventRow = (squireId: SquireId, threadId: ThreadId, runId: string | null) =>
    repository
      .listEvents({
        statuses: ["deferred", "pending", "batched", "delivered", "dropped"],
        threadId,
      })
      .pipe(
        Effect.map((rows) =>
          rows
            .filter((row) => row.squire_id === squireId && isSummaryBearing(row.kind))
            .flatMap((row) => {
              const payload = decodeEventPayload(row.payload_json ?? "");
              return Option.isSome(payload) && (runId === null || payload.value.runId === runId)
                ? [{ row, payload: payload.value }]
                : [];
            })
            .at(-1),
        ),
      );

  const summaryOf = Effect.fn("SquireTools.summaryOf")(function* (
    ctx: Ctx,
    shell: OrchestrationV2ThreadShell,
    turnId: RunId | undefined,
  ) {
    const event = yield* latestEventRow(ctx.squire.id, shell.id, turnId ?? null);
    const runId = turnId ?? event?.payload.runId ?? shell.latestRunId;
    if (runId === null) return null;
    const stored = yield* summaries.read({
      threadId: shell.id,
      runId,
      ...(event?.row.kind === "waiting-on-user" && event.payload.pendingRequest
        ? { stage: `request:${event.payload.pendingRequest.requestId}` as const }
        : {}),
    });
    if (Option.isNone(stored)) return { runId, summary: null };
    const summary: SquireTurnSummary =
      stored.value.status === "complete"
        ? stored.value.summary
        : { ...stored.value.summary, summaryStatus: "partial" };
    const payload = event?.payload;
    const overlay = {
      ...(payload?.outcome ? { outcome: payload.outcome } : {}),
      ...(payload?.pendingRequest?.question
        ? { pendingQuestion: payload.pendingRequest.question }
        : {}),
      ...(payload?.pullRequest
        ? { pullRequest: SquireDelivery.toSummaryPullRequest(payload.pullRequest, summary) }
        : {}),
    };
    return { runId, summary, overlay };
  });

  const listTracked = Effect.fn("SquireTools.listTracked")(function* (ctx: Ctx) {
    const snapshot = yield* projections.getShellSnapshot({ location: "active" });
    const tracked: Array<OrchestrationV2ThreadShell> = [];
    for (const shell of snapshot.threads) {
      if (yield* readable(ctx, shell.id)) tracked.push(shell);
    }
    const shown = tracked
      .toSorted((a, b) => DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt))
      .slice(0, LIST_MAX_THREADS);
    const entries = [];
    const lines: Array<string> = [];
    for (const shell of shown) {
      const project = yield* projectTitle(shell.projectId);
      const found = yield* summaryOf(ctx, shell, undefined);
      const last =
        found?.summary == null
          ? null
          : renderSquireTurnSummary(found.summary, {
              overlay: found.overlay,
              maxChars: LIST_SUMMARY_CHARS,
            });
      entries.push({
        threadId: shell.id,
        title: shell.title,
        project,
        status: shell.status,
        latestTurnId: shell.latestRunId,
        lastSummary: last,
      });
      lines.push(
        `- ${shell.title} (${shell.id}) · ${project} · ${shell.status}`,
        ...(last === null ? [] : [last.replaceAll(/^/gm, "  ")]),
      );
    }
    const more = tracked.length - shown.length;
    const text =
      tracked.length === 0
        ? "You track no threads."
        : [...lines, ...(more > 0 ? [`+${more} more`] : [])].join("\n");
    yield* logRow(ctx, "tool.called", { tool: ctx.tool, threads: tracked.length });
    return ok(text, { threads: entries, total: tracked.length });
  });

  const readShell = Effect.fn("SquireTools.readShell")(function* (ctx: Ctx, threadId: ThreadId) {
    if (!(yield* readable(ctx, threadId))) return null;
    return yield* projections.getThreadShell(threadId);
  });

  const getSummary = Effect.fn("SquireTools.getSummary")(function* (
    ctx: Ctx,
    args: typeof ThreadReadArgs.Type,
  ) {
    const shell = yield* readShell(ctx, args.threadId);
    if (shell === null) return refused("scope", notInScope(args.threadId));
    const found = yield* summaryOf(ctx, shell, args.turnId);
    yield* logRow(
      ctx,
      "tool.called",
      { tool: ctx.tool, turnId: found?.runId ?? null },
      { threadId: shell.id },
    );
    if (found === null) return ok(`${shell.title} has no turns yet.`);
    if (found.summary === null) {
      return ok(`No summary is stored for turn ${found.runId} of ${shell.title} yet.`);
    }
    return ok(renderSquireTurnSummary(found.summary, { overlay: found.overlay }), {
      summary: mergeSquireSummaryOverlay(found.summary, found.overlay),
    });
  });

  const getDetail = Effect.fn("SquireTools.getDetail")(function* (
    ctx: Ctx,
    args: typeof ThreadReadArgs.Type,
  ) {
    const shell = yield* readShell(ctx, args.threadId);
    if (shell === null) return refused("scope", notInScope(args.threadId));
    const runId = args.turnId ?? shell.latestRunId;
    if (runId === null) return ok(`${shell.title} has no turns yet.`);
    const { runs } = yield* projections.getThreadRecords(shell.id, ["runs"], {
      runIds: [runId],
    });
    const run = runs.find((entry) => entry.id === runId);
    if (run === undefined) {
      return refused("not-found", `Turn ${runId} is not a turn of ${shell.title}.`);
    }
    const { messages } = yield* projections.getThreadRecords(shell.id, ["messages"], {
      messageRunIds: [runId],
      messageRoles: ["user", "assistant"],
    });
    const { messages: prompt } = yield* projections.getThreadRecords(shell.id, ["messages"], {
      messageIds: [run.userMessageId],
    });
    const ordered = [
      ...prompt,
      ...messages.filter((message) => message.id !== run.userMessageId),
    ].filter((message) => message.role !== "system" && message.text.trim().length > 0);
    const body = [
      `${shell.title} · turn ${runId} · ${run.status}`,
      ...ordered.map((message) => `${message.role}: ${message.text.trim()}`),
    ].join("\n\n");
    const excerpt = squireDetailExcerpt(body);
    yield* logRow(
      ctx,
      "tool.called",
      { tool: ctx.tool, turnId: runId, chars: excerpt.length },
      { threadId: shell.id },
    );
    return ok(excerpt, { threadId: shell.id, turnId: runId, truncated: excerpt !== body });
  });

  // ── Cards ──

  interface CardPlan {
    readonly kind: "steer" | "proposal" | "fyi";
    readonly targetThreadId: ThreadId | null;
    readonly projectId: ProjectId | null;
    readonly title: string;
    readonly why: string;
    readonly payload: SquireCardPayload;
    readonly trigger: SquireCardTrigger;
    readonly intent: SquireActionIntent | null;
    /** Auto: the card is committed `held` and executes at `executesAt`. */
    readonly hold: { readonly executesAt: string } | null;
    readonly steerKind: SquireSteerKind | null;
    readonly ruleId: SquireRepository.SquireCardRow["rule_id"];
    readonly caption: string | null;
    /** Steer and proposal cards push when Notify is On. */
    readonly push: boolean;
    readonly logData: Record<string, unknown>;
    /** The Squire a Lead card acts for; the raiser otherwise. */
    readonly owner?: SquireId;
    /** A Lead sweep finding, admitted by `SquireSweep` in the card's transaction. */
    readonly finding?: { readonly threadId: ThreadId | null; readonly kind: "steer" | "proposal" };
  }

  type Admitted = { readonly findingKey: string; readonly trigger: SquireCardTrigger };

  /** The task a routed-task turn answers; its cards and quiet row name it. */
  const routedTaskOf = (ctx: Ctx) =>
    ctx.squire.role === "lead" || ctx.run.batchId === null
      ? Effect.succeed(null)
      : repository
          .listBatch(ctx.run.batchId)
          .pipe(
            Effect.map(
              (rows) =>
                rows.find((row) => row.kind === "routed-task" && row.squire_id === ctx.squire.id)
                  ?.state_key ?? null,
            ),
          );

  const cardIdFor = (ctx: Ctx, kind: CardPlan["kind"]) =>
    SquireCardId.make(`card:${kind}:${ctx.squire.id}:${ctx.key.slice(0, 24)}`);

  /**
   * Inside the caller's transaction. An open card of the same
   * (Squire, target, kind) is replaced in place and counted as "updated".
   */
  const writeCard = Effect.fn("SquireTools.writeCard")(function* (
    ctx: Ctx,
    plan: CardPlan,
    finding: Admitted | null = null,
  ) {
    // An item the Lead raises for a typed task is that task's receipt.
    const leadTask =
      ctx.squire.role === "lead" &&
      ctx.run.origin === "user" &&
      plan.kind !== "fyi" &&
      finding === null
        ? `task:${ctx.key.slice(0, 24)}`
        : null;
    const routedTaskId = leadTask ?? (yield* routedTaskOf(ctx));
    // A voice turn's card says whether the note's speaker was verified.
    const speakerVerified =
      ctx.run.origin === "voice" && ctx.run.batchId !== null
        ? SquireDelivery.batchSpeakerVerified(yield* repository.listBatch(ctx.run.batchId))
        : undefined;
    const trigger = finding?.trigger ?? plan.trigger;
    // A sweep finding is its own item, keyed for the dismissal memory.
    const [open] =
      plan.targetThreadId === null || finding !== null
        ? []
        : yield* repository.listCards({
            squireId: ctx.squire.id,
            targetThreadId: plan.targetThreadId,
            kinds: [plan.kind],
            statuses: ["open"],
          });
    const columns = {
      title: plan.title,
      why: plan.why,
      payload_json: encodeCardPayload(plan.payload),
      trigger_json: encodeCardTrigger(
        speakerVerified === undefined ? trigger : { ...trigger, speakerVerified },
      ),
      intent_json: plan.intent === null ? null : encodeSquireActionIntent(plan.intent),
      origin: storedOrigin(ctx.run.origin),
      steer_kind: plan.steerKind,
      rule_id: plan.ruleId,
      owner_squire_id: plan.owner ?? ctx.squire.id,
      ...(routedTaskId === null ? {} : { routed_task_id: routedTaskId }),
    };
    let cardId: SquireCardId;
    let replacedCount = 0;
    // A hold is its own card; in-place replacement applies to open cards only.
    if (open !== undefined && plan.hold === null) {
      cardId = open.id;
      replacedCount = open.replaced_count + 1;
      yield* repository.updateCard({
        id: open.id,
        fromStatuses: ["open"],
        patch: { ...columns, replaced_count: replacedCount },
        updatedAt: ctx.now,
      });
    } else {
      cardId = cardIdFor(ctx, plan.kind);
      yield* repository.insertCard({
        id: cardId,
        squire_id: ctx.squire.id,
        kind: plan.kind,
        status: plan.hold === null ? "open" : "held",
        target_thread_id: plan.targetThreadId,
        project_id: plan.projectId,
        evidence_json: "{}",
        routed_task_id: null,
        finding_key: finding?.findingKey ?? null,
        escalate_at: null,
        opened_at: null,
        executes_at: plan.hold?.executesAt ?? null,
        attempt: plan.hold === null ? 0 : 1,
        command_id: plan.hold === null ? null : squireActionCommandId("execute", cardId, 1),
        execution_key: null,
        dedupe_key: null,
        replaced_count: 0,
        ask_json: null,
        resolution: null,
        created_at: ctx.now,
        updated_at: ctx.now,
        ...columns,
      });
    }
    // The fallback FYI for threads a turn raised nothing on reads these rows
    // by run, so an update writes one too.
    // A hold is not a card until it is undone or refused at execution.
    yield* logRow(
      ctx,
      plan.hold === null ? "card.created" : "action.held",
      {
        kind: plan.kind,
        origin: ctx.run.origin,
        caption: plan.caption,
        ...(plan.hold === null ? {} : { executesAt: plan.hold.executesAt }),
        ...(replacedCount > 0 ? { updated: true, replacedCount } : {}),
        ...plan.logData,
      },
      { threadId: plan.targetThreadId, cardId },
    );
    if (leadTask !== null) {
      yield* logRow(
        ctx,
        "task.routed",
        { toSquireId: plan.owner ?? ctx.squire.id, text: plan.title, via: plan.kind },
        { threadId: plan.targetThreadId, cardId, taskId: leadTask },
      );
    }
    if (plan.ruleId !== null) {
      yield* logRow(
        ctx,
        "rule.matched",
        { ruleId: plan.ruleId, tool: ctx.tool },
        { threadId: plan.targetThreadId, cardId },
      );
      yield* repository.recordRuleMatch({ id: plan.ruleId, matchedAt: ctx.now });
    }
    let wakeLead: SquireId | null = null;
    if (replacedCount === 0) {
      // A hold pushes only if it becomes a card.
      if (plan.push && plan.hold === null) {
        yield* logRow(
          ctx,
          "notification.pushed",
          { kind: plan.kind, source: plan.kind === "fyi" ? "notify" : "card" },
          { threadId: plan.targetThreadId, cardId },
        );
        // Held back while a desktop is active; it reaches the phone on
        // escalation. SquireMobileAttention writes the mobile delivery row.
        if (Option.isSome(presence)) {
          yield* presence.value.holdIntent({
            squireId: ctx.squire.id,
            cardId,
            kind: plan.kind,
            threadId: plan.targetThreadId,
            runId: ctx.run.runId,
            now: ctx.now,
          });
        }
      }
      // A decision item wakes the Lead, as the reactor's question card does.
      if (ctx.squire.role !== "lead") {
        const lead = yield* writeLeadItemEvent(repository, {
          transition: "raised",
          card: {
            id: cardId,
            squire_id: ctx.squire.id,
            kind: plan.kind,
            title: plan.title,
            target_thread_id: plan.targetThreadId,
            status: plan.hold === null ? "open" : "held",
            resolution: null,
          },
          now: ctx.now,
        });
        if (Option.isSome(lead)) wakeLead = lead.value;
      }
    }
    return { cardId, replacedCount, wakeLead };
  });

  /**
   * One keyed transaction: `tool.called`, `decision.recorded`, then the card
   * and its rows. A duplicate committed meanwhile wins, and its result is returned.
   */
  const commitCard = Effect.fn("SquireTools.commitCard")(function* (
    ctx: Ctx,
    plan: CardPlan,
    decision: Record<string, unknown>,
    describe: (written: { readonly cardId: SquireCardId; readonly replacedCount: number }) => {
      readonly text: string;
      readonly structuredContent: Record<string, unknown>;
    },
  ) {
    const written = yield* repository.transaction(
      Effect.gen(function* () {
        // Admitted in the card's transaction, so per-sweep and per-day counts stay exact.
        let finding: Admitted | null = null;
        if (plan.finding !== undefined) {
          const admitted = yield* admitFinding(ctx, plan.finding);
          if (!admitted.ok) {
            const result = refused(admitted.reason, admitted.text);
            yield* toolCalled(ctx, result, plan.targetThreadId);
            yield* logRow(
              ctx,
              "decision.recorded",
              { tool: ctx.tool, outcome: "refused", reason: admitted.reason },
              { threadId: plan.targetThreadId },
            );
            return { result, wakeLead: null };
          }
          finding = admitted;
        }
        const card = yield* writeCard(ctx, plan, finding);
        const described = describe(card);
        const result = ok(described.text, {
          ...described.structuredContent,
          cardId: card.cardId,
          ...(plan.caption === null ? {} : { caption: plan.caption }),
          ...(card.replacedCount > 0 ? { updated: true, replacedCount: card.replacedCount } : {}),
        });
        yield* toolCalled(ctx, result, plan.targetThreadId);
        yield* logRow(
          ctx,
          "decision.recorded",
          { tool: ctx.tool, ...decision },
          { threadId: plan.targetThreadId, cardId: card.cardId },
        );
        return { result, wakeLead: card.wakeLead };
      }),
    );
    if (written.wakeLead !== null && Option.isSome(delivery)) {
      yield* delivery.value.wake(written.wakeLead);
    }
    return written.result;
  });

  const notifyOn = (ctx: Ctx) =>
    squirePolicy.decide({
      actionClass: "notify",
      squire: policySquireOf(ctx.squire),
      rules: [],
      target: {
        threadId: null,
        projectId: ctx.squire.home_project_id,
        staveSpaceId: null,
        staveSagaId: null,
      },
      trackers: [],
      budgetRows: [],
      origin: ctx.run.origin,
      now: ctx.now,
    }).level === "auto";

  /** The undo window, server-owned. */
  const holdUntil = (ctx: Ctx) =>
    DateTime.formatIso(
      DateTime.add(DateTime.makeUnsafe(ctx.now), { seconds: ctx.squire.undo_window_seconds }),
    );

  const updatedText = (replacedCount: number) =>
    replacedCount > 0
      ? ` It replaced the open card for this thread (updated ${replacedCount}×).`
      : "";

  // ── Steers ──

  /**
   * The PR transition in this turn's batch that the steer answers, stored on
   * its card: a run id alone survives a failing check turning green on the
   * same commit, so a rerun-checks hold would still send. The reactor
   * outdates the card, and execution re-checks it, once the PR leaves it.
   */
  const pullRequestTriggerOf = (
    ctx: Ctx,
    threadId: ThreadId,
    steerKind: (typeof SquireSteerArgs.Type)["steerKind"],
  ) =>
    batchEvents(ctx).pipe(
      Effect.map((rows): SquireCardTrigger => {
        const changes = rows.flatMap((row) => {
          if (row.kind !== "pull-request-changed" || row.thread_id !== threadId) return [];
          const payload = decodeEventPayload(row.payload_json ?? "");
          return Option.isSome(payload) && payload.value.pullRequest !== null
            ? [payload.value.pullRequest]
            : [];
        });
        const area = STEER_PULL_REQUEST_AREA[steerKind];
        const change =
          (area === undefined
            ? undefined
            : changes.findLast((candidate) => candidate.transition.startsWith(area))) ??
          changes.at(-1);
        return change === undefined
          ? {}
          : {
              prKey: threadPullRequestKeyOf(change),
              headSha: change.headSha,
              transition: change.transition,
            };
      }),
    );

  const steer = Effect.fn("SquireTools.steer")(function* (
    ctx: Ctx,
    args: typeof SquireSteerArgs.Type,
    send: boolean,
  ) {
    const lead = ctx.squire.role === "lead";
    // The Lead's steer belongs to, and is charged to, the thread's owning Squire.
    const owner = lead
      ? yield* ownerOf(ctx, args.threadId)
      : (yield* scope.isTracked(ctx.squire.id, args.threadId))
        ? Option.some(ctx.squire)
        : Option.none<SquireRepository.SquireRow>();
    const target = Option.isSome(owner) ? yield* scope.targetOf(args.threadId) : Option.none();
    if (Option.isNone(owner) || Option.isNone(target)) {
      return yield* refuse(ctx, "scope", notInScope(args.threadId), {
        decision: { reason: "scope" },
      });
    }
    if (lead && ctx.run.origin === "sweep" && Option.isNone(sweep)) {
      return yield* refuse(ctx, "sweep-unavailable", SWEEP_UNAVAILABLE, {
        threadId: args.threadId,
      });
    }
    const self = policySquireOf(owner.value);
    const budgetRows = yield* budgetRowsOf(owner.value.id, ctx.now);
    const decision = squirePolicy.decide({
      actionClass: "steer",
      squire: self,
      ...(lead ? { lead: policySquireOf(ctx.squire) } : {}),
      rules: yield* rulesOf(owner.value.id),
      target: target.value,
      trackers: yield* trackersFor(args.threadId),
      budgetRows,
      origin: ctx.run.origin,
      steerKind: args.steerKind,
      now: ctx.now,
    });
    if (decision.level === "off") {
      return yield* refuse(
        ctx,
        decision.reason,
        decision.reason === "paused"
          ? "This Squire is paused, so it cannot steer."
          : decision.reason === "intersection"
            ? `Steer is Off for ${owner.value.name}, which owns this thread, so you cannot steer or recommend steers on it.`
            : "Steer is Off for this Squire, so it cannot steer or recommend steers.",
        { threadId: args.threadId, decision: { level: decision.level } },
      );
    }
    const held = send && decision.level === "auto";
    const reason: Reason =
      send && decision.reason === "permission" && recommendOnlyOrigins.has(ctx.run.origin)
        ? ctx.run.origin === "voice"
          ? "voice"
          : "origin"
        : decision.reason;
    const shell = yield* projections.getThreadShell(args.threadId);
    const title = shell?.title ?? args.threadId;
    const caption = squireBudgetCaption({
      actionClass: "steer",
      budgets: self.budgets,
      threadId: args.threadId,
      budgetRows,
      now: ctx.now,
    });
    const plan: CardPlan = {
      kind: "steer",
      targetThreadId: args.threadId,
      projectId: target.value.projectId,
      title: squireSteerTitle({
        project: yield* projectTitle(target.value.projectId),
        threadTitle: shell?.title ?? "",
        pullRequest: primaryLink(shell?.pullRequests ?? []) ?? null,
        steerKind: args.steerKind,
        steer: args.steer,
      }),
      why: args.reason,
      payload: {
        type: "steer",
        threadId: args.threadId,
        steer: args.steer,
        steerKind: args.steerKind,
      },
      trigger: {
        ...(shell?.latestRunId ? { runId: shell.latestRunId } : {}),
        ...(yield* pullRequestTriggerOf(ctx, args.threadId, args.steerKind)),
      },
      intent: {
        type: "steer",
        threadId: args.threadId,
        text: args.steer,
        steerKind: args.steerKind,
        dispatchMode: yield* steerDispatchMode(projections, args.threadId),
        precondition: yield* captureSquirePrecondition(projections, args.threadId),
      },
      hold: held ? { executesAt: holdUntil(ctx) } : null,
      steerKind: args.steerKind,
      ruleId: send ? (decision.ruleId ?? null) : null,
      caption,
      push: notifyOn(ctx),
      logData: { steerKind: args.steerKind },
      owner: owner.value.id,
      ...(lead && ctx.run.origin === "sweep"
        ? { finding: { threadId: args.threadId, kind: "steer" as const } }
        : {}),
    };
    return yield* commitCard(
      ctx,
      plan,
      {
        outcome: held ? "held" : "card",
        level: decision.level,
        reason,
        ...(decision.ruleId === undefined ? {} : { ruleId: decision.ruleId }),
        ...(decision.recommendingUntil === undefined
          ? {}
          : { recommendingUntil: decision.recommendingUntil }),
      },
      ({ replacedCount }) => ({
        text: `${
          held
            ? `Held: the steer goes to ${title} in ${ctx.squire.undo_window_seconds} s unless the user undoes it. ${caption}.`
            : send
              ? `Recorded as a recommendation card for ${title}: ${reasonText(reason, ctx.run.origin, decision.recommendingUntil)}. ${caption}.${updatedText(replacedCount)}`
              : `Recommendation card created for ${title}. ${caption}.${updatedText(replacedCount)}`
        }${lead ? ` It belongs to ${owner.value.name}.` : ""}`,
        structuredContent: {
          outcome: held ? "held" : "card",
          reason,
          origin: ctx.run.origin,
          ...(held ? { executesAt: plan.hold!.executesAt } : {}),
          ...(lead ? { ownerSquireId: owner.value.id } : {}),
        },
      }),
    );
  });

  // ── Thread proposals ──

  const isFixtureProject = (workspaceRoot: string) =>
    isFixtureWorkspaceRoot(config.baseDir, workspaceRoot);

  /** By id or name, among projects a project, space, or saga grant covers. */
  const scopedProject = Effect.fn("SquireTools.scopedProject")(function* (
    squireId: SquireId,
    wanted: string,
  ) {
    const grants = yield* repository.listGrants(squireId);
    const all = yield* projects.list();
    const lowered = wanted.trim().toLowerCase();
    const named = all.filter(
      (project) => project.projectId === wanted || project.title.trim().toLowerCase() === lowered,
    );
    for (const project of named) {
      const direct = grants.some(
        (grant) => grant.kind === "project" && grant.target_id === project.projectId,
      );
      if (direct) return Option.some(project);
      if (!grants.some((grant) => grant.kind === "staveSpace" || grant.kind === "staveSaga")) {
        continue;
      }
      const stave = yield* containers.ofProject(project.projectId);
      if (
        stave.status === "known" &&
        grants.some(
          (grant) =>
            (grant.kind === "staveSpace" && grant.target_id === stave.spaceId) ||
            (grant.kind === "staveSaga" && grant.target_id === stave.sagaId),
        )
      ) {
        return Option.some(project);
      }
    }
    return Option.none<ProjectStore.ProjectRow>();
  });

  const defaultModelOf = Effect.fn("SquireTools.defaultModelOf")(function* (
    instance: ProviderInstance,
  ) {
    const models = (yield* instance.snapshot.getSnapshot).models;
    return (models.find((candidate) => candidate.isDefault) ?? models[0])?.slug ?? null;
  });

  const proposal = Effect.fn("SquireTools.proposal")(function* (
    ctx: Ctx,
    args: typeof ThreadProposalArgs.Type & {
      readonly squireId?: SquireId;
      readonly aboutThreadId?: ThreadId;
    },
    create: boolean,
  ) {
    const lead = ctx.squire.role === "lead";
    // The Lead proposes for a named Squire, inside that Squire's grants.
    let owner = ctx.squire;
    if (lead) {
      const named =
        args.squireId === undefined ? Option.none() : yield* repository.getSquire(args.squireId);
      if (
        Option.isNone(named) ||
        named.value.role === "lead" ||
        named.value.lifecycle === "deleting"
      ) {
        return yield* refuse(
          ctx,
          "not-found",
          `${args.squireId ?? "That"} is not one of your Squires. Name the Squire that will track the thread, from squire_list_items or the event header.`,
          { decision: { reason: "not-found" } },
        );
      }
      owner = named.value;
      if (ctx.run.origin === "sweep" && Option.isNone(sweep)) {
        return yield* refuse(ctx, "sweep-unavailable", SWEEP_UNAVAILABLE);
      }
    }
    const project = yield* scopedProject(owner.id, args.project);
    if (Option.isNone(project)) {
      return yield* refuse(
        ctx,
        "scope",
        lead
          ? `Project ${args.project} is not in ${owner.name}'s scope. Propose the thread for a Squire whose grants cover the project.`
          : `Project ${args.project} is not in this Squire's scope. Propose threads only in your scoped projects.`,
        { decision: { reason: "scope" } },
      );
    }
    const instances = (yield* providers.listInstances).filter((instance) => instance.enabled);
    const proposed =
      instances.find((instance) => instance.instanceId === args.provider) ??
      instances.find((instance) => String(instance.driverKind) === args.provider);
    // Fixtures always launch on the scripted instance, never a real provider.
    const fixture =
      (owner.create_request_id?.startsWith("fixture:") ?? false) ||
      isFixtureProject(project.value.workspaceRoot);
    const runner = fixture
      ? instances.find((instance) => String(instance.driverKind) === "scripted")
      : proposed;
    if (runner === undefined) {
      return yield* refuse(
        ctx,
        "provider",
        fixture
          ? "No scripted provider instance is available for this fixture."
          : `No enabled ${args.provider} provider is available.`,
        { decision: { reason: "provider" } },
      );
    }
    const runnerModel =
      runner === proposed && args.model !== undefined ? args.model : yield* defaultModelOf(runner);
    if (runnerModel === null) {
      return yield* refuse(ctx, "provider", `${args.provider} lists no model.`, {
        decision: { reason: "provider" },
      });
    }
    const shownModel =
      args.model ?? (proposed === undefined ? null : yield* defaultModelOf(proposed));

    const stave = yield* containers.ofProject(project.value.projectId);
    const self = policySquireOf(owner);
    const budgetRows = yield* budgetRowsOf(owner.id, ctx.now);
    const decision = squirePolicy.decide({
      actionClass: "createThread",
      squire: self,
      ...(lead ? { lead: policySquireOf(ctx.squire) } : {}),
      rules: yield* rulesOf(owner.id),
      target: {
        threadId: null,
        projectId: project.value.projectId,
        staveSpaceId: stave.status === "known" ? stave.spaceId : null,
        staveSagaId: stave.status === "known" ? stave.sagaId : null,
      },
      trackers: [],
      budgetRows,
      origin: ctx.run.origin,
      now: ctx.now,
    });
    if (decision.level === "off") {
      return yield* refuse(
        ctx,
        decision.reason,
        decision.reason === "paused"
          ? "This Squire is paused, so it cannot propose threads."
          : decision.reason === "intersection"
            ? `Create thread is Off for ${owner.name}, so you cannot propose threads for it.`
            : "Create thread is Off for this Squire, so it cannot propose or create threads.",
        { decision: { level: decision.level } },
      );
    }
    const reason: Reason =
      create && decision.reason === "permission" && recommendOnlyOrigins.has(ctx.run.origin)
        ? ctx.run.origin === "voice"
          ? "voice"
          : "origin"
        : decision.reason;
    const caption = squireBudgetCaption({
      actionClass: "createThread",
      budgets: self.budgets,
      threadId: null,
      budgetRows,
      now: ctx.now,
    });
    const title = firstLine(args.firstPrompt, 120);
    const payload = {
      type: "thread-proposal" as const,
      projectId: project.value.projectId,
      provider: proposed?.driverKind ?? ProviderDriverKind.make(args.provider),
      providerInstanceId: proposed?.instanceId ?? null,
      model: shownModel,
      firstPrompt: args.firstPrompt,
    };
    // A hold stores the full launch input with its
    // deterministic ids; one that cannot be prepared waits for an accept.
    let launch: SquireLaunchAction.SquireLaunchIntent | null = null;
    let unprepared: string | null = null;
    if (create && decision.level === "auto") {
      const prepared = Option.isNone(launcher)
        ? Result.fail("thread creation is not available on this server")
        : yield* launcher.value
            .intentFor({
              card: { id: cardIdFor(ctx, "proposal") },
              squire: ctx.squire,
              proposal: payload,
              text: args.firstPrompt,
              verb: "execute",
              attempt: 1,
            })
            .pipe(
              Effect.map((intent) => Result.succeed(intent)),
              Effect.catch((error) =>
                Effect.succeed(
                  Result.fail(
                    error._tag === "SquireLaunchRefused"
                      ? error.reason
                      : "the thread could not be prepared",
                  ),
                ),
              ),
            );
      if (Result.isSuccess(prepared)) launch = prepared.success;
      else unprepared = prepared.failure;
    }
    const held = launch !== null;
    const plan: CardPlan = {
      kind: "proposal",
      targetThreadId: null,
      projectId: project.value.projectId,
      title,
      why: args.reason,
      payload,
      trigger: {},
      intent: launch === null ? null : { type: "thread-create", launch, precondition: {} },
      hold: held ? { executesAt: holdUntil(ctx) } : null,
      steerKind: null,
      ruleId: create ? (decision.ruleId ?? null) : null,
      caption,
      push: notifyOn(ctx),
      logData: { fixture },
      owner: owner.id,
      ...(lead && ctx.run.origin === "sweep"
        ? { finding: { threadId: args.aboutThreadId ?? null, kind: "proposal" as const } }
        : {}),
    };
    return yield* commitCard(
      ctx,
      plan,
      {
        outcome: held ? "held" : "card",
        level: decision.level,
        reason,
        ...(decision.ruleId === undefined ? {} : { ruleId: decision.ruleId }),
        ...(unprepared === null ? {} : { unprepared }),
      },
      () => ({
        text: held
          ? `Held: the thread is created in ${project.value.title} in ${ctx.squire.undo_window_seconds} s unless the user undoes it. ${caption}.`
          : unprepared !== null
            ? `Recorded as a proposal card in ${project.value.title}: ${unprepared}. ${caption}.`
            : create
              ? `Recorded as a proposal card in ${project.value.title}: ${reasonText(reason, ctx.run.origin, decision.recommendingUntil)}. ${caption}.`
              : `Thread proposal card created in ${project.value.title}${lead ? ` for ${owner.name}` : ""}. ${caption}.`,
        structuredContent: {
          outcome: held ? "held" : "card",
          reason,
          origin: ctx.run.origin,
          ...(held ? { executesAt: plan.hold!.executesAt } : {}),
          ...(lead ? { ownerSquireId: owner.id } : {}),
        },
      }),
    );
  });

  // ── Notify and quiet ──

  const notify = Effect.fn("SquireTools.notify")(function* (
    ctx: Ctx,
    args: typeof NotifyArgs.Type,
  ) {
    if (args.threadId !== undefined && !(yield* readable(ctx, args.threadId))) {
      return yield* refuse(ctx, "scope", notInScope(args.threadId), {
        decision: { reason: "scope" },
      });
    }
    const decision = squirePolicy.decide({
      actionClass: "notify",
      squire: policySquireOf(ctx.squire),
      rules: [],
      target: {
        threadId: args.threadId ?? null,
        projectId: ctx.squire.home_project_id,
        staveSpaceId: null,
        staveSagaId: null,
      },
      trackers: [],
      budgetRows: [],
      origin: ctx.run.origin,
      now: ctx.now,
    });
    if (decision.level === "off") {
      return yield* refuse(
        ctx,
        decision.reason,
        decision.reason === "origin"
          ? `A ${ctx.run.origin} turn never pushes, so nothing was sent.`
          : decision.reason === "paused"
            ? "This Squire is paused, so it cannot notify."
            : "Notify is Off for this Squire, so nothing was sent.",
        { threadId: args.threadId ?? null, decision: { level: decision.level } },
      );
    }
    const threadId = args.threadId ?? null;
    return yield* commitCard(
      ctx,
      {
        kind: "fyi",
        targetThreadId: threadId,
        projectId: null,
        title: firstLine(args.message, 120),
        why: "",
        payload: { type: "fyi", source: "notify", text: args.message, threadId },
        trigger: {},
        intent: null,
        hold: null,
        steerKind: null,
        ruleId: null,
        caption: null,
        push: true,
        logData: { source: "notify" },
      },
      { outcome: "pushed", level: decision.level, reason: decision.reason },
      () => ({ text: "Sent to the user.", structuredContent: { outcome: "pushed" } }),
    );
  });

  const stayQuiet = Effect.fn("SquireTools.stayQuiet")(function* (
    ctx: Ctx,
    args: typeof QuietArgs.Type,
  ) {
    const threadId =
      args.threadId !== undefined && (yield* readable(ctx, args.threadId)) ? args.threadId : null;
    const result = ok("Recorded: no action.", { outcome: "quiet" });
    const taskId = yield* routedTaskOf(ctx);
    yield* repository.transaction(
      Effect.gen(function* () {
        yield* toolCalled(ctx, result, threadId);
        yield* logRow(ctx, "quiet.recorded", { reason: args.reason }, { threadId, taskId });
      }),
    );
    return result;
  });

  // ── Lead ──

  const ITEM_KIND: Record<(typeof ITEM_TYPES)[number], SquireRepository.SquireCardRow["kind"]> = {
    action: "steer",
    question: "question",
    overlap: "overlap",
    proposal: "proposal",
    fyi: "fyi",
  };

  const listItems = Effect.fn("SquireTools.listItems")(function* (
    ctx: Ctx,
    args: typeof ListItemsArgs.Type,
  ) {
    const squires = new Map((yield* repository.listSquires).map((row) => [row.id, row]));
    const items = (yield* repository.listCards({
      statuses: ["open", "held"],
      ...(args.type === undefined ? {} : { kinds: [ITEM_KIND[args.type]] }),
    }))
      .filter(
        (card) =>
          args.squireId === undefined ||
          card.squire_id === args.squireId ||
          card.owner_squire_id === args.squireId,
      )
      .toReversed();
    const shown = items.slice(0, LIST_MAX_ITEMS);
    const entries = [];
    const lines: Array<string> = [];
    for (const card of shown) {
      const raisedBy = squires.get(card.squire_id)?.name ?? card.squire_id;
      const ownedBy = squires.get(card.owner_squire_id)?.name ?? card.owner_squire_id;
      const thread =
        card.target_thread_id === null
          ? null
          : yield* projections.getThreadShell(card.target_thread_id);
      entries.push({
        itemId: card.id,
        kind: card.kind,
        status: card.status,
        title: card.title,
        raisedBy: card.squire_id,
        owner: card.owner_squire_id,
        threadId: card.target_thread_id,
        createdAt: card.created_at,
      });
      lines.push(
        `- [${card.kind}${card.status === "held" ? ", held" : ""}] ${card.title} (${card.id}) · ${raisedBy}${ownedBy === raisedBy ? "" : ` for ${ownedBy}`}${thread === null ? "" : ` · ${thread.title} (${thread.id})`} · ${card.created_at}`,
      );
    }
    const more = items.length - shown.length;
    yield* logRow(ctx, "tool.called", { tool: ctx.tool, items: items.length });
    return ok(
      items.length === 0
        ? "No open items."
        : [...lines, ...(more > 0 ? [`+${more} more`] : [])].join("\n"),
      { items: entries, total: items.length },
    );
  });

  const routeTask = Effect.fn("SquireTools.routeTask")(function* (
    ctx: Ctx,
    args: typeof RouteTaskArgs.Type,
  ) {
    // Only work the user typed; a Squire turn of any origin never routes.
    if (ctx.squire.role !== "lead" || ctx.run.origin !== "user") {
      return yield* refuse(
        ctx,
        "origin",
        "squire_route_task works only in a turn the user's message started, so nothing was routed.",
        { decision: { reason: "origin" } },
      );
    }
    const found = yield* repository.getSquire(args.toSquireId);
    if (Option.isNone(found) || found.value.role === "lead") {
      return yield* refuse(
        ctx,
        "not-found",
        `${args.toSquireId} is not one of your Squires, so nothing was routed.`,
        { decision: { reason: "not-found" } },
      );
    }
    const target = found.value;
    if (target.status === "paused") {
      return yield* refuse(
        ctx,
        "paused",
        `${target.name} is paused, so it cannot take the task. Tell the user; they can resume it from its setup.`,
        { decision: { reason: "paused" } },
      );
    }
    if (target.lifecycle !== "ready" || target.home_thread_id === null) {
      return yield* refuse(
        ctx,
        "inactive",
        `${target.name} is not ready (${target.lifecycle}), so it cannot take the task now.`,
        { decision: { reason: "inactive" } },
      );
    }
    const taskId = SquireTaskId.make(`task:${ctx.key.slice(0, 24)}`);
    return yield* commit(
      ctx,
      null,
      Effect.gen(function* () {
        yield* logRow(
          ctx,
          "task.routed",
          { toSquireId: target.id, text: args.text, reason: args.reason },
          { taskId },
        );
        yield* repository.insertTriggerEvent({
          squire_id: target.id,
          thread_id: null,
          kind: "routed-task",
          state_key: taskId,
          payload_json: encodeEvent({
            type: "routed-task",
            taskId,
            text: args.text,
            reason: args.reason,
          }),
          status: "pending",
          defer_reason: null,
          not_before: ctx.now,
          batch_id: null,
          created_at: ctx.now,
        });
        return {
          result: ok(`Sent to ${target.name}: ${firstLine(args.text, 160)}`, {
            outcome: "routed",
            taskId,
            toSquireId: target.id,
          }),
          wake: [target.id],
        };
      }),
    );
  });

  // ── Dispatch ──

  const decodeArgs = <S extends Schema.Top & { readonly DecodingServices: never }>(
    schema: S,
    args: unknown,
  ) =>
    Schema.decodeUnknownEffect(schema)(withoutNulls(args) ?? {}).pipe(
      Effect.map((value) => ({ ok: true as const, value })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, message: error.message })),
    );

  const runBuiltIn = Effect.fn("SquireTools.runBuiltIn")(function* (ctx: Ctx) {
    const bad = (message: string) =>
      refuse(ctx, "invalid-arguments", `Invalid arguments for ${ctx.tool}: ${message}`);
    switch (ctx.tool) {
      case "squire_list_tracked": {
        const decoded = yield* decodeArgs(NoArgs, ctx.args);
        return decoded.ok ? yield* listTracked(ctx) : yield* bad(decoded.message);
      }
      case "squire_get_summary":
      case "squire_get_detail": {
        const decoded = yield* decodeArgs(ThreadReadArgs, ctx.args);
        if (!decoded.ok) return yield* bad(decoded.message);
        return ctx.tool === "squire_get_summary"
          ? yield* getSummary(ctx, decoded.value)
          : yield* getDetail(ctx, decoded.value);
      }
      case "squire_recommend_steer":
      case "squire_send_steer": {
        const decoded = yield* decodeArgs(SquireSteerArgs, ctx.args);
        if (!decoded.ok) return yield* bad(decoded.message);
        const length = [...decoded.value.steer.trim()].length;
        if (length >= SQUIRE_STEER_MAX_CHARS) {
          return yield* bad(
            `the steer is ${length} characters; shorten it to one action under ${SQUIRE_STEER_MAX_CHARS} characters and call ${ctx.tool} again.`,
          );
        }
        return yield* steer(ctx, decoded.value, ctx.tool === "squire_send_steer");
      }
      case "squire_propose_thread":
      case "squire_create_thread": {
        if (ctx.squire.role === "lead") {
          const decoded = yield* decodeArgs(LeadProposalArgs, ctx.args);
          return decoded.ok
            ? yield* proposal(ctx, decoded.value, false)
            : yield* bad(decoded.message);
        }
        const decoded = yield* decodeArgs(ThreadProposalArgs, ctx.args);
        if (!decoded.ok) return yield* bad(decoded.message);
        return yield* proposal(ctx, decoded.value, ctx.tool === "squire_create_thread");
      }
      case "squire_list_items": {
        const decoded = yield* decodeArgs(ListItemsArgs, ctx.args);
        return decoded.ok ? yield* listItems(ctx, decoded.value) : yield* bad(decoded.message);
      }
      case "squire_route_task": {
        const decoded = yield* decodeArgs(RouteTaskArgs, ctx.args);
        return decoded.ok ? yield* routeTask(ctx, decoded.value) : yield* bad(decoded.message);
      }
      case "squire_notify": {
        const decoded = yield* decodeArgs(NotifyArgs, ctx.args);
        return decoded.ok ? yield* notify(ctx, decoded.value) : yield* bad(decoded.message);
      }
      case "squire_stay_quiet": {
        const decoded = yield* decodeArgs(QuietArgs, ctx.args);
        return decoded.ok ? yield* stayQuiet(ctx, decoded.value) : yield* bad(decoded.message);
      }
      default:
        return yield* bad("unknown tool");
    }
  });

  const READ_TOOLS: ReadonlySet<string> = new Set([
    "squire_list_tracked",
    "squire_get_summary",
    "squire_get_detail",
    "squire_list_items",
  ]);

  // ── Kit (squireToolKit.ts) ──

  /** One keyed transaction: `body`, then `tool.called`; wakes run after the commit. */
  const commit: SquireToolKit["commit"] = Effect.fn("SquireTools.commit")(
    function* (ctx, threadId, body) {
      const written = yield* repository.transaction(
        Effect.gen(function* () {
          const out = yield* body;
          yield* toolCalled(ctx, out.result, threadId);
          return out;
        }),
      );
      if (Option.isSome(delivery)) {
        for (const id of written.wake ?? []) yield* delivery.value.wake(id);
      }
      return written.result;
    },
  );

  const batchEvents: SquireToolKit["batchEvents"] = (ctx) =>
    ctx.run.batchId === null ? Effect.succeed([]) : repository.listBatch(ctx.run.batchId);

  const kit: SquireToolKit = {
    ok,
    refused,
    refuse,
    logRow,
    commit,
    batchEvents,
    decodeArgs,
    holdUntil,
    notifyOn,
    policySquireOf,
    budgetRowsOf,
    trackersFor,
  };

  const storedResult = (key: string) =>
    repository
      .getToolCall(key)
      .pipe(
        Effect.map((row) =>
          Option.flatMap(row, (found) =>
            Option.flatMap(decodeLogData(found.data_json), (data) =>
              decodeStoredResult(data.result),
            ),
          ),
        ),
      );

  // Untraced: the withSpan below keeps the existing span and its tool attribute.
  const call: SquireTools["Service"]["call"] = Effect.fnUntraced(
    function* (caller, name, args) {
      const found = yield* repository.getSquire(caller.squireId);
      if (
        Option.isNone(found) ||
        found.value.role !== caller.role ||
        found.value.home_thread_id !== caller.threadId ||
        found.value.lifecycle === "deleting"
      ) {
        return refused("caller", "This credential does not belong to an active Squire thread.");
      }
      const squire = found.value;
      const runInfo = yield* callRun(squire.id, caller.threadId);
      const now = DateTime.formatIso(yield* DateTime.now);
      const builtIn = DEFINITIONS[name] !== undefined;
      const handler = builtIn ? Option.none() : registered(caller.role, name);
      const allowed =
        (SQUIRE_TOOL_NAMES[caller.role] as ReadonlyArray<string>).includes(name) &&
        (builtIn || Option.isSome(handler));
      const key = squireInvocationKey(caller.squireId, runInfo.runId, name, withoutNulls(args));
      const ctx: Ctx = { caller, squire, run: runInfo, tool: name, key, args, now };
      if (!allowed) {
        // A forbidden or unknown tool is refused and logged, never run.
        return yield* lockFor(squire.id).withPermits(1)(
          Effect.gen(function* () {
            const stored = yield* storedResult(key);
            if (Option.isSome(stored)) return stored.value;
            return yield* refuse(
              ctx,
              "forbidden",
              `${name} is not a tool a ${caller.role === "lead" ? "Lead" : "Squire"} can use.`,
            );
          }),
        );
      }
      const run = Option.match(handler, {
        onNone: () => runBuiltIn,
        // A handler's failure is a defect here: it becomes the internal refusal below.
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- handlers own their error types.
        onSome: (found) => (callCtx: Ctx) => Effect.orDie(found.call(callCtx, kit)),
      });
      const read = Option.match(handler, {
        onNone: () => READ_TOOLS.has(name),
        onSome: (found) => found.read === true,
      });
      if (read) return yield* run(ctx);
      return yield* lockFor(squire.id).withPermits(1)(
        Effect.gen(function* () {
          const stored = yield* storedResult(key);
          if (Option.isSome(stored)) return stored.value;
          return yield* run(ctx).pipe(
            // A duplicate that committed first owns the result.
            Effect.catchCause((cause) =>
              storedResult(key).pipe(
                Effect.flatMap((again) =>
                  Option.isSome(again) ? Effect.succeed(again.value) : Effect.failCause(cause),
                ),
              ),
            ),
          );
        }),
      );
    },
    (effect, caller, name) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Squire tool call failed", { tool: name, cause }).pipe(
            Effect.as(refused("internal", `${name} failed on the server. Try again later.`)),
          ),
        ),
        Effect.withSpan("SquireTools.call", { attributes: { tool: name } }),
      ),
  );

  return SquireTools.of({ definitions, call });
});

export const layer = Layer.effect(SquireTools, make);

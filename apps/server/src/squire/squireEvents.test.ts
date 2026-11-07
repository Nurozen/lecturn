import {
  type ApplicationStoredEvent,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  SquireId,
  ThreadId,
  type OrchestrationV2Actor,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type SquireThreadMarker,
  type ThreadPullRequestLink,
  type ThreadPullRequestSnapshot,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  classifySquireEvent,
  isSummaryBearing,
  scheduleSquireEvent,
  type SquireClassifyContext,
  squireClassifyNeeds,
  SquireEventPayloadJson,
  squireInterruptActor,
  squireStateKey,
} from "./squireEvents.ts";
import { turnItem } from "./testkit/summaryRun.ts";

const now = DateTime.makeUnsafe("2026-11-01T12:00:00.000Z");
const threadId = ThreadId.make("thr_worker");
const projectId = ProjectId.make("proj_billing");
const runId = RunId.make("run-7");
const instanceId = ProviderInstanceId.make("claude-work");
const home: SquireThreadMarker = { squireId: SquireId.make("sq_ops"), role: "home" };
const probe: SquireThreadMarker = { squireId: SquireId.make("sq_ops"), role: "probe" };

const encodePayload = Schema.encodeSync(SquireEventPayloadJson);
const decodePayload = Schema.decodeSync(SquireEventPayloadJson);

const plain: SquireClassifyContext = {
  threadMarker: null,
  interruptedBy: null,
  pendingBackgroundTasks: [],
};

let sequence = 0;
const stored = (
  event: Omit<OrchestrationV2DomainEvent, "id" | "threadId" | "occurredAt"> &
    Partial<Pick<OrchestrationV2DomainEvent, "threadId" | "occurredAt">>,
): ApplicationStoredEvent => {
  sequence++;
  return {
    sequence,
    commandId: CommandId.make(`cmd-${sequence}`),
    event: {
      id: EventId.make(`evt-${sequence}`),
      threadId,
      occurredAt: now,
      ...event,
    } as OrchestrationV2DomainEvent,
  };
};

const run = (status: OrchestrationV2Run["status"], id = runId): OrchestrationV2Run => ({
  id,
  threadId,
  ordinal: 1,
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "claude-opus-5" },
  providerThreadId: null,
  userMessageId: MessageId.make("msg-user"),
  rootNodeId: null,
  activeAttemptId: null,
  status,
  requestedAt: now,
  startedAt: now,
  completedAt: now,
  checkpointId: null,
  contextHandoffId: null,
});
const runUpdated = (status: OrchestrationV2Run["status"], id = runId) =>
  stored({ type: "run.updated", runId: id, payload: run(status, id) });

const requestedAt = DateTime.makeUnsafe("2026-11-01T11:00:00.000Z");
const request = (
  kind: OrchestrationV2RuntimeRequest["kind"],
  status: OrchestrationV2RuntimeRequest["status"] = "pending",
  id = "req-1",
) =>
  stored({
    type: "runtime-request.updated",
    runId,
    payload: {
      id: RuntimeRequestId.make(id),
      nodeId: NodeId.make("node-1"),
      providerTurnId: null,
      nativeRequestRef: null,
      kind,
      status,
      responseCapability: { type: "message" },
      createdAt: requestedAt,
      resolvedAt: null,
    },
  });

const itemUpdated = (item: OrchestrationV2TurnItem) =>
  stored({ type: "turn-item.updated", threadId: item.threadId, payload: item });

const snapshot = (
  overrides: Partial<ThreadPullRequestSnapshot> = {},
): ThreadPullRequestSnapshot => ({
  state: "open",
  title: "Fix invoice rounding",
  headBranch: "fix/rounding",
  baseBranch: "main",
  isDraft: false,
  updatedAt: "2026-11-01T11:59:00.000Z",
  syncedAt: "2026-11-01T12:00:00.000Z",
  checksState: "pending",
  mergeability: "unknown",
  headSha: "9f2c4e1aa0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5",
  ...overrides,
});
const link = (
  snap: ThreadPullRequestSnapshot | null,
  overrides: Partial<ThreadPullRequestLink> = {},
): ThreadPullRequestLink => ({
  host: "github.com",
  repository: "acme/billing-service",
  number: 321,
  url: "https://github.com/acme/billing-service/pull/321",
  source: "created",
  linkedAt: "2026-11-01T10:00:00.000Z",
  snapshot: snap,
  stack: null,
  ...overrides,
});
const linkUpdated = (value: ThreadPullRequestLink) =>
  stored({ type: "thread.pull-request-link-updated", payload: value });

const appThread = (squire?: SquireThreadMarker): OrchestrationV2AppThread => ({
  createdBy: "user",
  creationSource: "web",
  id: threadId,
  projectId,
  title: "Worker",
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "claude-opus-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
  ...(squire ? { squire } : {}),
});

const keys = (event: ApplicationStoredEvent, context = plain) =>
  classifySquireEvent(event, context).candidates.map((candidate) => candidate.stateKey);
const kinds = (event: ApplicationStoredEvent, context = plain) =>
  classifySquireEvent(event, context).candidates.map((candidate) => candidate.kind);
const effects = (event: ApplicationStoredEvent, context = plain) =>
  classifySquireEvent(event, context).effects;

describe("run terminals (P3.1, D1, D3)", () => {
  it("a completed run is turn-finished keyed by the run id, outcome finished", () => {
    const [candidate] = classifySquireEvent(runUpdated("completed"), plain).candidates;
    expect(candidate).toMatchObject({
      kind: "turn-finished",
      threadId,
      stateKey: runId,
      payload: { outcome: "finished", runId, pendingRequest: null, pullRequest: null },
    });
  });

  it("a failed run is thread-stopped with outcome error", () => {
    const [candidate] = classifySquireEvent(runUpdated("failed"), plain).candidates;
    expect(candidate).toMatchObject({ kind: "thread-stopped", payload: { outcome: "error" } });
  });

  const stop = (status: "interrupted" | "cancelled", interruptedBy: OrchestrationV2Actor | null) =>
    classifySquireEvent(runUpdated(status), { ...plain, interruptedBy }).candidates;

  it.each(["interrupted", "cancelled"] as const)("a user %s run yields nothing", (status) => {
    expect(stop(status, "user")).toEqual([]);
  });

  it.each([
    ["agent", "interrupted"],
    ["system", "interrupted"],
    ["agent", "cancelled"],
    [null, "interrupted"],
    [null, "cancelled"],
  ] as const)("a stop by %s (%s) is thread-stopped, outcome stopped", (actor, status) => {
    expect(stop(status, actor)).toMatchObject([
      { kind: "thread-stopped", stateKey: runId, payload: { outcome: "stopped" } },
    ]);
  });

  it.each(["preparing", "queued", "waiting", "rolled_back"] as const)(
    "a %s run yields no candidate",
    (status) => {
      expect(kinds(runUpdated(status))).toEqual([]);
    },
  );

  it("a starting or running run drops deferred turn-finished rows; run.created too", () => {
    const started = { type: "run-started", threadId, runId };
    expect(effects(runUpdated("running"))).toEqual([started]);
    expect(effects(runUpdated("starting"))).toEqual([started]);
    expect(effects(stored({ type: "run.created", runId, payload: run("starting") }))).toEqual([
      started,
    ]);
    expect(effects(stored({ type: "run.created", runId, payload: run("queued") }))).toEqual([]);
  });

  it("repeated updates of one completed run share one key", () => {
    expect(keys(runUpdated("completed"))).toEqual(keys(runUpdated("completed")));
    expect(keys(runUpdated("completed", RunId.make("run-8")))).not.toEqual(
      keys(runUpdated("completed")),
    );
  });
});

describe("squireInterruptActor (D3)", () => {
  const interrupt = (createdBy?: OrchestrationV2Actor, forRun: string = runId) =>
    turnItem("run_interrupt_request", {
      runId: forRun,
      message: "stop",
      ...(createdBy ? { createdBy } : {}),
    });

  it("reads the run's last interrupt request; missing provenance is the user's", () => {
    expect(squireInterruptActor([interrupt("agent")], runId)).toBe("agent");
    expect(squireInterruptActor([interrupt("system")], runId)).toBe("system");
    expect(squireInterruptActor([interrupt()], runId)).toBe("user");
    expect(squireInterruptActor([interrupt("user"), interrupt("agent")], runId)).toBe("agent");
  });

  it("is null without an interrupt request for that run (crash, reconcile)", () => {
    expect(squireInterruptActor([], runId)).toBeNull();
    expect(squireInterruptActor([interrupt("user", "run-other")], runId)).toBeNull();
  });

  it("feeds the classifier: old history stays silent, a crash wakes", () => {
    const actor = (items: ReadonlyArray<OrchestrationV2TurnItem>) =>
      squireInterruptActor(items, runId);
    expect(
      kinds(runUpdated("interrupted"), { ...plain, interruptedBy: actor([interrupt()]) }),
    ).toEqual([]);
    expect(kinds(runUpdated("interrupted"), { ...plain, interruptedBy: actor([]) })).toEqual([
      "thread-stopped",
    ]);
  });
});

describe("waiting-on-user (P3.1, D1)", () => {
  it("a pending user_input request waits on input, keyed by request id, threshold from createdAt", () => {
    const [candidate] = classifySquireEvent(request("user_input"), plain).candidates;
    expect(candidate).toMatchObject({
      kind: "waiting-on-user",
      stateKey: "req-1",
      timing: { reason: "threshold", at: requestedAt },
      payload: {
        outcome: "waiting-on-input",
        runId,
        pendingRequest: {
          kind: "user_input",
          requestId: "req-1",
          createdAt: "2026-11-01T11:00:00.000Z",
        },
      },
    });
  });

  it.each([
    "command",
    "file-change",
    "permission",
    "mcp-elicitation",
    "dynamic_tool_call",
  ] as const)("a pending %s request waits on approval", (kind) => {
    expect(classifySquireEvent(request(kind), plain).candidates).toMatchObject([
      { kind: "waiting-on-user", payload: { outcome: "waiting-on-approval" } },
    ]);
  });

  it("auth_refresh is never an event, pending or not", () => {
    expect(classifySquireEvent(request("auth_refresh"), plain)).toEqual({
      candidates: [],
      effects: [],
    });
    expect(effects(request("auth_refresh", "resolved"))).toEqual([]);
  });

  it.each(["resolved", "expired", "cancelled"] as const)(
    "a %s request resolves its row and cards",
    (status) => {
      expect(classifySquireEvent(request("user_input", status), plain)).toEqual({
        candidates: [],
        effects: [{ type: "request-resolved", threadId, requestId: "req-1" }],
      });
    },
  );

  it("a pending secret request waits on input with its label as the question", () => {
    const item = turnItem("secret_request", {
      threadId,
      label: "STRIPE_KEY",
      reason: "to run the billing tests",
      secretStatus: "pending",
      status: "waiting",
      startedAt: requestedAt,
    });
    expect(classifySquireEvent(itemUpdated(item), plain).candidates).toMatchObject([
      {
        kind: "waiting-on-user",
        stateKey: item.id,
        timing: { reason: "threshold", at: requestedAt },
        payload: {
          outcome: "waiting-on-input",
          pendingRequest: {
            kind: "secret",
            requestId: item.id,
            question: "STRIPE_KEY: to run the billing tests",
          },
        },
      },
    ]);
    const saved = turnItem("secret_request", {
      id: item.id,
      threadId,
      label: "STRIPE_KEY",
      reason: "",
      secretStatus: "saved",
    });
    expect(effects(itemUpdated(saved))).toEqual([
      { type: "request-resolved", threadId, requestId: item.id },
    ]);
  });

  it("not_before is createdAt plus the Squire's own threshold", () => {
    const [candidate] = classifySquireEvent(request("user_input"), plain).candidates;
    expect(scheduleSquireEvent(candidate!.timing, { waitingThresholdMinutes: 30 })).toEqual({
      status: "deferred",
      defer_reason: "threshold",
      not_before: "2026-11-01T11:30:00.000Z",
    });
    expect(scheduleSquireEvent(candidate!.timing, { waitingThresholdMinutes: 5 })).toMatchObject({
      not_before: "2026-11-01T11:05:00.000Z",
    });
  });
});

describe("background work (A9)", () => {
  it("a completed run with completion-holding work defers on background", () => {
    // Commands and monitors hold completion only when the agent awaits them (#24610).
    for (const task of [
      { kind: "subagent" },
      { kind: "background_task" },
      { kind: "monitor", awaited: true },
      { kind: "command", awaited: true },
    ] as const) {
      const [candidate] = classifySquireEvent(runUpdated("completed"), {
        ...plain,
        pendingBackgroundTasks: [task],
      }).candidates;
      expect(scheduleSquireEvent(candidate!.timing, { waitingThresholdMinutes: 30 })).toEqual({
        status: "deferred",
        defer_reason: "background",
        not_before: "2026-11-01T12:00:20.000Z",
      });
    }
  });

  it("a background command alone does not hold completion: the summary wait applies", () => {
    const [candidate] = classifySquireEvent(runUpdated("completed"), {
      ...plain,
      pendingBackgroundTasks: [{ kind: "command" }],
    }).candidates;
    expect(scheduleSquireEvent(candidate!.timing, { waitingThresholdMinutes: 30 })).toEqual({
      status: "deferred",
      defer_reason: "summary",
      not_before: "2026-11-01T12:00:20.000Z",
    });
  });

  it("a monitor the agent does not await does not hold completion either", () => {
    const [candidate] = classifySquireEvent(runUpdated("completed"), {
      ...plain,
      pendingBackgroundTasks: [{ kind: "monitor" }],
    }).candidates;
    expect(candidate!.timing.reason).toBe("summary");
  });

  it("stops never defer on background", () => {
    const [candidate] = classifySquireEvent(runUpdated("failed"), {
      ...plain,
      pendingBackgroundTasks: [{ kind: "subagent" }],
    }).candidates;
    expect(candidate!.timing.reason).toBe("summary");
  });

  it("a finished background item or a cancellation re-evaluates the thread", () => {
    const ended = { type: "background-work-ended", threadId };
    const finished = turnItem("command_execution", {
      threadId,
      input: "vp test",
      status: "completed",
    });
    const running = turnItem("command_execution", {
      threadId,
      input: "vp test",
      status: "running",
    });
    expect(effects(itemUpdated(finished))).toEqual([ended]);
    expect(effects(itemUpdated(running))).toEqual([]);
    expect(
      effects(
        stored({
          type: "run.background-work-cancelled",
          runId,
          payload: { runId, restartCancelledBackgroundWork: [] },
        }),
      ),
    ).toEqual([ended]);
  });
});

describe("pull-request-changed (P3.3, D20)", () => {
  const sha = (n: number) => `${n}`.repeat(40);
  const prKey = (n: number, state: string) =>
    `github.com/acme/billing-service#321:${sha(n)}:${state}`;

  it("fail, pass, fail on three heads gives three distinct keys", () => {
    const transitions = [
      linkUpdated(link(snapshot({ headSha: sha(1), checksState: "failing" }))),
      linkUpdated(link(snapshot({ headSha: sha(2), checksState: "passing" }))),
      linkUpdated(link(snapshot({ headSha: sha(3), checksState: "failing" }))),
    ].flatMap((event) => keys(event));
    expect(transitions).toEqual([
      prKey(1, "checks:failed"),
      prKey(2, "checks:passed"),
      prKey(3, "checks:failed"),
    ]);
    expect(new Set(transitions).size).toBe(3);
  });

  it("a repeated state on the same head gives the same key", () => {
    const first = linkUpdated(link(snapshot({ checksState: "failing", title: "A" })));
    const again = linkUpdated(link(snapshot({ checksState: "failing", title: "B" })));
    expect(keys(again)).toEqual(keys(first));
  });

  it("pending checks and unknown mergeability are never states", () => {
    expect(keys(linkUpdated(link(snapshot())))).toEqual([]);
    expect(
      keys(linkUpdated(link(snapshot({ checksState: null, mergeability: undefined })))),
    ).toEqual([]);
  });

  it("one snapshot yields one candidate per absolute state", () => {
    const event = linkUpdated(
      link(
        snapshot({
          headSha: sha(4),
          checksState: "failing",
          reviewDecision: "changes-requested",
          mergeability: "conflicting",
        }),
      ),
    );
    expect(keys(event)).toEqual([
      prKey(4, "checks:failed"),
      prKey(4, "review:changes-requested"),
      prKey(4, "mergeable:conflicting"),
    ]);
    expect(kinds(event)).toEqual(Array(3).fill("pull-request-changed"));
  });

  it("merged and closed are terminal states alone", () => {
    expect(
      keys(
        linkUpdated(link(snapshot({ headSha: sha(5), state: "merged", checksState: "passing" }))),
      ),
    ).toEqual([prKey(5, "merged")]);
    expect(keys(linkUpdated(link(snapshot({ headSha: sha(5), state: "closed" }))))).toEqual([
      prKey(5, "closed"),
    ]);
  });

  it("several PRs on one thread are keyed separately, by repo as well as number", () => {
    const checks = snapshot({ headSha: sha(6), checksState: "failing" });
    const other = keys(
      linkUpdated(
        link(checks, { number: 322, url: "https://github.com/acme/billing-service/pull/322" }),
      ),
    );
    const otherRepo = keys(
      linkUpdated(
        link(checks, { repository: "acme/ledger", url: "https://github.com/acme/ledger/pull/321" }),
      ),
    );
    expect(other).toEqual([`github.com/acme/billing-service#322:${sha(6)}:checks:failed`]);
    expect(otherRepo).toEqual([`github.com/acme/ledger#321:${sha(6)}:checks:failed`]);
    expect(keys(linkUpdated(link(checks)))).not.toEqual(other);
  });

  it("keys a PR with no head sha (Azure DevOps) by its update time (P7.10)", () => {
    const azure = (overrides: Partial<ThreadPullRequestSnapshot>) =>
      linkUpdated(
        link(snapshot({ headSha: undefined, checksState: undefined, ...overrides }), {
          host: "dev.azure.com",
          repository: "acme/billing/_git/billing-service",
        }),
      );
    const prefix = "dev.azure.com/acme/billing/_git/billing-service#321";
    const conflicting = azure({ mergeability: "conflicting" });
    expect(keys(conflicting)).toEqual([
      `${prefix}:updated-20261101115900000:mergeable:conflicting`,
    ]);
    expect(keys(azure({ mergeability: "conflicting", title: "Renamed" }))).toEqual(
      keys(conflicting),
    );
    expect(keys(azure({ state: "merged", updatedAt: "2026-11-02T09:30:00.000Z" }))).toEqual([
      `${prefix}:updated-20261102093000000:merged`,
    ]);
    const [candidate] = classifySquireEvent(conflicting, plain).candidates;
    expect(candidate!.payload.pullRequest?.headSha).toBe("updated-20261101115900000");
    // A head sha, when there is one, still keys the event.
    expect(keys(azure({ mergeability: "conflicting", headSha: sha(8) }))).toEqual([
      `${prefix}:${sha(8)}:mergeable:conflicting`,
    ]);
  });

  it("no snapshot, no revision, or a dismissed stack member yields nothing", () => {
    expect(keys(linkUpdated(link(null)))).toEqual([]);
    expect(
      keys(
        linkUpdated(
          link(snapshot({ headSha: undefined, updatedAt: null, checksState: "failing" })),
        ),
      ),
    ).toEqual([]);
    expect(
      keys(linkUpdated(link(snapshot({ checksState: "failing" }), { source: "stack-dismissed" }))),
    ).toEqual([]);
  });

  it("stores the link snapshot of that event as the overlay", () => {
    const watched = link(snapshot({ headSha: sha(7), checksState: "failing" }), {
      watch: {
        startedAt: "2026-11-01T10:00:00.000Z",
        headSha: null,
        failedChecks: [],
        passed: false,
        passedChecks: [],
        remarksThrough: "2026-11-01T10:00:00.000Z",
        remarkIds: [],
        conflicting: false,
        wakes: 0,
      },
    });
    const [candidate] = classifySquireEvent(linkUpdated(watched), plain).candidates;
    expect(candidate!.payload).toEqual({
      outcome: null,
      runId: null,
      pendingRequest: null,
      pullRequest: {
        host: "github.com",
        repository: "acme/billing-service",
        number: 321,
        url: "https://github.com/acme/billing-service/pull/321",
        headSha: sha(7),
        transition: "checks:failed",
        state: "open",
        title: "Fix invoice rounding",
        headBranch: "fix/rounding",
        baseBranch: "main",
        checksState: "failing",
        reviewDecision: null,
        mergeability: "unknown",
        threadSelfWatching: true,
      },
    });
    expect(decodePayload(encodePayload(candidate!.payload))).toEqual(candidate!.payload);
  });
});

describe("Squire threads (P1.4, P3.2, D9)", () => {
  const onHome = { ...plain, threadMarker: home };

  it("a home or probe thread's events are never candidates", () => {
    expect(kinds(runUpdated("completed"), onHome)).toEqual([]);
    expect(kinds(request("user_input"), onHome)).toEqual([]);
    expect(kinds(linkUpdated(link(snapshot({ checksState: "failing" }))), onHome)).toEqual([]);
  });

  it("an approval request on a home or probe thread is auto-declined", () => {
    for (const marker of [home, probe]) {
      expect(effects(request("command"), { ...plain, threadMarker: marker })).toEqual([
        {
          type: "auto-decline",
          threadId,
          squire: marker,
          requestId: "req-1",
          requestKind: "command",
        },
      ]);
    }
    expect(effects(request("user_input"), onHome)).toEqual([]);
    expect(effects(request("auth_refresh"), onHome)).toEqual([]);
    expect(effects(request("command", "resolved"), onHome)).toEqual([]);
  });

  it("a Squire-thread run terminal finalizes; a start does not", () => {
    for (const status of [
      "completed",
      "failed",
      "interrupted",
      "cancelled",
      "rolled_back",
    ] as const) {
      expect(effects(runUpdated(status), onHome)).toEqual([
        { type: "squire-run-ended", threadId, squire: home, runId, status },
      ]);
    }
    expect(effects(runUpdated("running"), onHome)).toEqual([]);
    expect(effects(runUpdated("waiting"), onHome)).toEqual([]);
  });
});

describe("cascades", () => {
  it("thread and project lifecycle carry the marker from their own payload", () => {
    expect(effects(stored({ type: "thread.created", payload: appThread() }))).toEqual([
      { type: "thread-created", threadId, projectId, squire: null },
    ]);
    expect(effects(stored({ type: "thread.deleted", payload: appThread(home) }))).toEqual([
      { type: "thread-deleted", threadId, squire: home },
    ]);
    const projectDeleted: ApplicationStoredEvent = {
      sequence: 99,
      eventId: EventId.make("evt-project"),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: "2026-11-01T12:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.deleted",
      payload: { projectId, deletedAt: "2026-11-01T12:00:00.000Z" },
    };
    expect(effects(projectDeleted)).toEqual([{ type: "project-deleted", projectId }]);
    expect(squireClassifyNeeds(projectDeleted)).toEqual({
      threadMarker: false,
      interruptedBy: false,
      pendingBackgroundTasks: false,
    });
  });

  it("streaming output and other thread events are not events (P3.2)", () => {
    const message = turnItem("assistant_message", {
      threadId,
      messageId: "msg-a",
      text: "working",
      streaming: true,
    });
    expect(classifySquireEvent(itemUpdated(message), plain)).toEqual({
      candidates: [],
      effects: [],
    });
    expect(
      classifySquireEvent(stored({ type: "thread.archived", payload: appThread() }), plain),
    ).toEqual({ candidates: [], effects: [] });
  });
});

describe("helpers", () => {
  it("squireClassifyNeeds asks only for what the event uses", () => {
    expect(squireClassifyNeeds(runUpdated("interrupted"))).toEqual({
      threadMarker: true,
      interruptedBy: true,
      pendingBackgroundTasks: false,
    });
    expect(squireClassifyNeeds(runUpdated("completed"))).toMatchObject({
      interruptedBy: false,
      pendingBackgroundTasks: true,
    });
    expect(
      squireClassifyNeeds(stored({ type: "thread.created", payload: appThread() })),
    ).toMatchObject({
      threadMarker: false,
    });
  });

  it("squireClassifyNeeds reads nothing for streaming output or ignored events", () => {
    const streaming = turnItem("assistant_message", {
      threadId,
      messageId: "msg-a",
      text: "working",
      streaming: true,
    });
    expect(squireClassifyNeeds(itemUpdated(streaming)).threadMarker).toBe(false);
    expect(
      squireClassifyNeeds(stored({ type: "thread.archived", payload: appThread() })).threadMarker,
    ).toBe(false);
    const secret = turnItem("secret_request", {
      threadId,
      status: "waiting",
      label: "API key",
      reason: "",
      secretStatus: "pending",
    });
    expect(squireClassifyNeeds(itemUpdated(secret)).threadMarker).toBe(true);
    expect(
      squireClassifyNeeds(
        itemUpdated(turnItem("command_execution", { threadId, input: "sleep 9" })),
      ).threadMarker,
    ).toBe(true);
  });

  it("squireStateKey normalizes the PR key", () => {
    expect(
      squireStateKey({
        kind: "pull-request-changed",
        pullRequest: {
          host: "GitHub.com",
          repository: "Acme/Billing-Service",
          number: 321,
          url: "https://github.com/acme/billing-service/pull/321",
        },
        headSha: "abc",
        state: "merged",
      }),
    ).toBe("github.com/acme/billing-service#321:abc:merged");
  });

  it("only thread events are summary-bearing", () => {
    expect(
      ["turn-finished", "thread-stopped", "waiting-on-user", "pull-request-changed"].every(
        isSummaryBearing,
      ),
    ).toBe(true);
    expect(["voice-note", "message", "webhook-received", "digest-due"].some(isSummaryBearing)).toBe(
      false,
    );
  });
});

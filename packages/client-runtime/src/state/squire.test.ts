import {
  AuthOrchestrationOperateScope,
  DEFAULT_SQUIRE_PERMISSIONS,
  EnvironmentId,
  SQUIRE_RULE_LIMIT_TEXT,
  SquireSnapshot,
  SquireSubscribeEvent,
  UnknownUnionMember,
  WS_METHODS,
  type AuthSessionState,
  type SquireCardId,
  type SquireCardRow,
  type SquireId,
  type SquirePermissions,
  type SquirePullRequestSnapshot,
  type SquireRoomPost,
  type SquireRoomPostId,
  type SquireRouting,
  type SquireRule,
  type SquireRuleId,
  type SquireRuleOffer,
  type SquireTaskId,
  type ThreadId,
} from "@lecturn/contracts";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Queue, Schema, Stream, SubscriptionRef } from "effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { vi } from "vite-plus/test";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { executeAtomQuery } from "./runtime.ts";
import {
  applySquireMention,
  applySquireSubscribeEvent,
  createSquireEnvironmentAtoms,
  holdRemaining,
  squireAcceptOffer,
  squireBudgetCaption,
  squireCardOriginLabels,
  squireCardOrigins,
  squireFollowUpDraft,
  squireOffersFollowUp,
  squireOfferRuleInput,
  squireQuestionPanelQuestions,
  squireQuestionRepeatsTitle,
  squireEntryIndicator,
  squireMentionCompletions,
  squireMentionQuery,
  squireMentionStep,
  squireRoomAuthorLabel,
  squireRoomLogRows,
  squireRoomMarkReadTarget,
  squireRoomMentionState,
  squireRoomNameOf,
  squireRoomPostsInput,
  squireRoomRerouteTargets,
  squireRoomTtlHours,
  squireRoomTtlLabel,
  squireRoomUnread,
  squireRoutingChip,
  squireRowAction,
  squireRuleOfferPrompt,
  squireRuleText,
  squireScopeLine,
  squireSettledLabel,
  squireSidebarState,
  createSquireOpenedTracker,
  squireApprovalControls,
  squireOpenApprovalJump,
  squireApprovalEntries,
  squireAllowRuleInput,
  runSquireAlwaysAllow,
  isSquireStayQuietTool,
  squireQuietRunIds,
  squireSnapshotGestures,
  squireStateLine,
  squireUndoOffer,
  squireVocabularyHints,
  squireCardCaption,
  squireControlText,
  squireDiffStatsLabel,
  squireOverlapThreadLine,
  squireProposalCardText,
  squireProposalPaletteLabel,
  squireProposalPermissionsLabel,
  squireProposalScopeLabels,
  squirePullRequestChips,
  squireQuestionWhyFallback,
  squireRaiserLabel,
  squireRowTargetName,
  squireSameText,
  squireWaitingSince,
  squireWhyText,
  type SquireSnapshotEntry,
  squireUpdateGroups,
  type SquireUpdateItemRole,
} from "./squire.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const grant = (operate: boolean): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: operate ? [AuthOrchestrationOperateScope] : [],
  permissions: operate ? [AuthOrchestrationOperateScope] : [],
});

const environmentId = EnvironmentId.make("env-squire");
const decodeSnapshot = Schema.decodeUnknownSync(SquireSnapshot);
const decodeEvent = Schema.decodeUnknownSync(SquireSubscribeEvent);
const encodeSnapshot = Schema.encodeSync(SquireSnapshot);
const encodeSnapshots = Schema.encodeSync(Schema.Array(SquireSnapshot));
const at = "2026-11-01T10:00:00.000Z";

const snapshot = (
  id: string,
  overrides: {
    role?: "lead" | "squire";
    itemsRevision?: number;
    decisionRevision?: number;
    lifecycle?: string;
    status?: "active" | "paused";
    openDecisionCount?: number;
    held?: ReadonlyArray<{ executesInMs: number }>;
    recentActivity?: ReadonlyArray<{ sequence: number; kind: string; gesture?: string }>;
  } = {},
) =>
  decodeSnapshot({
    squire: {
      id,
      role: overrides.role ?? "squire",
      name: id,
      lifecycle: overrides.lifecycle ?? "ready",
      status: overrides.status ?? "active",
      homeProjectId: "project-a",
      homeThreadId: `thread-${id}`,
      providerInstanceId: null,
      modelSelection: null,
      summaryModelSelection: null,
      brief: "",
      grants: [],
      undoWindowSeconds: 10,
      digest: null,
      sweep: null,
      onboardedAt: null,
      automationPausedAt: null,
      revision: 0,
      createdAt: at,
      updatedAt: at,
    },
    openDecisionCount: overrides.openDecisionCount ?? 0,
    countsByKind: { steer: 0, question: 0, overlap: 0, proposal: 0, fyi: 0 },
    held: (overrides.held ?? []).map((hold, index) => ({
      cardId: `card-held-${index}`,
      kind: "steer",
      targetThreadId: null,
      executesInMs: hold.executesInMs,
    })),
    budget: { steersLeft: 7, threadsLeft: 3 },
    conflicts: [],
    trackedCount: 2,
    containerNames: [],
    recentActivity: (overrides.recentActivity ?? []).map((entry) => ({ ...entry, at })),
    itemsRevision: overrides.itemsRevision ?? 0,
    decisionRevision: overrides.decisionRevision ?? 0,
  });

const environmentEvent = (
  squires: ReadonlyArray<ReturnType<typeof snapshot>>,
  lead: string | null = null,
) =>
  decodeEvent({
    type: "snapshot",
    snapshot: {
      lead,
      squires: encodeSnapshots(squires),
      rooms: [],
    },
  });
const squireEvent = (entry: ReturnType<typeof snapshot>) =>
  decodeEvent({ type: "squire", entry: encodeSnapshot(entry) });

const makeHarness = Effect.fn("Squire.testHarness")(function* (
  client: WsRpcProtocolClient,
  hasProject = true,
) {
  const session: RpcSession = {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: (payload) => client.subscribeServerConfig(payload),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId,
      label: "Squires",
      httpBaseUrl: "https://example.test",
      wsBaseUrl: "wss://example.test",
    }),
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      desired: true,
      network: "online" as const,
      phase: "connected" as const,
      attempt: 1,
      generation: 1,
    }),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const environmentRegistry = EnvironmentRegistry.of({
    run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
    runStream: (_id, stream) => Stream.provideService(stream, EnvironmentSupervisor, supervisor),
    followStream: (_id, stream) => Stream.provideService(stream, EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry["Service"]);
  const projectAtom = Atom.make(hasProject);
  const atoms = createSquireEnvironmentAtoms(
    Atom.runtime(Layer.succeed(EnvironmentRegistry, environmentRegistry)),
    { hasProjectAtom: () => projectAtom },
  );
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
    Effect.sync(() => value.dispose()),
  );
  registry.mount(sessions(environmentId));
  return { atoms, registry };
});

const settle = Effect.gen(function* () {
  for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
});

describe("snapshot state", () => {
  const a = snapshot("squire-a");
  it("applies updates after the snapshot and skips unknown members", () => {
    let state = applySquireSubscribeEvent(null, squireEvent(a), 1);
    expect(state).toBeNull();
    state = applySquireSubscribeEvent(state, environmentEvent([a]), 1);
    state = applySquireSubscribeEvent(
      state,
      squireEvent(snapshot("squire-a", { itemsRevision: 2 })),
      5,
    );
    state = applySquireSubscribeEvent(state, squireEvent(snapshot("squire-b")), 6);
    state = applySquireSubscribeEvent(state, decodeEvent({ type: "lead", lead: "squire-b" }), 6);
    state = applySquireSubscribeEvent(state, decodeEvent({ type: "future-thing" }), 7);
    expect(state?.lead).toBe("squire-b");
    expect(state?.squires.map((e) => [e.squire.id, e.itemsRevision, e.receivedAt])).toEqual([
      ["squire-a", 2, 5],
      ["squire-b", 0, 6],
    ]);
    state = applySquireSubscribeEvent(
      state,
      decodeEvent({ type: "squire-removed", squireId: "squire-a" }),
      8,
    );
    expect(state?.squires.map((e) => e.squire.id)).toEqual(["squire-b"]);
  });
});

it.effect("refreshes one Squire's items only when its own revision changes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<SquireSubscribeEvent>();
      const reads: string[] = [];
      const { atoms, registry } = yield* makeHarness({
        [WS_METHODS.squireSubscribe]: () => Stream.fromQueue(events),
        [WS_METHODS.squireItemsList]: (input: { squireId: string }) =>
          Effect.sync(() => {
            reads.push(input.squireId);
            return { items: [], nextBefore: null, itemsRevision: 0 };
          }),
      } as unknown as WsRpcProtocolClient);
      const unmountState = registry.mount(atoms.state(environmentId));
      yield* Effect.addFinalizer(() => Effect.sync(unmountState));
      yield* Queue.offer(events, environmentEvent([snapshot("squire-a"), snapshot("squire-b")]));
      yield* settle;
      const itemsA = atoms.items({
        environmentId,
        input: { squireId: "squire-a" as SquireId, scope: "open" },
      });
      const itemsB = atoms.items({
        environmentId,
        input: { squireId: "squire-b" as SquireId, scope: "open" },
      });
      const unmountA = registry.mount(itemsA);
      const unmountB = registry.mount(itemsB);
      yield* Effect.addFinalizer(() => Effect.sync(() => (unmountA(), unmountB())));
      yield* Effect.promise(() => executeAtomQuery(registry, itemsA));
      yield* Effect.promise(() => executeAtomQuery(registry, itemsB));
      const count = (id: string) => reads.filter((read) => read === id).length;
      expect([count("squire-a"), count("squire-b")]).toEqual([1, 1]);

      yield* Queue.offer(events, squireEvent(snapshot("squire-a", { itemsRevision: 1 })));
      yield* settle;
      yield* Effect.promise(() => executeAtomQuery(registry, itemsA));
      expect([count("squire-a"), count("squire-b")]).toEqual([2, 1]);

      // Same revision again (e.g. a held countdown update): nothing refetches.
      yield* Queue.offer(
        events,
        squireEvent(snapshot("squire-a", { itemsRevision: 1, held: [{ executesInMs: 5 }] })),
      );
      yield* settle;
      expect([count("squire-a"), count("squire-b")]).toEqual([2, 1]);
    }),
  ),
);

it.effect("lists a created rule in an open rules view, and in one reopened later", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const rules: Array<{ id: string }> = [];
      const { atoms, registry } = yield* makeHarness({
        [WS_METHODS.squireSubscribe]: () => Stream.never,
        [WS_METHODS.squireRuleList]: () => Effect.sync(() => ({ rules: [...rules] })),
        [WS_METHODS.squireRuleCreate]: () =>
          Effect.sync(() => {
            rules.push({ id: `rule-${rules.length}` });
            return { rule: rules.at(-1) };
          }),
      } as unknown as WsRpcProtocolClient);
      registry.set(sessions(environmentId), AsyncResult.success(grant(true)));
      const rulesAtom = atoms.rules({ environmentId, input: { squireId: "squire-a" as SquireId } });
      const shown = () =>
        Option.getOrNull(AsyncResult.value(registry.get(rulesAtom)))?.rules.map((r) => r.id);
      const create = () =>
        Effect.promise(() =>
          atoms.ruleCreate.run(registry, {
            environmentId,
            input: {
              requestId: `request-${rules.length}`,
              squireId: "squire-a",
              effect: "allow",
              actionClass: "steer",
              targetKind: "thread",
              targetId: "thread-a",
            } as never,
          }),
        );

      const unmount = registry.mount(rulesAtom);
      yield* Effect.promise(() => executeAtomQuery(registry, rulesAtom));
      expect(shown()).toEqual([]);
      expect((yield* create())._tag).toBe("Success");
      yield* settle;
      expect(shown()).toEqual(["rule-0"]);

      // Closed while the next rule is saved: reopening refetches instead of serving the cache.
      unmount();
      yield* create();
      const reopened = yield* Effect.promise(() => executeAtomQuery(registry, rulesAtom));
      expect(Option.getOrNull(AsyncResult.value(reopened))?.rules.map((r) => r.id)).toEqual([
        "rule-0",
        "rule-1",
      ]);
    }),
  ),
);

const leadEnsureHarness = (hasProject: boolean) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<SquireSubscribeEvent>();
    let ensures = 0;
    const harness = yield* makeHarness(
      {
        [WS_METHODS.squireSubscribe]: () => Stream.fromQueue(events),
        [WS_METHODS.squireLeadEnsure]: () =>
          Effect.sync(() => {
            ensures++;
            return { squire: snapshot("lead", { role: "lead" }).squire };
          }),
      } as unknown as WsRpcProtocolClient,
      hasProject,
    );
    const unmount = harness.registry.mount(harness.atoms.ensureLead(environmentId));
    yield* Effect.addFinalizer(() => Effect.sync(unmount));
    return { ...harness, events, ensures: () => ensures };
  });

it.effect("ensures the Lead once, and only with the operate permission", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { registry, events, ensures } = yield* leadEnsureHarness(true);
      registry.set(sessions(environmentId), AsyncResult.success(grant(false)));
      yield* Queue.offer(events, environmentEvent([]));
      yield* settle;
      expect(ensures()).toBe(0);

      registry.set(sessions(environmentId), AsyncResult.success(grant(true)));
      yield* settle;
      expect(ensures()).toBe(1);

      yield* Queue.offer(events, environmentEvent([snapshot("squire-a")]));
      yield* Queue.offer(events, environmentEvent([]));
      yield* settle;
      expect(ensures()).toBe(1);
    }),
  ),
);

it.effect("does not ensure a Lead without a project or once one exists", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { registry, events, ensures } = yield* leadEnsureHarness(false);
      registry.set(sessions(environmentId), AsyncResult.success(grant(true)));
      yield* Queue.offer(events, environmentEvent([]));
      yield* settle;
      expect(ensures()).toBe(0);
    }),
  ),
);

describe("gestures from snapshot activity", () => {
  it("plays each entry once, by its server gesture, and nothing on reconnect", () => {
    const activity = snapshot("a", {
      recentActivity: [
        { sequence: 4, kind: "event.received", gesture: "ponder" },
        { sequence: 5, kind: "decision.recorded", gesture: "nod" },
        { sequence: 6, kind: "action.held" },
        { sequence: 7, kind: "event.received", gesture: "a-future-gesture" },
      ],
    }).recentActivity;
    const first = squireSnapshotGestures(3, activity, false);
    expect(first).toEqual({ gestures: ["ponder", "nod", "glance"], lastSeenSequence: 7 });
    expect(squireSnapshotGestures(first.lastSeenSequence, activity, false).gestures).toEqual([]);
    // A fresh client's first snapshot is history.
    expect(squireSnapshotGestures(null, activity, false).gestures).toEqual([]);
  });

  it("greets on creation and on the session's first open, once", () => {
    const created = snapshot("a", {
      recentActivity: [{ sequence: 1, kind: "event.received", gesture: "greet" }],
    }).recentActivity;
    expect(squireSnapshotGestures(0, created, false).gestures).toEqual(["greet"]);
    expect(squireSnapshotGestures(0, created, true).gestures).toEqual(["greet"]);
    expect(squireSnapshotGestures(null, [], true).gestures).toEqual(["greet"]);
  });
});

describe("indicator and header lines", () => {
  // Precedence itself is covered in squireIndicator.test.ts; this checks the snapshot wiring.
  it("reads open items, holds, and needs_provider from the snapshot", () => {
    const waiting = snapshot("a", { openDecisionCount: 2, held: [{ executesInMs: 1 }] });
    expect(squireEntryIndicator(waiting, null)).toMatchObject({ state: "waiting", badge: 2 });
    expect(
      squireEntryIndicator(snapshot("lead", { role: "lead", lifecycle: "needs_provider" }), null)
        .state,
    ).toBe("needs_provider");
  });

  it("writes the state line", () => {
    const line = (
      entry: ReturnType<typeof snapshot>,
      extra: { hasSupportedProvider?: boolean } = {},
    ) =>
      squireStateLine({
        squire: entry.squire,
        indicator: squireEntryIndicator(entry, null),
        openDecisionCount: entry.openDecisionCount,
        heldCount: entry.held.length,
        ...extra,
      });
    expect(line(snapshot("a", { openDecisionCount: 3 }))).toBe(
      "Waiting on you · 3 need a decision",
    );
    expect(line(snapshot("a", { openDecisionCount: 1 }))).toBe(
      "Waiting on you · 1 needs a decision",
    );
    expect(line(snapshot("a", { held: [{ executesInMs: 1 }] }))).toBe(
      "Waiting on you · 1 action held",
    );
    expect(line(snapshot("a"))).toBe("Idle");
    expect(line(snapshot("a", { status: "paused" }))).toBe("Paused");
    const lead = snapshot("lead", { role: "lead", lifecycle: "needs_provider" });
    expect(line(lead)).toBe("Choose a provider for the Lead");
    expect(line(lead, { hasSupportedProvider: false })).toBe("No supported provider");
  });

  it("captions the budget the card spends", () => {
    const entry = snapshot("a");
    const card = (kind: SquireCardRow["kind"], caption: string | null = null) => ({
      kind,
      caption,
    });
    const time = (iso: string) => iso.slice(11, 16);
    expect(squireBudgetCaption(card("steer"), entry, time)).toBe("7 of 10 steers left today");
    expect(squireBudgetCaption(card("proposal"), entry, time)).toBe("3 of 3 threads left today");
    expect(squireBudgetCaption(card("question"), entry, time)).toBeNull();
    const exhausted = {
      ...entry,
      budget: { steersLeft: 0, threadsLeft: 3, recommendingUntil: "2026-11-01T14:00:00.000Z" },
    };
    expect(squireBudgetCaption(card("steer"), exhausted, time)).toBe(
      "budget reached, recommending only until 14:00",
    );
    expect(squireBudgetCaption(card("steer", "custom"), exhausted, time)).toBe("custom");
  });
});

describe("holdRemaining", () => {
  it("counts down from local receipt time, whatever the server clock says", () => {
    // The server's clock may be hours off; only local receipt time and elapsed local time matter.
    const receivedAt = 1_000_000;
    expect(holdRemaining(receivedAt, 10_000, receivedAt)).toBe(10_000);
    expect(holdRemaining(receivedAt, 10_000, receivedAt + 4_000)).toBe(6_000);
    expect(holdRemaining(receivedAt, 10_000, receivedAt + 60_000)).toBe(0);
    // A local clock that stepped back never shows more than the server sent.
    expect(holdRemaining(receivedAt, 10_000, receivedAt - 5_000)).toBe(10_000);
  });
});

describe("labels", () => {
  const card = (overrides: Partial<Pick<SquireCardRow, "origin" | "routedTaskId" | "ruleId">>) =>
    ({
      origin: "event" as SquireCardRow["origin"],
      routedTaskId: null,
      ruleId: null,
      ...overrides,
    }) as Pick<SquireCardRow, "origin" | "routedTaskId" | "ruleId">;
  const text = "Release may auto-send rebase steers on threads in billing-service";

  it("labels card origins", () => {
    const none = () => null;
    expect(squireCardOriginLabels(card({ origin: "sweep" }), none)).toEqual(["Found by Lead"]);
    expect(squireCardOriginLabels(card({ routedTaskId: "task" as never }), none)).toEqual([
      "Routed from Lead",
    ]);
    expect(squireCardOriginLabels(card({ origin: "test" }), none)).toEqual(["Test"]);
    expect(squireCardOriginLabels(card({ origin: "voice" }), none)).toEqual(["Voice note"]);
    expect(
      squireCardOriginLabels({ ...card({ origin: "voice" }), speakerVerified: false }, none),
    ).toEqual(["Voice note · speaker not verified"]);
    expect(
      squireCardOriginLabels({ ...card({ origin: "voice" }), speakerVerified: true }, none),
    ).toEqual(["Voice note"]);
    expect(
      squireCardOriginLabels({ ...card({ origin: "event" }), speakerVerified: false }, none),
    ).toEqual([]);
    expect(
      squireCardOriginLabels(card({ ruleId: "rule" as never }), () => ({ effect: "allow", text })),
    ).toEqual([`Auto by rule: ${text}`]);
    expect(
      squireCardOriginLabels(card({ ruleId: "rule" as never }), () => ({
        effect: "ask-first",
        text: "Release asks first before sending rebase steers on threads in billing-service",
      })),
    ).toEqual([
      "Asked first by rule: Release asks first before sending rebase steers on threads in billing-service",
    ]);
  });

  it("writes rule text the way the server offers it", () => {
    const names = { squireName: "Release", targetName: "billing-service" };
    expect(
      squireRuleText({ effect: "allow", steerKind: "rebase", targetKind: "project" }, names),
    ).toBe(text);
    expect(
      squireRuleText(
        { effect: "ask-first", steerKind: "rerun-checks", targetKind: "thread" },
        { squireName: "Release", targetName: "Currency display" },
      ),
    ).toBe('Release asks first before sending rerun checks steers on "Currency display"');
    expect(squireRuleText({ effect: "allow", steerKind: null, targetKind: "project" }, names)).toBe(
      "Release may auto-create threads in billing-service",
    );
  });

  it("offers a rule, or the limit at the cap", () => {
    const offer = {
      effect: "allow" as const,
      actionClass: "steer" as const,
      targetKind: "thread" as const,
      targetId: "thread-1",
      text,
      capReached: false,
    };
    expect(squireRuleOfferPrompt(offer)).toMatchObject({
      action: "Always allow this",
      text,
      canSave: true,
    });
    expect(squireRuleOfferPrompt({ ...offer, effect: "ask-first", capReached: true })).toEqual({
      action: "Always ask first for this",
      text: SQUIRE_RULE_LIMIT_TEXT,
      canSave: false,
      alternative: null,
    });
  });

  it("writes routing chips", () => {
    const names: Record<string, string> = { r: "Research", lead: "Lead" };
    const chip = (via: unknown, recipients: string[]) =>
      squireRoutingChip({ via, recipients } as unknown as SquireRouting, (id) => names[id] ?? id);
    expect(chip({ kind: "rule", rule: "mention", match: "@Research" }, ["r"])).toBe(
      "Routed to Research · mentioned",
    );
    expect(chip({ kind: "rule", rule: "mention", match: "rerouted by you" }, ["r"])).toBe(
      "Routed to Research · rerouted by you",
    );
    expect(chip({ kind: "rule", rule: "reply", match: "reply to Research" }, ["r"])).toBe(
      "Routed to Research · reply",
    );
    expect(chip({ kind: "rule", rule: "scope", match: "named PR #318" }, ["r"])).toBe(
      "Routed to Research · covers PR #318",
    );
    expect(chip({ kind: "rule", rule: "recent", match: "within 2 min of Research" }, ["r"])).toBe(
      "Routed to Research · recent reply",
    );
    expect(
      chip({ kind: "jev", confidence: 0.91, noReplyNeeded: false, shownToLead: false }, ["r"]),
    ).toBe("Routed to Research · Jev 0.91");
    expect(
      chip({ kind: "jev", confidence: 0.72, noReplyNeeded: false, shownToLead: true }, ["r"]),
    ).toBe("Routed to Research · Jev 0.72 · shown to Lead");
    expect(
      chip({ kind: "jev", confidence: 0.93, noReplyNeeded: true, shownToLead: false }, []),
    ).toBe("No reply needed · Jev 0.93");
    expect(chip({ kind: "fallback", reason: "timeout" }, ["lead"])).toBe("Routed to Lead · rules");
    expect(chip({ kind: "rule", rule: "lead", match: "" }, ["lead"])).toBe(
      "Routed to Lead · rules",
    );
    expect(chip({ kind: "rule", rule: "none", match: "bot messaging is off" }, [])).toBe(
      "Nobody woken · bot messaging is off",
    );
    expect(chip({ kind: "rule", rule: "none", match: " " }, [])).toBe("Nobody woken");
    expect(chip({ kind: "rule", rule: "mention", match: "@Research" }, [])).toBe("Nobody woken");
    expect(chip({ kind: "pending" }, [])).toBe("Routing…");
    // A routing kind this build does not know still reads as routed.
    expect(chip(new UnknownUnionMember("kind", "vote"), ["r"])).toBe("Routed");
  });
});

describe("rooms", () => {
  it("shows unread until this client has seen the latest post", () => {
    const row = { unread: true, muted: false, lastPostAt: "2026-11-01T10:05:00.000Z" };
    expect(squireRoomUnread(row)).toBe(true);
    expect(squireRoomUnread(row, "2026-11-01T10:05:00.000Z")).toBe(false);
    expect(squireRoomUnread(row, "2026-11-01T10:00:00.000Z")).toBe(true);
    expect(squireRoomUnread({ ...row, muted: true })).toBe(false);
    expect(squireRoomUnread({ ...row, unread: false })).toBe(false);
  });

  it("completes @ mentions over members and the Lead", () => {
    const members = [
      { squireId: "r" as SquireId, name: "Research" },
      { squireId: "rel" as SquireId, name: "Release" },
    ];
    const lead = { squireId: "lead" as SquireId, name: "Lead" };
    const mention = squireMentionQuery("ping @re", 8);
    expect(mention).toEqual({ start: 5, query: "re" });
    expect(squireMentionCompletions("re", members, lead).map((c) => c.name)).toEqual([
      "Release",
      "Research",
    ]);
    expect(squireMentionCompletions("", members, lead).map((c) => [c.name, c.isLead])).toEqual([
      ["Lead", true],
      ["Release", false],
      ["Research", false],
    ]);
    expect(squireMentionQuery("mail@example", 12)).toBeNull();
    expect(squireMentionQuery("@re done", 8)).toBeNull();
    // The caret lands just past the space after the inserted name.
    expect(applySquireMention("ping @re now", mention!, "Release")).toEqual({
      text: "ping @Release now",
      cursor: 14,
    });
    expect(applySquireMention("@Res", { start: 0, query: "Res" }, "Research")).toEqual({
      text: "@Research ",
      cursor: 10,
    });
  });

  const roomPost = (
    id: string,
    author: SquireRoomPost["author"],
    recipients: ReadonlyArray<string>,
    via: unknown = { kind: "rule", rule: "mention", match: "@Research" },
  ) =>
    ({
      id,
      author,
      body: `body ${id}`,
      routing: { via, recipients },
      createdAt: at,
    }) as unknown as SquireRoomPost;

  it("reads the newest-first page oldest to newest, with handoff and system rows", () => {
    const rows = squireRoomLogRows([
      roomPost("p4", { kind: "system" }, []),
      roomPost("p3", { kind: "squire", squireId: "rel" as SquireId }, []),
      roomPost("p2", { kind: "squire", squireId: "rel" as SquireId }, ["r"]),
      roomPost("p1", { kind: "user" }, ["r"]),
    ]);
    expect(rows.map((row) => [row.post.id, row.kind])).toEqual([
      ["p1", "post"],
      ["p2", "handoff"],
      ["p3", "post"],
      ["p4", "system"],
    ]);
    expect(rows[1]).toMatchObject({ from: "rel", to: ["r"] });
  });

  it("labels authors and names removed Squires", () => {
    const nameOf = squireRoomNameOf([
      { squire: { id: "r", name: "Research" } },
      { squire: { id: "lead", name: "Lead" } },
    ] as unknown as ReadonlyArray<SquireSnapshotEntry>);
    expect(squireRoomAuthorLabel({ kind: "user" }, nameOf)).toBe("You");
    expect(squireRoomAuthorLabel({ kind: "system" }, nameOf)).toBe("Lecturn");
    expect(squireRoomAuthorLabel({ kind: "lead", squireId: "lead" as SquireId }, nameOf)).toBe(
      "Lead",
    );
    expect(squireRoomAuthorLabel({ kind: "squire", squireId: "gone" as SquireId }, nameOf)).toBe(
      "Removed Squire",
    );
  });

  it("offers reroute to members and the Lead the post has not reached", () => {
    const room = { members: ["r", "rel"] as SquireId[] };
    const lead = "lead" as SquireId;
    expect(squireRoomRerouteTargets(room, lead, roomPost("p", { kind: "user" }, ["r"]))).toEqual([
      "rel",
      "lead",
    ]);
    expect(
      squireRoomRerouteTargets(
        room,
        lead,
        roomPost("p", { kind: "squire", squireId: "rel" as SquireId }, ["lead"]),
      ),
    ).toEqual(["r"]);
    expect(
      squireRoomRerouteTargets(
        room,
        lead,
        roomPost("p", { kind: "user" }, [], { kind: "pending" }),
      ),
    ).toEqual([]);
  });

  it("shows completions only while an @ token matches someone", () => {
    const members = [{ squireId: "r" as SquireId, name: "Research" }];
    const lead = { squireId: "lead" as SquireId, name: "Lead" };
    expect(squireRoomMentionState("hi @le", 6, members, lead)?.candidates).toEqual([
      { squireId: "lead", name: "Lead", isLead: true },
    ]);
    expect(squireRoomMentionState("hi @zz", 6, members, lead)).toBeNull();
    expect(squireRoomMentionState("hi there", 8, members, lead)).toBeNull();
    expect(squireMentionStep(2, 3, 1)).toBe(0);
    expect(squireMentionStep(0, 3, -1)).toBe(2);
    expect(squireMentionStep(0, 0, 1)).toBe(0);
  });

  it("pages posts and words the idle close", () => {
    const roomId = "room" as never;
    expect(squireRoomPostsInput(roomId, null)).toEqual({ roomId, limit: 50 });
    expect(squireRoomPostsInput(roomId, 41 as SquireRoomPostId)).toEqual({
      roomId,
      before: 41,
      limit: 50,
    });
    expect(squireRoomTtlHours({ idleTtlSeconds: 86_400 })).toBe(24);
    expect(squireRoomTtlLabel(24)).toBe("1 day");
    expect(squireRoomTtlLabel(72)).toBe("3 days");
    expect(squireRoomTtlLabel(1)).toBe("1 hour");
    expect(squireRoomTtlLabel(12)).toBe("12 hours");
  });

  it("marks read once per newest post, and only while it is on screen", () => {
    const p1 = 1 as SquireRoomPostId;
    const p2 = 2 as SquireRoomPostId;
    const base = {
      newestPostId: p1,
      lastMarkedPostId: null,
      showingNewest: true,
      canMarkRead: true,
    };
    expect(squireRoomMarkReadTarget(base)).toBe(p1);
    expect(squireRoomMarkReadTarget({ ...base, lastMarkedPostId: p1 })).toBeNull();
    expect(squireRoomMarkReadTarget({ ...base, newestPostId: p2, lastMarkedPostId: p1 })).toBe(p2);
    expect(squireRoomMarkReadTarget({ ...base, showingNewest: false })).toBeNull();
    expect(squireRoomMarkReadTarget({ ...base, canMarkRead: false })).toBeNull();
    expect(squireRoomMarkReadTarget({ ...base, newestPostId: null })).toBeNull();
  });
});

describe("vocabulary hints", () => {
  it("leads with Squire and keeps each term once", () => {
    expect(
      squireVocabularyHints(["billing-service", "Release", " "], ["Release", "squire"]),
    ).toEqual(["Squire", "Release", "billing-service"]);
  });
});

describe("queue cards", () => {
  const RELEASE = "release" as SquireId;
  const LEAD = "lead" as SquireId;
  const THREAD = "thread-1" as ThreadId;
  let sequence = 0;
  const row = (
    kind: SquireCardRow["kind"],
    overrides: Partial<Omit<SquireCardRow, "id">> & { readonly id?: string } = {},
  ): SquireCardRow => {
    sequence += 1;
    const { id, ...rest } = overrides;
    return {
      id: (id ?? `card-${sequence}`) as SquireCardId,
      squireId: RELEASE,
      ownerSquireId: RELEASE,
      kind,
      status: "open",
      title: `${kind} ${sequence}`,
      targetThreadId: THREAD,
      projectId: null,
      origin: "event",
      steerKind: kind === "steer" ? "rebase" : null,
      ruleId: null,
      routedTaskId: null,
      caption: null,
      replacedCount: 0,
      executesAt: null,
      openedAt: null,
      createdAt: at,
      updatedAt: at,
      ...rest,
    };
  };
  const offer = (overrides: Partial<SquireRuleOffer> = {}): SquireRuleOffer => ({
    effect: "allow",
    actionClass: "steer",
    targetKind: "thread",
    targetId: THREAD,
    steerKind: "rebase",
    text: 'Release may auto-send rebase steers on "Fix invoices"',
    alternative: {
      targetKind: "project",
      targetId: "billing",
      text: "Release may auto-send rebase steers on threads in billing-service",
    },
    capReached: false,
    ...overrides,
  });

  it("acts inline only on open cards, expanding what needs the card to answer", () => {
    expect(squireRowAction(row("steer"))).toEqual({ type: "accept", label: "Send steer" });
    expect(squireRowAction(row("proposal"))).toEqual({ type: "accept", label: "Accept" });
    expect(squireRowAction(row("question"))).toEqual({ type: "expand", label: "Answer" });
    expect(squireRowAction(row("overlap"))).toEqual({ type: "expand", label: "Review" });
    expect(squireRowAction(row("fyi", { fyiSource: "summary" }))).toEqual({
      type: "dismiss",
      label: "Dismiss",
    });
    for (const status of ["held", "accepting", "executing", "resolved", "outdated"] as const) {
      expect(squireRowAction(row("steer", { status }))).toBeNull();
    }
  });

  it("offers Keep and Pause on the Lead's inactivity check instead of a Dismiss that pauses", () => {
    const check = row("fyi", { squireId: LEAD, fyiSource: "inactivity" });
    expect(squireRowAction(check)).toEqual({ type: "inactivity" });
    // The title is copy, not identity: a look-alike FYI keeps a plain Dismiss.
    expect(
      squireRowAction(row("fyi", { squireId: LEAD, title: "Keep Squire triggers running?" }))?.type,
    ).toBe("dismiss");
    expect(squireRowAction(row("fyi", { fyiSource: "notify" }))?.type).toBe("dismiss");
  });

  it("quotes the question above the thread's existing draft, once", () => {
    expect(squireFollowUpDraft("Deploy now?\nOr wait?", "")).toBe("> Deploy now?\n> Or wait?\n\n");
    expect(squireFollowUpDraft("Deploy now?", "I think wait")).toBe(
      "> Deploy now?\n\nI think wait",
    );
    const once = squireFollowUpDraft("Deploy now?", "");
    expect(squireFollowUpDraft("Deploy now?", once)).toBe(once);
    const draft = squireFollowUpDraft("Run it?\nNow?", "I think so");
    expect(draft).toBe("> Run it?\n> Now?\n\nI think so");
    expect(squireFollowUpDraft("Run it?\nNow?", draft)).toBe(draft);
  });

  describe("squireScopeLine", () => {
    const squire = (trackedCount: number, containerNames: ReadonlyArray<string> = []) => ({
      squire: { role: "squire" as const },
      trackedCount,
      containerNames,
    });
    const lead = { squire: { role: "lead" as const }, trackedCount: 0, containerNames: [] };

    it("describes a Squire by the threads it watches and its containers", () => {
      expect(squireScopeLine(squire(0), [])).toBe("Watching no threads yet");
      expect(squireScopeLine(squire(1), [])).toBe("Watching 1 thread");
      expect(squireScopeLine(squire(3, ["Release", "Docs"]), [])).toBe(
        "Watching 3 threads · Release, Docs",
      );
    });

    it("describes the Lead by its team, never by threads it watches itself", () => {
      expect(squireScopeLine(lead, [squire(3), squire(1)])).toBe(
        "Leading 2 Squires · 4 threads watched",
      );
      expect(squireScopeLine(lead, [squire(1)])).toBe("Leading 1 Squire · 1 thread watched");
      expect(squireScopeLine(lead, [])).toBe("No Squires yet");
    });

    it("reads as setting up while onboarding proposals show, never beside No Squires yet", () => {
      expect(squireScopeLine(lead, [], 3)).toBe("Setting up your Squires · 3 proposals");
      expect(squireScopeLine(lead, [], 1)).toBe("Setting up your Squires · 1 proposal");
      expect(squireScopeLine(lead, [squire(2)], 2)).toBe(
        "Leading 1 Squire · 2 threads watched · 2 proposals",
      );
    });
  });

  it("offers a follow-up only on a question whose request no longer owns the composer", () => {
    const question = {
      type: "question",
      threadId: "thread-1" as ThreadId,
      requestKind: "runtime",
      requestId: "req-1",
      question: "Deploy now?",
      options: [],
    } as const;
    expect(squireOffersFollowUp(question)).toBe(true);
    expect(
      squireOffersFollowUp({ ...question, request: { type: "approval", canRespond: true } }),
    ).toBe(false);
    // A pending request stays pending even when this client cannot answer it.
    expect(
      squireOffersFollowUp({ ...question, request: { type: "approval", canRespond: false } }),
    ).toBe(false);
    expect(squireOffersFollowUp({ ...question, requestKind: "secret" })).toBe(true);
    expect(
      squireOffersFollowUp({
        type: "steer",
        threadId: "thread-1" as ThreadId,
        steer: "Rebase first",
        steerKind: "rebase",
      }),
    ).toBe(false);
  });

  describe("origin labels", () => {
    const rule: SquireRule = {
      id: "rule-1" as SquireRuleId,
      squireId: RELEASE,
      effect: "allow",
      actionClass: "steer",
      targetKind: "project",
      targetId: "billing",
      steerKind: "rebase",
      status: "active",
      matchCount: 1,
      lastMatchedAt: null,
      createdAt: "2026-11-01T09:00:00.000Z",
    };
    const names = {
      squireName: (id: SquireId) => (id === RELEASE ? "Release" : "Lead"),
      targetName: () => "billing-service",
    };

    it("names the sweep, routing, test, and the rule by its exact text", () => {
      expect(
        squireCardOrigins(
          row("steer", { origin: "sweep", routedTaskId: "task-1" as SquireTaskId }),
          [],
          names,
        ),
      ).toEqual(["Found by Lead", "Routed from Lead"]);
      expect(squireCardOrigins(row("steer", { origin: "test" }), [], names)).toEqual(["Test"]);
      expect(squireCardOrigins(row("steer", { ruleId: rule.id }), [rule], names)).toEqual([
        "Auto by rule: Release may auto-send rebase steers on threads in billing-service",
      ]);
      expect(
        squireCardOrigins(
          row("steer", { ruleId: rule.id }),
          [{ ...rule, effect: "ask-first" }],
          names,
        ),
      ).toEqual([
        "Asked first by rule: Release asks first before sending rebase steers on threads in billing-service",
      ]);
      expect(squireCardOrigins(row("steer"), [rule], names)).toEqual([]);
    });

    it("drops a rule label until the rules load, rather than guessing", () => {
      expect(squireCardOrigins(row("steer", { ruleId: rule.id }), [], names)).toEqual([]);
    });
  });

  describe("rule offers (P8.1)", () => {
    it("offers Always allow this after accepting an eligible steer or proposal", () => {
      expect(squireAcceptOffer(row("steer"), offer())).toMatchObject({
        action: "Always allow this",
        canSave: true,
        text: 'Release may auto-send rebase steers on "Fix invoices"',
      });
      expect(
        squireAcceptOffer(row("proposal"), offer({ actionClass: "createThread" })),
      ).not.toBeNull();
    });

    it("never offers for voice, webhook, test, sweep, or message cards, other steers, or other kinds", () => {
      for (const origin of ["voice", "webhook", "test", "sweep", "message"] as const) {
        expect(squireAcceptOffer(row("steer", { origin }), offer())).toBeNull();
      }
      expect(squireAcceptOffer(row("steer", { steerKind: "other" }), offer())).toBeNull();
      expect(squireAcceptOffer(row("question"), offer())).toBeNull();
      expect(squireAcceptOffer(row("overlap"), offer())).toBeNull();
      expect(squireAcceptOffer(row("fyi"), offer())).toBeNull();
      expect(squireAcceptOffer(row("steer"), undefined)).toBeNull();
      expect(squireAcceptOffer(row("steer"), offer({ effect: "ask-first" }))).toBeNull();
    });

    it("after an Undo offers only ask-first, in its own words", () => {
      expect(squireUndoOffer(offer({ effect: "ask-first" }))).toMatchObject({
        action: "Always ask first for this",
        canSave: true,
      });
      expect(squireUndoOffer(offer())).toBeNull();
      expect(squireUndoOffer(undefined)).toBeNull();
    });

    it("reads the cap and saves nothing at the limit", () => {
      expect(squireAcceptOffer(row("steer"), offer({ capReached: true }))).toEqual({
        action: "Always allow this",
        text: SQUIRE_RULE_LIMIT_TEXT,
        canSave: false,
        alternative: null,
      });
    });

    it("saves the offered target or its one alternative, from the card", () => {
      const card = row("steer", { id: "card-offer" });
      expect(squireOfferRuleInput(offer(), "offer", card)).toEqual({
        squireId: RELEASE,
        effect: "allow",
        actionClass: "steer",
        targetKind: "thread",
        targetId: THREAD,
        steerKind: "rebase",
        fromCardId: "card-offer",
      });
      expect(squireOfferRuleInput(offer(), "alternative", card)).toEqual({
        squireId: RELEASE,
        effect: "allow",
        actionClass: "steer",
        targetKind: "project",
        targetId: "billing",
        steerKind: "rebase",
        fromCardId: "card-offer",
      });
      const { alternative: _alternative, ...single } = offer();
      expect(squireOfferRuleInput(single, "alternative", card)).toMatchObject({
        targetKind: "thread",
        targetId: THREAD,
      });
    });
  });

  describe("evidence (P7.3)", () => {
    const pr = (overrides: Partial<SquirePullRequestSnapshot> = {}): SquirePullRequestSnapshot => ({
      repository: "acme/billing",
      number: 318,
      headSha: "abc123",
      transition: "checks:failed",
      baseBranch: "main",
      checks: { passed: 12, failed: 2, failingJobs: ["api-e2e"] },
      review: "approved",
      mergeable: "blocked-by-checks",
      merged: false,
      closed: false,
      ...overrides,
    });

    it("summarizes PR checks, review, and mergeability as chips", () => {
      expect(squirePullRequestChips(pr()).map((chip) => [chip.label, chip.tone])).toEqual([
        ["2/14 failing", "failing"],
        ["review approved", "passing"],
        ["blocked by checks", "failing"],
      ]);
      expect(
        squirePullRequestChips(
          pr({
            checks: { passed: 4, failed: 0, failingJobs: [] },
            review: "review-required",
            mergeable: "mergeable",
          }),
        ).map((chip) => [chip.label, chip.tone]),
      ).toEqual([
        ["4/4 passing", "passing"],
        ["review required", "pending"],
        ["mergeable", "passing"],
      ]);
    });

    it("shows merged or closed in place of mergeability, and no checks chip without checks", () => {
      const none = { passed: 0, failed: 0, failingJobs: [] };
      expect(
        squirePullRequestChips(pr({ checks: none, review: "none", merged: true })).map(
          (chip) => chip.label,
        ),
      ).toEqual(["merged"]);
      expect(squirePullRequestChips(pr({ closed: true })).at(-1)?.label).toBe("closed");
    });

    it("counts diff files", () => {
      expect(squireDiffStatsLabel({ files: 1 })).toBe("1 file");
      expect(squireDiffStatsLabel({ files: 4 })).toBe("4 files");
    });

    it("captions the budget the open card would spend, or the server's override", () => {
      const entry = {
        budget: { steersLeft: 3, threadsLeft: 0, recommendingUntil: "2026-11-02T00:00:00.000Z" },
        squire: { budgets: { steersPerDay: 10, threadsPerDay: 2 } },
      };
      const time = (iso: string) => iso.slice(11, 16);
      expect(squireCardCaption(row("steer"), entry, time)).toBe("3 of 10 steers left today");
      expect(squireCardCaption(row("proposal"), entry, time)).toBe(
        "budget reached, recommending only until 00:00",
      );
      expect(squireCardCaption(row("question"), entry, time)).toBeNull();
      expect(squireCardCaption(row("steer", { caption: "Held by rule" }), null, time)).toBe(
        "Held by rule",
      );
      expect(squireCardCaption(row("steer", { status: "outdated" }), entry, time)).toBeNull();
      expect(squireCardCaption(row("steer", { status: "held" }), entry, time)).toBeNull();
    });

    it("ages a question from its thread's ask, not from when the card was raised", () => {
      const raised = "2026-11-01T10:45:00.000Z";
      const asked = "2026-11-01T10:00:00.000Z";
      expect(squireWaitingSince({ createdAt: raised, requestedAt: asked })).toBe(asked);
      // Other items, and questions raised before the ask was recorded, age from the card.
      expect(squireWaitingSince({ createdAt: raised })).toBe(raised);
    });

    it("falls back to how long a question's thread has waited", () => {
      expect(squireQuestionWhyFallback("Plan the explorer", "8m")).toBe(
        "Plan the explorer has been waiting on you for 8m",
      );
      expect(squireQuestionWhyFallback("Plan the explorer", "now")).toBe(
        "Plan the explorer is waiting on you since just now",
      );
      expect(squireQuestionWhyFallback(null, "2h")).toBe(
        "This thread has been waiting on you for 2h",
      );
      expect(squireQuestionWhyFallback(" ", "")).toBe("This thread is waiting on you");
    });

    it("hides a Why that only names the card or its thread, spacing and case aside", () => {
      const titles = {
        title: "Should the catalog ship offline-only?",
        threadTitle: "Plan the constellation explorer",
      };
      expect(squireWhyText(" plan the  Constellation explorer ", titles)).toBe("");
      expect(squireWhyText("Should the catalog ship offline-only?", titles)).toBe("");
      expect(squireWhyText("   ", titles)).toBe("");
      expect(squireWhyText("  The build waits on this choice. ", titles)).toBe(
        "The build waits on this choice.",
      );
      expect(
        squireWhyText("Plan the constellation explorer", { ...titles, threadTitle: null }),
      ).toBe("Plan the constellation explorer");
    });
  });

  describe("row names", () => {
    const names = { threadTitle: "Fix invoice rounding", projectTitle: "billing-service" };
    it("names a row by its thread, an overlap by its thread count, a proposal by what it makes", () => {
      expect(squireRowTargetName(row("steer"), names)).toBe("Fix invoice rounding");
      const unthreaded = { targetThreadId: null };
      expect(squireRowTargetName(row("overlap", unthreaded), { ...names, overlapThreads: 2 })).toBe(
        "2 threads · billing-service",
      );
      expect(
        squireRowTargetName(row("overlap", unthreaded), {
          threadTitle: null,
          projectTitle: null,
          overlapThreads: 3,
        }),
      ).toBe("3 threads");
      const threadProposal = row("proposal", {
        ...unthreaded,
        proposalProvider: { provider: "codex" as never, providerInstanceId: null },
      });
      expect(squireRowTargetName(threadProposal, names)).toBe("New thread · billing-service");
      expect(squireRowTargetName(row("proposal", unthreaded), names)).toBe(
        "New Squire · billing-service",
      );
      expect(
        squireRowTargetName(row("proposal", unthreaded), { ...names, projectTitle: null }),
      ).toBeNull();
      // An overlap whose card has not loaded, and an FYI, read as their project and thread.
      expect(squireRowTargetName(row("overlap", unthreaded), names)).toBe("billing-service");
      expect(squireRowTargetName(row("fyi"), names)).toBe("Fix invoice rounding");
    });

    it("names the Lead's own items Lead, and treats spacing and case as the same text", () => {
      expect(squireRaiserLabel({ name: "Steward", role: "lead" })).toBe("Lead");
      expect(squireRaiserLabel({ name: "Release", role: "squire" })).toBe("Release");
      expect(squireSameText(" Fix  invoice\nrounding ", "fix invoice rounding")).toBe(true);
      expect(squireSameText("Fix invoice", "Fix invoices")).toBe(false);
    });
  });

  describe("Lead items (P17.2, P17.6)", () => {
    const RESEARCH = "research" as SquireId;
    const nameOf = (id: SquireId) =>
      id === RESEARCH ? "Research" : id === RELEASE ? "Release" : "?";

    it("reads a control proposal as one line with the reason", () => {
      expect(
        squireControlText(
          { action: "pause", squireId: RESEARCH },
          nameOf,
          " No tracked thread moved in 7 days ",
        ),
      ).toBe("Pause Research: No tracked thread moved in 7 days");
      expect(squireControlText({ action: "resume", squireId: RESEARCH }, nameOf, "")).toBe(
        "Resume Research",
      );
      expect(squireControlText({ action: "rescope", squireId: RELEASE }, nameOf, "")).toBe(
        "Change Release's scope",
      );
      expect(squireControlText({ action: "pause", squireId: null }, nameOf, "")).toBe(
        "Pause a Squire",
      );
    });

    it("names the forward target and counts merged items", () => {
      expect(
        squireControlText(
          {
            action: "forward",
            squireId: RELEASE,
            cardIds: ["c1" as SquireCardId],
            toSquireId: RESEARCH,
          },
          nameOf,
          "",
        ),
      ).toBe("Forward 1 item to Research");
      expect(squireControlText({ action: "forward", squireId: RELEASE }, nameOf, "")).toBe(
        "Forward an item to another Squire",
      );
      expect(
        squireControlText(
          { action: "merge", squireId: null, cardIds: ["a", "b"] as SquireCardId[] },
          nameOf,
          "same thread",
        ),
      ).toBe("Merge 2 items into one: same thread");
    });

    it("names a proposal's scope: projects, spaces, sagas, threads, exclusions counted", () => {
      const names = {
        project: (id: string) => (id === "billing" ? "billing-service" : null),
        thread: (id: string) => (id === "t-named" ? "Fix login" : null),
      };
      expect(
        squireProposalScopeLabels(
          [
            { kind: "project", targetId: "billing" },
            { kind: "project", targetId: "gone" },
            { kind: "staveSpace", targetId: "observatory" },
            { kind: "staveSaga", targetId: "launch" },
            { kind: "thread", targetId: "t-named" },
            { kind: "thread", targetId: "t-gone" },
            { kind: "exclusion", targetId: "t1" },
            { kind: "exclusion", targetId: "t2" },
          ],
          names,
        ),
      ).toEqual([
        "billing-service",
        "A project",
        "Space observatory",
        "Saga launch",
        "Fix login",
        "A thread",
        "2 threads excluded",
      ]);
    });

    it("summarizes permissions as Recommend only by default and names any change", () => {
      const perms = (overrides: Partial<SquirePermissions>): SquirePermissions => ({
        ...DEFAULT_SQUIRE_PERMISSIONS,
        ...overrides,
      });
      expect(squireProposalPermissionsLabel(DEFAULT_SQUIRE_PERMISSIONS)).toBe("Recommend only");
      expect(squireProposalPermissionsLabel(perms({ notify: "off" }))).toBe(
        "Recommend only · Notify off",
      );
      expect(squireProposalPermissionsLabel(perms({ steer: "auto", createThread: "off" }))).toBe(
        "Steer Auto · Create thread Off",
      );
    });

    it("reads a proposal card's name, scope, permissions, brief, and palette", () => {
      expect(
        squireProposalCardText(
          {
            name: " Release ",
            brief: "  ",
            grants: [],
            permissions: { ...DEFAULT_SQUIRE_PERMISSIONS, createThread: "auto", notify: "off" },
          },
          { project: () => null, thread: () => null },
        ),
      ).toEqual({
        name: "Release",
        scope: "No scope yet",
        permissions: "Create thread Auto · Notify off",
        brief: null,
      });
      expect(
        squireProposalCardText(
          {
            name: "Research",
            brief: " Watch release PRs. ",
            grants: [
              { kind: "project", targetId: "obs" },
              { kind: "project", targetId: "billing" },
            ],
            permissions: DEFAULT_SQUIRE_PERMISSIONS,
          },
          {
            project: (id) => (id === "obs" ? "Observatory" : "billing-service"),
            thread: () => null,
          },
        ),
      ).toMatchObject({
        scope: "Observatory · billing-service",
        permissions: "Recommend only",
        brief: "Watch release PRs.",
      });
      expect(squireProposalPaletteLabel("sage")).toBe("Sage");
      expect(squireProposalPaletteLabel("moonstone")).toBe("Moonstone");
    });
  });

  describe("one question, shown once", () => {
    const title = "Should the catalog ship offline-only?";

    it("drops a body line or panel question that only repeats the header's title", () => {
      expect(squireQuestionRepeatsTitle(` ${title} `, title)).toBe(true);
      expect(squireQuestionRepeatsTitle(`${title}\nThe API is rate limited.`, title)).toBe(false);
      const only = { id: "q1", question: title };
      expect(squireQuestionPanelQuestions([only], title)).toEqual([{ id: "q1", question: "" }]);
    });

    it("keeps every question's text when there are several or the title is only the first line", () => {
      const two = [
        { id: "q1", question: title },
        { id: "q2", question: "Which region?" },
      ];
      expect(squireQuestionPanelQuestions(two, title)).toBe(two);
      const longer = [{ id: "q1", question: `${title}\nMore detail.` }];
      expect(squireQuestionPanelQuestions(longer, title)).toBe(longer);
    });
  });
});

describe("squireUpdateGroups", () => {
  type Item = { readonly role: SquireUpdateItemRole };
  const groups = (items: ReadonlyArray<Item>) => squireUpdateGroups(items, (item) => item.role);

  it("spans consecutive wakes with what their turns did, down to one wake", () => {
    expect(
      groups([
        { role: "user" },
        { role: "update" },
        { role: "wake" },
        { role: "update" },
        { role: "wake" },
        { role: "update" },
      ]),
    ).toEqual([{ start: 2, end: 6 }]);
    expect(groups([{ role: "wake" }, { role: "update" }])).toEqual([{ start: 0, end: 2 }]);
  });

  it("splits at the user's own messages and leaves work outside a wake alone", () => {
    expect(
      groups([
        { role: "wake" },
        { role: "update" },
        { role: "user" },
        { role: "update" },
        { role: "wake" },
      ]),
    ).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 5 },
    ]);
  });

  it("never spans a kept row, so a reply or a running turn stays in view", () => {
    expect(groups([{ role: "wake" }, { role: "keep" }, { role: "wake" }])).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 3 },
    ]);
  });
});

describe("squireApprovalEntries", () => {
  const lead = "squire-lead" as SquireId;
  const squire = "squire-a" as SquireId;
  const card = (
    id: string,
    overrides: Partial<
      Pick<SquireCardRow, "kind" | "status" | "squireId" | "createdAt" | "resolution" | "fyiSource">
    > = {},
  ) => ({
    id,
    kind: "steer" as const,
    status: "open" as const,
    squireId: squire,
    createdAt: at,
    ...overrides,
  });

  it("keeps an open inactivity check, the one FYI whose answer matters", () => {
    const rows = [
      card("check", { kind: "fyi", fyiSource: "inactivity" }),
      card("news", { kind: "fyi", fyiSource: "summary" }),
      card("answered", { kind: "fyi", fyiSource: "inactivity", status: "resolved" }),
    ];
    expect(
      squireApprovalEntries(rows, { squireId: squire, isLead: false, chatFirst: true }).map(
        (entry) => entry.row.id,
      ),
    ).toEqual(["check"]);
  });

  it("orders a chat's rows oldest first, leaving FYIs and holds out", () => {
    const entries = squireApprovalEntries(
      [
        card("newer", { createdAt: "2026-11-01T11:00:00.000Z" }),
        card("fyi", { kind: "fyi" }),
        card("held", { status: "held" }),
        card("older", { createdAt: "2026-11-01T10:30:00.000Z" }),
      ],
      { squireId: squire, isLead: false, chatFirst: true },
    );
    expect(entries.map((entry) => entry.row.id)).toEqual(["older", "newer"]);
  });

  it("gives a closed row its outcome and marks an expired one", () => {
    const [expired, denied] = squireApprovalEntries(
      [
        card("expired", { status: "outdated", resolution: "expired" }),
        card("denied", {
          status: "dismissed",
          resolution: "denied",
          createdAt: "2026-11-01T10:01:00.000Z",
        }),
      ],
      { squireId: squire, isLead: false, chatFirst: true },
    );
    expect(expired).toMatchObject({ phase: "closed", outcome: "Expired", expired: true });
    expect(denied).toMatchObject({ phase: "closed", outcome: "Denied", expired: false });
  });

  it("a row belongs to the chat of its raiser on a chat-first server", () => {
    const rows = [card("lead-raised", { squireId: lead }), card("own")];
    expect(
      squireApprovalEntries(rows, { squireId: squire, isLead: false, chatFirst: true }).map(
        (entry) => entry.row.id,
      ),
    ).toEqual(["own"]);
    expect(
      squireApprovalEntries(rows, { squireId: lead, isLead: true, chatFirst: true }).map(
        (entry) => entry.row.id,
      ),
    ).toEqual(["lead-raised"]);
  });

  it("an older server's Squire keeps its whole list; its Lead keeps what it raised", () => {
    const rows = [card("lead-raised", { squireId: lead }), card("own")];
    expect(
      squireApprovalEntries(rows, { squireId: squire, isLead: false, chatFirst: false }).map(
        (entry) => entry.row.id,
      ),
    ).toEqual(["lead-raised", "own"]);
    expect(
      squireApprovalEntries(rows, { squireId: lead, isLead: true, chatFirst: false }).map(
        (entry) => entry.row.id,
      ),
    ).toEqual(["lead-raised"]);
  });
});

describe("squireApprovalEntries on an older server", () => {
  const row = (fyiSource: "summary" | "inactivity") => ({
    id: "fyi",
    kind: "fyi" as const,
    status: "open" as const,
    squireId: "squire-a" as SquireId,
    createdAt: at,
    fyiSource,
  });

  it("keeps a Squire's open notes, with Dismiss, when chat-first is absent", () => {
    const entries = squireApprovalEntries([row("summary")], {
      squireId: "squire-a" as SquireId,
      isLead: false,
      chatFirst: false,
    });
    expect(entries).toHaveLength(1);
    expect(squireApprovalControls(entries[0]! as never, null)).toMatchObject({ deny: "Dismiss" });
  });
});

describe("squireApprovalControls", () => {
  const offer: SquireRuleOffer = {
    effect: "allow",
    actionClass: "steer",
    targetKind: "thread",
    targetId: "thread-1",
    text: "Research may auto-send review-feedback steers",
    capReached: false,
  };
  const base = {
    id: "card-1" as SquireCardId,
    squireId: "squire-a" as SquireId,
    createdAt: at,
    status: "open" as const,
    resolution: undefined,
  };
  const entry = (
    patch: Partial<SquireCardRow> & Pick<SquireCardRow, "kind">,
    phase: "open" | "sending" | "closed" = "open",
    expired = false,
  ) => ({
    row: { ...base, ...patch },
    createdAt: at,
    phase,
    outcome: phase === "closed" ? (expired ? "Expired" : "Sent") : null,
    expired,
  });

  it("gives an open approval Allow once and Deny, with Always allow only if a rule can apply", () => {
    expect(squireApprovalControls(entry({ kind: "steer", allowRuleOffer: offer }), null)).toEqual({
      allow: "Allow once",
      alwaysAllow: true,
      deny: "Deny",
      inactivity: false,
      allowNextTime: false,
    });
    expect(squireApprovalControls(entry({ kind: "steer" }), null).alwaysAllow).toBe(false);
  });

  it("names a Squire or room proposal's own accept", () => {
    const proposal = (type: string) =>
      squireApprovalControls(entry({ kind: "proposal" }), { type } as never).allow;
    expect(proposal("squire-proposal")).toBe("Accept");
    expect(proposal("room-proposal")).toBe("Open room");
    expect(proposal("thread-proposal")).toBe("Allow once");
  });

  it("answers a question in place and offers an overlap only Dismiss", () => {
    expect(squireApprovalControls(entry({ kind: "question" }), null)).toMatchObject({
      allow: null,
      deny: "Dismiss",
    });
    expect(squireApprovalControls(entry({ kind: "overlap" }), null)).toMatchObject({
      allow: null,
      deny: "Dismiss",
    });
  });

  it("gives the inactivity check its Keep and Pause", () => {
    expect(
      squireApprovalControls(entry({ kind: "fyi", fyiSource: "inactivity" }), null),
    ).toMatchObject({ inactivity: true, allow: null, deny: null });
  });

  it("offers Always allow next time only on an expired approval a rule could cover", () => {
    expect(
      squireApprovalControls(entry({ kind: "steer", allowRuleOffer: offer }, "closed", true), null),
    ).toMatchObject({ allowNextTime: true, allow: null, deny: null });
    expect(
      squireApprovalControls(entry({ kind: "steer" }, "closed", true), null).allowNextTime,
    ).toBe(false);
    expect(
      squireApprovalControls(entry({ kind: "steer", allowRuleOffer: offer }, "closed"), null)
        .allowNextTime,
    ).toBe(false);
  });
});

describe("Always allow", () => {
  const offer: SquireRuleOffer = {
    effect: "allow",
    actionClass: "steer",
    targetKind: "thread",
    targetId: "thread-1",
    text: "Research may auto-send review-feedback steers",
    capReached: false,
  };
  const row = (allowRuleOffer: SquireRuleOffer | null = offer) => ({
    id: "card-1" as SquireCardId,
    squireId: "squire-a" as SquireId,
    ...(allowRuleOffer === null ? {} : { allowRuleOffer }),
  });

  it("offers a rule only where the server attached one that can be saved", () => {
    expect(squireAllowRuleInput(row())).toMatchObject({
      effect: "allow",
      actionClass: "steer",
      targetId: "thread-1",
      fromCardId: "card-1",
    });
    expect(squireAllowRuleInput(row(null))).toBeNull();
    expect(squireAllowRuleInput(row({ ...offer, capReached: true }))).toBeNull();
    expect(squireAllowRuleInput(row({ ...offer, effect: "ask-first" }))).toBeNull();
  });

  it("saves the rule only after the accept goes through", async () => {
    const saved: unknown[] = [];
    const saveRule = async (input: unknown) => {
      saved.push(input);
      return { ok: true as const };
    };
    await expect(
      runSquireAlwaysAllow(row(), {
        accept: async () => ({ ok: true }),
        saveRule,
      }),
    ).resolves.toEqual({ ok: true });
    expect(saved).toHaveLength(1);

    await expect(
      runSquireAlwaysAllow(row(), {
        accept: async () => ({ ok: false, error: "Already handled" }),
        saveRule,
      }),
    ).resolves.toEqual({ ok: false, error: "Already handled" });
    expect(saved).toHaveLength(1);
  });
});

describe("squireSidebarState", () => {
  const shell = (patch: { lastVisitedAt?: string | null; status?: string } = {}) =>
    ({
      latestRun: patch.status === undefined ? null : { status: patch.status, runId: "run-1" },
      lastVisitedAt: patch.lastVisitedAt,
      session: patch.status === undefined ? null : { status: patch.status },
    }) as never;
  const entry = (patch: { openDecisionCount?: number; lastMessageAt?: string } = {}) => ({
    ...snapshot("a", { openDecisionCount: patch.openDecisionCount ?? 0 }),
    ...(patch.lastMessageAt === undefined ? {} : { lastMessageAt: patch.lastMessageAt }),
  });

  it("an open decision is needs-you, ahead of unread", () => {
    expect(
      squireSidebarState(
        entry({ openDecisionCount: 1, lastMessageAt: "2026-11-01T11:00:00.000Z" }),
        shell({ lastVisitedAt: "2026-11-01T10:00:00.000Z" }),
      ),
    ).toBe("needs-you");
  });

  it("unread only when a message landed after the last visit", () => {
    expect(
      squireSidebarState(
        entry({ lastMessageAt: "2026-11-01T11:00:00.000Z" }),
        shell({ lastVisitedAt: "2026-11-01T10:00:00.000Z" }),
      ),
    ).toBe("unread");
    expect(
      squireSidebarState(
        entry({ lastMessageAt: "2026-11-01T09:00:00.000Z" }),
        shell({ lastVisitedAt: "2026-11-01T10:00:00.000Z" }),
      ),
    ).toBe("none");
    expect(
      squireSidebarState(
        entry({ lastMessageAt: "2026-11-01T11:00:00.000Z" }),
        shell({
          lastVisitedAt: null,
        }),
      ),
    ).toBe("unread");
  });

  it("is quiet on an older server without lastMessageAt", () => {
    expect(squireSidebarState(entry(), shell({ lastVisitedAt: null }))).toBe("none");
  });
});

describe("squireQuietRunIds", () => {
  type Item = { readonly run: string | null; readonly tool?: string; readonly user?: boolean };
  const quiet = (items: ReadonlyArray<Item>) => [
    ...squireQuietRunIds(items, (item) => ({
      runId: item.run,
      toolName: item.tool ?? null,
      userMessage: item.user === true,
    })),
  ];
  const stay = "mcp__lecturn__squire_stay_quiet";

  it("marks a run that only stayed quiet", () => {
    expect(
      quiet([
        { run: "a", tool: "squire_get_summary" },
        { run: "a", tool: stay },
      ]),
    ).toEqual(["a"]);
  });

  it("leaves a batch that also spoke about another thread", () => {
    expect(
      quiet([
        { run: "a", tool: stay },
        { run: "a", tool: "mcp__lecturn__squire_notify" },
      ]),
    ).toEqual([]);
    expect(
      quiet([
        { run: "a", tool: "squire_recommend_steer" },
        { run: "a", tool: stay },
      ]),
    ).toEqual([]);
  });

  it("never silences a run the user started", () => {
    expect(
      quiet([
        { run: "a", user: true },
        { run: "a", tool: stay },
      ]),
    ).toEqual([]);
  });

  it("does not count another Squire's message or a read as speaking", () => {
    expect(
      quiet([
        { run: "a", tool: "squire_send_message" },
        { run: "a", tool: stay },
        { run: null, tool: stay },
      ]),
    ).toEqual(["a"]);
  });
});

describe("isSquireStayQuietTool", () => {
  it("matches the tool however the provider namespaces it", () => {
    expect(isSquireStayQuietTool("squire_stay_quiet")).toBe(true);
    expect(isSquireStayQuietTool("mcp__lecturn__squire_stay_quiet")).toBe(true);
    expect(isSquireStayQuietTool("lecturn.squire_stay_quiet")).toBe(true);
    expect(isSquireStayQuietTool("squire_notify")).toBe(false);
    expect(isSquireStayQuietTool("mysquire_stay_quiet")).toBe(false);
    expect(isSquireStayQuietTool(null)).toBe(false);
  });
});

describe("squireSettledLabel", () => {
  it("names how a card ended", () => {
    expect(squireSettledLabel({ status: "resolved", resolution: "answered" })).toBe("Answered");
    expect(squireSettledLabel({ status: "outdated", resolution: "expired" })).toBe("Expired");
    expect(squireSettledLabel({ status: "dismissed", resolution: "denied" })).toBe("Denied");
    expect(squireSettledLabel({ status: "dismissed" })).toBe("Dismissed");
  });
});

describe("squireOverlapThreadLine", () => {
  const thread = { provider: "codex", branch: null } as Parameters<
    typeof squireOverlapThreadLine
  >[0];
  const driverName = (driver: string) => (driver === "codex" ? "Codex" : undefined);

  it("names the provider by its instance, then its driver, then the raw driver", () => {
    expect(
      squireOverlapThreadLine(thread, { title: null, instanceName: "Work", driverName }).provider,
    ).toBe("Work");
    expect(
      squireOverlapThreadLine(thread, { title: null, instanceName: null, driverName }).provider,
    ).toBe("Codex");
    expect(
      squireOverlapThreadLine(thread, {
        title: null,
        instanceName: null,
        driverName: () => undefined,
      }).provider,
    ).toBe("codex");
  });
});

describe("squireOpenApprovalJump", () => {
  const entry = (
    id: string,
    phase: "open" | "sending" | "closed",
    kind: SquireCardRow["kind"] = "steer",
    fyiSource?: "inactivity" | "summary",
  ) => ({
    row: {
      id: id as SquireCardId,
      kind,
      ...(fyiSource === undefined ? {} : { fyiSource }),
    },
    createdAt: at,
    phase,
    outcome: null,
    expired: false,
  });

  it("goes to the oldest open row and counts what is waiting", () => {
    expect(
      squireOpenApprovalJump([
        entry("closed", "closed"),
        entry("old", "open"),
        entry("new", "open"),
      ]),
    ).toEqual({ cardId: "old", label: "2 need you" });
  });

  it("reads singular, and ignores what is already underway or only news", () => {
    expect(
      squireOpenApprovalJump([
        entry("running", "sending"),
        entry("news", "open", "fyi", "summary"),
        entry("check", "open", "fyi", "inactivity"),
      ]),
    ).toEqual({ cardId: "check", label: "1 needs you" });
    expect(squireOpenApprovalJump([entry("running", "sending")])).toBeNull();
  });
});

describe("createSquireOpenedTracker", () => {
  const env = "env" as EnvironmentId;
  const card = "card-1" as SquireCardId;

  it("sends once per card, skips one already opened, and retries after a failure", () => {
    const tracker = createSquireOpenedTracker();
    expect(tracker.take(env, card, null)).toBe(true);
    expect(tracker.take(env, card, null)).toBe(false);
    tracker.release(env, card);
    expect(tracker.take(env, card, null)).toBe(true);
    const other = createSquireOpenedTracker();
    expect(other.take(env, card, "2026-11-01T10:00:00.000Z")).toBe(false);
  });
});

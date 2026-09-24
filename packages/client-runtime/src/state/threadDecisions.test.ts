import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  DecisionId,
  DecisionRevision,
  ThreadDecision,
  WS_METHODS,
  type ThreadDecisionChange,
  type ThreadDecisionExportResult,
} from "@lecturn/contracts";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream, SubscriptionRef, Schema } from "effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
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
import {
  assembleDecisionJsonExport,
  decisionToMarkdown,
  threadDecisionListKey,
  createThreadDecisionEnvironmentAtoms,
} from "./threadDecisions.ts";
import { executeAtomQuery } from "./runtime.ts";
const environmentId = EnvironmentId.make("env-a"),
  projectId = ProjectId.make("project-a");
const decodeDecision = Schema.decodeUnknownSync(ThreadDecision);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeExport = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ schemaVersion: Schema.Literal(1), decisions: Schema.Array(ThreadDecision) }),
  ),
);
const fixture = (id = "note-a") =>
  decodeDecision({
    id,
    projectId,
    threadId: "thread-a",
    threadTitle: "Synthetic",
    occurredAt: "2026-09-23T00:00:00Z",
    title: "Use Postgres",
    body: "Use Postgres for persistence.",
    rationale: null,
    comment: "Personal",
    attribution: "user-directed",
    reviewState: "unreviewed",
    lifecycle: "current",
    userEdited: false,
    revision: 1,
    occurrence: 0,
    createdAt: "2026-09-23T00:00:00Z",
    updatedAt: "2026-09-23T00:00:00Z",
    evidence: [
      {
        id: "evidence",
        threadId: "thread-a",
        messageId: "message",
        messageRole: "user",
        sourceHash: "hash",
        sourceGeneration: 0,
        canonicalVersion: "v1",
        quote: "Use Postgres",
        start: 0,
        end: 12,
        prefix: "",
        suffix: "",
        occurrence: 0,
        availability: "available",
      },
    ],
    provenance: {
      descriptionRevision: 1,
      sourceFingerprint: "hash",
      canonicalVersion: "v1",
      templateVersion: "v1",
      detectorModel: "jev",
      writerSelection: { instanceId: "codex", model: "exact-model" },
      writerConfigurationGeneration: "generation",
      identityConfidence: "verified",
    },
    relationships: [],
  });
const page = (
  notes: readonly ThreadDecision[],
  nextCursor: string | null = null,
): ThreadDecisionExportResult => ({
  format: "json",
  schemaVersion: 1,
  projectRevision: DecisionRevision.make(2),
  nextCursor,
  content: encodeJson({
    schemaVersion: 1,
    projectId,
    projectRevision: 2,
    decisions: notes,
  }),
});
const makeHarness = Effect.fn("ThreadDecisions.testHarness")(function* (
  client: WsRpcProtocolClient,
) {
  const session: RpcSession = {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: (payload) => client.subscribeServerConfig(payload),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId,
      label: "Notes",
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
  const atoms = createThreadDecisionEnvironmentAtoms(
    Atom.runtime(Layer.succeed(EnvironmentRegistry, environmentRegistry)),
  );
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
    Effect.sync(() => value.dispose()),
  );
  return { atoms, registry, supervisor };
});

describe("decision cache and export boundaries", () => {
  it("keys every environment, project, filter, thread and cursor independently", () => {
    const key = threadDecisionListKey(environmentId, { projectId });
    expect(
      threadDecisionListKey(environmentId, {
        projectId,
        limit: 50,
        lifecycle: "current",
        search: "  ",
      }),
    ).toEqual(key);
    for (const input of [
      { projectId: ProjectId.make("other") },
      { projectId, threadId: ThreadId.make("other") },
      { projectId, reviewState: "all" as const },
      { projectId, lifecycle: "all" as const },
      { projectId, search: "choice" },
      { projectId, cursor: "page-2" },
    ])
      expect(threadDecisionListKey(environmentId, input)).not.toEqual(key);
    expect(threadDecisionListKey(EnvironmentId.make("other"), { projectId })).not.toEqual(key);
  });
  it("copies attribution, personal comments, evidence and portable source links", () => {
    const text = decisionToMarkdown(fixture(), environmentId);
    expect(text).toContain("user-directed");
    expect(text).toContain("Personal comment: Personal");
    expect(text).toContain("lecturn-citation://v1/env-a/thread-a/message");
    expect(text).not.toContain("writerConfigurationGeneration");
  });
  it("assembles all JSON pages and rejects incomplete, mixed-scope, changing, repeated exports", () => {
    const first = page([fixture()], "next"),
      last = page([fixture("note-b")]);
    const merged = decodeExport(assembleDecisionJsonExport(projectId, [first, last]));
    expect(merged.decisions.map((n) => n.id)).toEqual(["note-a", "note-b"]);
    expect(() => assembleDecisionJsonExport(projectId, [first])).toThrow("incomplete");
    expect(() => assembleDecisionJsonExport(projectId, [first, page([fixture()])])).toThrow(
      "repeated",
    );
    expect(() => assembleDecisionJsonExport(ProjectId.make("wrong"), [last])).toThrow("scope");
    expect(() =>
      assembleDecisionJsonExport(projectId, [
        first,
        { ...last, projectRevision: DecisionRevision.make(3) },
      ]),
    ).toThrow("changed");
  });
});
it.effect(
  "refetches only the affected project on mutation, subscription invalidation and reconnect",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const changes = yield* SubscriptionRef.make<ThreadDecisionChange>({
          projectId: ProjectId.make("other"),
          revision: DecisionRevision.make(0),
        });
        let revision = 1;
        const reads: string[] = [];
        const { atoms, registry, supervisor } = yield* makeHarness({
          [WS_METHODS.threadDecisionsSubscribe]: () => SubscriptionRef.changes(changes),
          [WS_METHODS.threadDecisionsList]: (input: { projectId: string }) =>
            Effect.sync(() => {
              reads.push(input.projectId);
              return { decisions: [], nextCursor: null, projectRevision: revision };
            }),
          [WS_METHODS.threadDecisionsMutate]: () =>
            Effect.sync(() => {
              revision++;
              return { decision: null, projectRevision: revision };
            }),
        } as unknown as WsRpcProtocolClient);
        const list = atoms.list({ environmentId, input: { projectId } }),
          other = atoms.list({ environmentId, input: { projectId: ProjectId.make("other") } });
        expect(atoms.list({ environmentId, input: { projectId, limit: 50 } })).toBe(list);
        const unmount = registry.mount(list),
          unmountOther = registry.mount(other);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            unmount();
            unmountOther();
          }),
        );
        yield* Effect.promise(() => executeAtomQuery(registry, list));
        yield* Effect.promise(() => executeAtomQuery(registry, other));
        const otherReads = reads.filter((id) => id === "other").length;
        const result = yield* Effect.promise(() =>
          atoms.mutate.run(registry, {
            environmentId,
            input: {
              operation: "delete",
              projectId,
              id: DecisionId.make("decision"),
              expectedRevision: DecisionRevision.make(1),
            },
          }),
        );
        expect(AsyncResult.isSuccess(result)).toBe(true);
        expect(
          (yield* AtomRegistry.getResult(registry, list, { suspendOnWaiting: true }))
            .projectRevision,
        ).toBe(2);
        expect(reads.filter((id) => id === "other").length).toBe(otherReads);
        revision = 3;
        yield* SubscriptionRef.set(changes, { projectId, revision: DecisionRevision.make(3) });
        yield* Effect.yieldNow;
        expect(
          (yield* AtomRegistry.getResult(registry, list, { suspendOnWaiting: true }))
            .projectRevision,
        ).toBe(3);
        expect(reads.filter((id) => id === "other").length).toBe(otherReads);
        revision = 4;
        yield* SubscriptionRef.update(supervisor.state, (state) => ({ ...state, generation: 2 }));
        yield* Effect.yieldNow;
        expect(
          (yield* AtomRegistry.getResult(registry, list, { suspendOnWaiting: true }))
            .projectRevision,
        ).toBe(4);
      }),
    ),
);

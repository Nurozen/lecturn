import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  MessageId,
  WS_METHODS,
  type ContextualEvent,
} from "@lecturn/contracts";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream, SubscriptionRef } from "effect";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
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
import { createContextualEnvironmentAtoms, contextualStateLabel } from "./contextual.ts";
import { executeAtomQuery } from "./runtime.ts";
const environmentId = EnvironmentId.make("host-a"),
  projectId = ProjectId.make("project-a"),
  threadId = ThreadId.make("thread-a");
const makeHarness = Effect.fn("Contextual.testHarness")(function* (client: WsRpcProtocolClient) {
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
  const atoms = createContextualEnvironmentAtoms(
    Atom.runtime(Layer.succeed(EnvironmentRegistry, environmentRegistry)),
  );
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
    Effect.sync(() => value.dispose()),
  );
  return { atoms, registry, supervisor };
});

describe("Contextual client boundaries", () => {
  it("separates requested intent from effective service failure", () => {
    expect(
      contextualStateLabel({
        enabled: true,
        effective: false,
        reason: "funding-required",
        slackAvailable: false,
        decisionsAvailable: true,
        collectionState: "paused",
      }),
    ).toBe("Membership funding required");
    expect(
      contextualStateLabel({
        enabled: true,
        effective: true,
        reason: "ready",
        slackAvailable: false,
        decisionsAvailable: true,
        collectionState: "paused",
      }),
    ).toBe("Ready for your next message");
  });
  it.effect("isolates query identities and refreshes after a mutation and a durable event", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let revision = 1;
        const events = yield* SubscriptionRef.make<ContextualEvent>({
          sequence: 1,
          threadId,
          projectId: null,
          revision: 1,
          kind: "settings-changed",
          entityId: threadId,
          occurredAt: "2026-09-25T00:00:00Z",
        });
        const { atoms, registry } = yield* makeHarness({
          [WS_METHODS.contextualSubscribe]: () => SubscriptionRef.changes(events),
          [WS_METHODS.contextualProjectSettings]: () =>
            Effect.sync(() => ({ projectId, defaultEnabled: false, sourceIds: [], revision })),
          [WS_METHODS.contextualUpdateProjectSettings]: () =>
            Effect.sync(() => ({
              projectId,
              defaultEnabled: true,
              sourceIds: [],
              revision: ++revision,
            })),
        } as unknown as WsRpcProtocolClient);
        const query = atoms.projectSettings({ environmentId, input: { projectId } });
        expect(query).not.toBe(
          atoms.projectSettings({
            environmentId: EnvironmentId.make("other"),
            input: { projectId },
          }),
        );
        const first = atoms.disclosures({
          environmentId,
          input: { threadId, messageId: MessageId.make("one"), limit: 50 },
        });
        expect(first).not.toBe(
          atoms.disclosures({
            environmentId,
            input: { threadId, messageId: MessageId.make("two"), limit: 50 },
          }),
        );
        expect(first).not.toBe(
          atoms.disclosures({
            environmentId,
            input: { threadId, messageId: MessageId.make("one"), limit: 50, cursor: "next" },
          }),
        );
        const unmount = registry.mount(query);
        yield* Effect.addFinalizer(() => Effect.sync(unmount));
        yield* Effect.promise(() => executeAtomQuery(registry, query));
        const result = yield* Effect.promise(() =>
          atoms.updateProjectSettings.run(registry, {
            environmentId,
            input: { projectId, expectedRevision: 1, defaultEnabled: true, sourceIds: [] },
          }),
        );
        expect(result._tag).toBe("Success");
        expect(
          (yield* AtomRegistry.getResult(registry, query, { suspendOnWaiting: true })).revision,
        ).toBe(2);
        revision = 3;
        yield* SubscriptionRef.set(events, {
          sequence: 2,
          threadId: null,
          projectId,
          revision: 3,
          kind: "settings-changed",
          entityId: threadId,
          occurredAt: "2026-09-25T00:00:01Z",
        });
        yield* Effect.yieldNow;
        expect(
          (yield* AtomRegistry.getResult(registry, query, { suspendOnWaiting: true })).revision,
        ).toBe(3);
      }),
    ),
  );
  it.effect("refuses malformed export identities before issuing a network request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, registry } = yield* makeHarness({} as WsRpcProtocolClient);
        const result = yield* Effect.promise(() =>
          atoms.downloadExport.run(registry, {
            environmentId,
            input: { artifactId: "../another-resource" },
          }),
        );
        expect(result._tag).toBe("Failure");
      }),
    ),
  );
});

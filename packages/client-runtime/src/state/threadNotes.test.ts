import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
  ThreadNoteId,
  WS_METHODS,
  type ThreadNoteCreateInput,
} from "@lecturn/contracts";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream, SubscriptionRef, Deferred, Fiber } from "effect";
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
import { createThreadNoteEnvironmentAtoms } from "./threadNotes.ts";
import { executeAtomQuery } from "./runtime.ts";

const environmentId = EnvironmentId.make("notes-environment");
const projectId = ProjectId.make("notes-project");
const input: ThreadNoteCreateInput = {
  id: ThreadNoteId.make("note"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make("message"),
  messageRole: "assistant",
  text: "hello",
  comment: null,
  start: 0,
  end: 5,
  prefix: "",
  suffix: "",
};
const makeHarness = Effect.fn("ThreadNotes.testHarness")(function* (client: WsRpcProtocolClient) {
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
  const atoms = createThreadNoteEnvironmentAtoms(
    Atom.runtime(Layer.succeed(EnvironmentRegistry, environmentRegistry)),
  );
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
    Effect.sync(() => value.dispose()),
  );
  return { atoms, registry };
});

it.effect(
  "shares project queries, refetches after edits and focus, and isolates environment signals",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let comment = "old";
        let reads = 0;
        const { atoms, registry } = yield* makeHarness({
          [WS_METHODS.threadNotesList]: () =>
            Effect.sync(() => {
              reads++;
              return {
                notes: [
                  {
                    ...input,
                    projectId,
                    createdAt: "now",
                    updatedAt: "now",
                    comment,
                    threadTitle: "Thread",
                    anchorState: "ok",
                  },
                ],
                truncated: false,
              };
            }),
          [WS_METHODS.threadNotesUpdate]: (payload: { comment: string }) =>
            Effect.sync(() => {
              comment = payload.comment;
              return { ...input, projectId, createdAt: "now", updatedAt: "now", comment };
            }),
        } as unknown as WsRpcProtocolClient);
        const list = atoms.list({ environmentId, input: { projectId } });
        expect(atoms.list({ environmentId, input: { projectId } })).toBe(list);
        expect(atoms.list({ environmentId, input: {} })).toBe(
          atoms.list({ environmentId, input: { projectId: undefined } }),
        );
        const unmount = registry.mount(list);
        yield* Effect.addFinalizer(() => Effect.sync(unmount));
        const initial = yield* Effect.promise(() => executeAtomQuery(registry, list));
        expect(AsyncResult.isSuccess(initial)).toBe(true);
        const update = yield* Effect.promise(() =>
          atoms.update.run(registry, {
            environmentId,
            input: { id: input.id, comment: "changed" },
          }),
        );
        expect(AsyncResult.isSuccess(update)).toBe(true);
        expect(
          (yield* AtomRegistry.getResult(registry, list, { suspendOnWaiting: true })).notes[0]
            ?.comment,
        ).toBe("changed");
        const afterUpdate = reads;
        registry.update(atoms.refreshSignal(EnvironmentId.make("other-environment")), (n) => n + 1);
        expect(reads).toBe(afterUpdate);
        comment = "another device";
        registry.update(atoms.refreshSignal(environmentId), (n) => n + 1);
        expect(
          (yield* AtomRegistry.getResult(registry, list, { suspendOnWaiting: true })).notes[0]
            ?.comment,
        ).toBe("another device");
        expect(reads).toBeGreaterThan(afterUpdate);
      }),
    ),
);

it.effect("serializes different commands on one note while unrelated notes proceed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const calls: string[] = [];
      const { atoms, registry } = yield* makeHarness({
        [WS_METHODS.threadNotesCreate]: () =>
          Effect.gen(function* () {
            calls.push("create");
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return { ...input, projectId, createdAt: "now", updatedAt: "now" };
          }),
        [WS_METHODS.threadNotesDelete]: (payload: { id: string }) =>
          Effect.sync(() => {
            calls.push(`delete:${payload.id}`);
          }),
      } as unknown as WsRpcProtocolClient);
      const create = yield* Effect.promise(() =>
        atoms.create.run(registry, { environmentId, input }),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Effect.yieldNow;
      const queued = atoms.delete.run(registry, { environmentId, input: { id: input.id } });
      const other = yield* Effect.promise(() =>
        atoms.delete.run(registry, { environmentId, input: { id: ThreadNoteId.make("other") } }),
      );
      expect(AsyncResult.isSuccess(other)).toBe(true);
      expect(calls).toEqual(["create", "delete:other"]);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(create);
      yield* Effect.promise(() => queued);
      expect(calls).toEqual(["create", "delete:other", "delete:note"]);
    }),
  ),
);

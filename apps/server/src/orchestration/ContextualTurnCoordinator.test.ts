import { TestClock } from "effect/testing";
import { assert, it } from "@effect/vitest";
import {
  ContextualError,
  ContextualPreparation,
  EnvironmentId,
  ProjectId,
  ThreadId,
  MessageId,
  EventId,
} from "@lecturn/contracts";
import { Effect, Fiber, Result } from "effect";
import { makeCoordinator } from "./ContextualTurnCoordinator.ts";
import type { ContextualQueuedTurn } from "./ContextualTurnQueue.ts";
const now = "2026-09-26T00:00:00.000Z";
const threadId = ThreadId.make("thread");
const p: ContextualPreparation = {
  id: "prep",
  revision: 0,
  state: "awaiting-conflict-review",
  packetId: null,
  dispatchId: null,
  conflictIds: ["conflict"],
  attemptsUsed: 1,
  comparisonPairsChecked: 1,
  updatedAt: now,
  coverage: { complete: true, missingAntecedents: false, truncated: false, unexaminedCount: 0 },
  task: {
    environmentId: EnvironmentId.make("env"),
    projectId: ProjectId.make("project"),
    threadId,
    submissionId: "submission",
    messageId: MessageId.make("message"),
    turnId: null,
    providerInstanceId: "codex",
    providerContextEpoch: "initial",
    taskFingerprint: "task",
    knownContextFingerprint: "known",
    threadSettingsRevision: 0,
    projectSettingsRevision: 0,
    sourceScopeRevision: 0,
    threadExclusionRevision: 0,
    fundingGeneration: 0,
    purgeGeneration: 0,
    newestMessage: "Build storage",
    projectDescription: "",
    recentContext: "",
    explicitReferences: [],
    trigger: "submission",
  },
};
const queued: ContextualQueuedTurn = {
  dispatchId: "dispatch",
  preparationId: "prep",
  state: "held",
  event: {
    sequence: 1,
    eventId: EventId.make("event"),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: now,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.turn-start-requested",
    payload: {
      threadId,
      messageId: p.task.messageId,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: now,
    },
  },
};
const input = {
  threadId,
  submissionId: p.task.submissionId,
  messageId: p.task.messageId,
  providerInstanceId: "codex",
  newestMessage: p.task.newestMessage,
  recentContext: "",
};
function fixture(
  options: {
    readFailure?: boolean;
    lookupStall?: boolean;
    lookupFailure?: boolean;
    current?: ContextualPreparation;
  } = {},
) {
  const current = options.current ?? p;
  const writes: string[] = [];
  let evaluations = 0;
  const unavailable = new ContextualError({
    code: "unavailable",
    message: "Synthetic unavailable",
  });
  const coordinator = makeCoordinator(
    {
      taskSnapshot: () =>
        options.lookupStall
          ? Effect.never
          : options.lookupFailure
            ? Effect.fail(unavailable)
            : Effect.succeed(current.task),
      prepare: () =>
        Effect.sync(() => {
          evaluations++;
          return current;
        }),
      revalidate: () => Effect.succeed({ preparation: current, packet: null }),
      recover: () => Effect.void,
    },
    {
      get: () => (options.readFailure ? Effect.fail(unavailable) : Effect.succeed(current)),
      update: (value) => Effect.succeed(value),
      receipt: () => Effect.succeed(undefined),
    },
    {
      setState: (_thread, _event, state) =>
        Effect.sync(() => {
          writes.push(state);
          return undefined;
        }),
    },
  );
  return { coordinator, writes, evaluations: () => evaluations };
}
it.effect("reuses a persisted conflict hold without another evaluation", () =>
  Effect.gen(function* () {
    const f = fixture();
    assert.equal((yield* f.coordinator.prepare(queued, input)).action, "hold");
    assert.equal(f.evaluations(), 0);
    assert.deepEqual(f.writes, ["held"]);
  }),
);
it.effect("a failed read cannot silently release a known hold", () =>
  Effect.gen(function* () {
    const f = fixture({ readFailure: true });
    assert.equal((yield* f.coordinator.prepare(queued, input)).action, "hold");
    assert.deepEqual(f.writes, []);
  }),
);
it.effect("ordinary optional lookup failure lets an unheld original turn proceed", () =>
  Effect.gen(function* () {
    const f = fixture({ lookupFailure: true });
    assert.deepEqual(
      yield* f.coordinator.prepare({ ...queued, state: "queued", preparationId: null }, input),
      { action: "send", preparation: null, packet: null },
    );
    assert.equal(f.evaluations(), 0);
  }),
);
it.effect("a cancellation after preparation prevents the dispatch marker and native send", () =>
  Effect.gen(function* () {
    const f = fixture({ current: { ...p, state: "canceled" } });
    const result = yield* f.coordinator
      .begin(queued, { action: "send", preparation: p, packet: null }, null)
      .pipe(Effect.result);
    assert.isTrue(Result.isFailure(result));
    assert.deepEqual(f.writes, []);
  }),
);
it.effect("fail-open sends still persist a dispatch marker before handing off", () =>
  Effect.gen(function* () {
    const f = fixture();
    assert.isUndefined(
      yield* f.coordinator.begin(
        { ...queued, state: "ready" },
        { action: "send", preparation: null, packet: null },
        null,
      ),
    );
    assert.deepEqual(f.writes, ["dispatching"]);
  }),
);

it.effect(
  "the preparation deadline includes the funding/task snapshot before a preparation exists",
  () =>
    Effect.gen(function* () {
      const f = fixture({ lookupStall: true });
      const fiber = yield* f.coordinator
        .prepare({ ...queued, state: "queued", preparationId: null }, input)
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("60 seconds");
      assert.deepEqual(yield* Fiber.join(fiber), {
        action: "send",
        preparation: null,
        packet: null,
      });
      assert.equal(f.evaluations(), 0);
    }),
);

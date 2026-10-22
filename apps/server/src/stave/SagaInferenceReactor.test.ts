import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import {
  type ApplicationStoredEvent,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  SagaWorkbenchError,
  ThreadId,
} from "@lecturn/contracts";
import { DateTime, Deferred, Effect, Fiber, Layer, Queue, Stream } from "effect";
import { emptyWorkflow } from "../persistence/Services/SagaWorkbenchRepository.ts";
import { make, promptInferenceEventOf } from "./SagaInferenceReactor.ts";
import { SagaWorkbenchService, type SagaInferenceRequest } from "./SagaWorkbenchService.ts";
import { StaveOrchestration } from "./StaveOrchestration.ts";

const at = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("thread");
const modelSelection = { instanceId: ProviderInstanceId.make("account"), model: "model" };
/** A V2 `run.created` stored event: the user asked for a turn. */
const event = (
  sequence: number,
  extra: { readonly restartContinuationOfRunId?: RunId } = {},
): ApplicationStoredEvent => ({
  sequence,
  commandId: CommandId.make(`cmd-${sequence}`),
  event: {
    id: EventId.make(`event-${sequence}`),
    threadId,
    occurredAt: DateTime.makeUnsafe(at),
    type: "run.created",
    payload: {
      id: RunId.make(`run-${sequence}`),
      threadId,
      ordinal: sequence,
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message-${sequence}`),
      rootNodeId: null,
      activeAttemptId: null,
      status: "preparing",
      requestedAt: DateTime.makeUnsafe(at),
      startedAt: null,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
      ...extra,
    },
  },
});
/** Mirrors the application log: events offered before the tail starts are still replayed. */
const eventLog = (queue: Queue.Queue<ApplicationStoredEvent>) =>
  Layer.mock(StaveOrchestration)({
    latestSequence: Effect.succeed(0),
    streamEvents: () => Stream.fromQueue(queue),
  });
const request = (sequence: number): SagaInferenceRequest => ({
  identity: {
    projectId: ProjectId.make("project"),
    workspaceRoot: "/space",
    spaceId: "space",
    createdAt: at,
  },
  threadId,
  modelSelection,
  turns: [{ question: "Build", response: "Built" }],
  eventId: `event-${sequence}`,
  sequence,
});

it.effect("maps user-started runs to prompt events and skips server continuations", () =>
  Effect.sync(() => {
    expect(promptInferenceEventOf(event(4))).toEqual({
      eventId: "event-4",
      sequence: 4,
      threadId,
      messageId: "message-4",
      modelSelection,
    });
    expect(
      promptInferenceEventOf(event(5, { restartContinuationOfRunId: RunId.make("run-4") })),
    ).toBeNull();
  }),
);

it.effect("subscribes before returning and queues new prompts without waiting for generation", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<ApplicationStoredEvent>();
    const release = yield* Deferred.make<void>();
    const entered = yield* Deferred.make<void>();
    const secondPrepared = yield* Deferred.make<void>();
    const generated: number[] = [];
    const dependencies = Layer.mergeAll(
      eventLog(events),
      Layer.mock(SagaWorkbenchService)({
        preparePromptInference: (item) =>
          Effect.gen(function* () {
            if (item.sequence === 2) yield* Deferred.succeed(secondPrepared, undefined);
            return request(item.sequence);
          }),
        inferFromPrompt: (item) =>
          Effect.gen(function* () {
            if (item.sequence === 1) {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }
            generated.push(item.sequence);
            return emptyWorkflow(item.identity);
          }),
      }),
    );
    const reactor = yield* make.pipe(Effect.provide(dependencies));
    yield* reactor.start();
    yield* Queue.offer(events, event(1));
    yield* Deferred.await(entered);
    yield* Queue.offer(events, event(2));
    yield* Deferred.await(secondPrepared);
    expect(generated).toEqual([]);
    const drain = yield* Effect.forkChild(reactor.drainThrough(2));
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(drain);
    expect(generated).toEqual([1, 2]);
  }),
);

it.effect("one failed generation or ineligible prompt does not stop later updates", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<ApplicationStoredEvent>();
    const generated: number[] = [];
    const dependencies = Layer.mergeAll(
      eventLog(events),
      Layer.mock(SagaWorkbenchService)({
        preparePromptInference: (item) =>
          Effect.succeed(item.sequence === 2 ? null : request(item.sequence)),
        inferFromPrompt: (item) =>
          Effect.gen(function* () {
            generated.push(item.sequence);
            if (item.sequence === 1)
              return yield* new SagaWorkbenchError({
                code: "generation",
                message: "Account unavailable",
              });
            return emptyWorkflow(item.identity);
          }),
      }),
    );
    const reactor = yield* make.pipe(Effect.provide(dependencies));
    yield* reactor.start();
    yield* Queue.offer(events, event(1));
    yield* Queue.offer(events, event(2));
    yield* Queue.offer(events, event(3));
    yield* reactor.drainThrough(3);
    expect(generated).toEqual([1, 3]);
  }),
);

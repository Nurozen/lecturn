import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import {
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  SagaWorkbenchError,
  ThreadId,
} from "@t3tools/contracts";
import { Deferred, Effect, Fiber, Layer, PubSub, Stream } from "effect";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { emptyWorkflow } from "../persistence/Services/SagaWorkbenchRepository.ts";
import { make } from "./SagaInferenceReactor.ts";
import {
  SagaWorkbenchService,
  type PromptInferenceEvent,
  type SagaInferenceRequest,
} from "./SagaWorkbenchService.ts";

const at = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("thread");
const event = (sequence: number): PromptInferenceEvent => ({
  sequence,
  eventId: EventId.make(`event-${sequence}`),
  aggregateKind: "thread",
  aggregateId: threadId,
  type: "thread.turn-start-requested",
  occurredAt: at,
  commandId: CommandId.make(`cmd-${sequence}`),
  causationEventId: null,
  correlationId: CorrelationId.make(`cmd-${sequence}`),
  metadata: {},
  payload: {
    threadId,
    messageId: MessageId.make(`message-${sequence}`),
    createdAt: at,
    runtimeMode: "full-access",
    interactionMode: "default",
  },
});
const request = (sequence: number): SagaInferenceRequest => ({
  identity: {
    projectId: ProjectId.make("project"),
    workspaceRoot: "/space",
    spaceId: "space",
    createdAt: at,
  },
  threadId,
  modelSelection: { instanceId: ProviderInstanceId.make("account"), model: "model" },
  turns: [{ question: "Build", response: "Built" }],
  eventId: `event-${sequence}`,
  sequence,
});

it.effect("subscribes before returning and queues new prompts without waiting for generation", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<PromptInferenceEvent>();
    const release = yield* Deferred.make<void>();
    const entered = yield* Deferred.make<void>();
    const secondPrepared = yield* Deferred.make<void>();
    const generated: number[] = [];
    const dependencies = Layer.mergeAll(
      Layer.mock(OrchestrationEngineService)({
        latestSequence: Effect.succeed(0),
        subscribeDomainEvents: PubSub.subscribe(events).pipe(Effect.map(Stream.fromSubscription)),
      }),
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
    yield* PubSub.publish(events, event(1));
    yield* Deferred.await(entered);
    yield* PubSub.publish(events, event(2));
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
    const events = yield* PubSub.unbounded<PromptInferenceEvent>();
    const generated: number[] = [];
    const dependencies = Layer.mergeAll(
      Layer.mock(OrchestrationEngineService)({
        latestSequence: Effect.succeed(0),
        subscribeDomainEvents: PubSub.subscribe(events).pipe(Effect.map(Stream.fromSubscription)),
      }),
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
    yield* PubSub.publish(events, event(1));
    yield* PubSub.publish(events, event(2));
    yield* PubSub.publish(events, event(3));
    yield* reactor.drainThrough(3);
    expect(generated).toEqual([1, 3]);
  }),
);

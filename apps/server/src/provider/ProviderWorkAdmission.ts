import {
  ThreadDecisionError,
  type ProviderInstanceId,
  type ThreadId,
  type TurnId,
} from "@lecturn/contracts";
import { Context, Deferred, Effect, Layer, PubSub, Stream } from "effect";

interface Foreground {
  instanceId: ProviderInstanceId;
  token: number;
  turnId: TurnId | null;
  earlyCompletions: Set<TurnId>;
  ended: boolean;
}
interface Writer {
  cancel: Deferred.Deferred<void>;
  done: Deferred.Deferred<void>;
}

/** Foreground owns admission before adapter dispatch, including its acknowledgement gap. */
export class ProviderWorkAdmission extends Context.Service<
  ProviderWorkAdmission,
  {
    readonly beginForeground: (
      instanceId: ProviderInstanceId,
      threadId: ThreadId,
    ) => Effect.Effect<number>;
    readonly acknowledgeForeground: (
      threadId: ThreadId,
      token: number,
      turnId: TurnId,
    ) => Effect.Effect<void>;
    readonly finishForeground: (threadId: ThreadId, turnId?: TurnId) => Effect.Effect<void>;
    readonly abandonForeground: (threadId: ThreadId, token?: number) => Effect.Effect<void>;
    readonly hasForeground: (instanceId: ProviderInstanceId) => Effect.Effect<boolean>;
    readonly runWriter: <A, E, R>(
      instanceId: ProviderInstanceId,
      work: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ThreadDecisionError, R>;
    readonly changes: Stream.Stream<void>;
  }
>()("lecturn/provider/ProviderWorkAdmission") {}

export const make = Effect.gen(function* () {
  const foreground = new Map<ThreadId, Foreground>();
  const writers = new Map<ProviderInstanceId, Writer>();
  const changes = yield* PubSub.sliding<void>({ capacity: 1 });
  let nextToken = 0;
  const notify = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
  const hasForeground = (instanceId: ProviderInstanceId) =>
    Effect.sync(() => [...foreground.values()].some((turn) => turn.instanceId === instanceId));
  const beginForeground = Effect.fn("ProviderAdmission.beginForeground")(function* (
    instanceId: ProviderInstanceId,
    threadId: ThreadId,
  ) {
    const { token, writer } = yield* Effect.sync(() => {
      const token = ++nextToken;
      foreground.set(threadId, {
        instanceId,
        token,
        turnId: null,
        earlyCompletions: new Set(),
        ended: false,
      });
      return { token, writer: writers.get(instanceId) };
    });
    if (writer) {
      yield* Deferred.succeed(writer.cancel, undefined);
      // raceFirst interrupts the writer and waits for subprocess finalizers before
      // its done signal; foreground cannot overlap a still-running helper.
      yield* Deferred.await(writer.done).pipe(
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            if (foreground.get(threadId)?.token === token) foreground.delete(threadId);
            yield* notify;
          }),
        ),
      );
    }
    yield* notify;
    return token;
  });
  const acknowledgeForeground = Effect.fn("ProviderAdmission.acknowledgeForeground")(function* (
    threadId: ThreadId,
    token: number,
    turnId: TurnId,
  ) {
    yield* Effect.sync(() => {
      const turn = foreground.get(threadId);
      if (!turn || turn.token !== token) return;
      if (turn.ended || turn.earlyCompletions.has(turnId)) foreground.delete(threadId);
      else {
        turn.turnId = turnId;
        turn.earlyCompletions.clear();
      }
    });
    yield* notify;
  });
  const finishForeground = Effect.fn("ProviderAdmission.finishForeground")(function* (
    threadId: ThreadId,
    turnId?: TurnId,
  ) {
    yield* Effect.sync(() => {
      const turn = foreground.get(threadId);
      if (!turn) return;
      if (turn.turnId === null) {
        if (turnId === undefined) turn.ended = true;
        else if (turn.earlyCompletions.size < 16) turn.earlyCompletions.add(turnId);
      } else if (turnId === undefined || turn.turnId === turnId) foreground.delete(threadId);
    });
    yield* notify;
  });
  const abandonForeground = Effect.fn("ProviderAdmission.abandonForeground")(function* (
    threadId: ThreadId,
    token?: number,
  ) {
    yield* Effect.sync(() => {
      if (token === undefined || foreground.get(threadId)?.token === token)
        foreground.delete(threadId);
    });
    yield* notify;
  });
  const runWriter = <A, E, R>(instanceId: ProviderInstanceId, work: Effect.Effect<A, E, R>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const writer = { cancel: yield* Deferred.make<void>(), done: yield* Deferred.make<void>() };
        const admitted = yield* Effect.sync(() => {
          if (
            writers.has(instanceId) ||
            [...foreground.values()].some((turn) => turn.instanceId === instanceId)
          )
            return false;
          writers.set(instanceId, writer);
          return true;
        });
        if (!admitted)
          return yield* new ThreadDecisionError({
            code: "unavailable",
            message: "The connected provider is busy with foreground work.",
          });
        return yield* restore(
          Effect.raceFirst(
            work,
            Deferred.await(writer.cancel).pipe(
              Effect.andThen(
                Effect.fail(
                  new ThreadDecisionError({
                    code: "unavailable",
                    message: "The connected provider is busy with foreground work.",
                  }),
                ),
              ),
            ),
          ),
        ).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              if (writers.get(instanceId) === writer) writers.delete(instanceId);
              yield* Deferred.succeed(writer.done, undefined);
              yield* notify;
            }),
          ),
        );
      }),
    );
  return ProviderWorkAdmission.of({
    beginForeground,
    acknowledgeForeground,
    finishForeground,
    abandonForeground,
    hasForeground,
    runWriter,
    changes: Stream.fromPubSub(changes),
  });
});
export const layer = Layer.effect(ProviderWorkAdmission, make);

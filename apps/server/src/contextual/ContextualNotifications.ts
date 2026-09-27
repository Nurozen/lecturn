import { Context, Effect, Layer, PubSub, Stream } from "effect";

/** Wakeups carry no source text. The durable outbox remains the replay authority. */
export const make = Effect.gen(function* () {
  const changes = yield* PubSub.sliding<void>(1);
  return {
    publish: PubSub.publish(changes, undefined).pipe(Effect.asVoid),
    subscribe: PubSub.subscribe(changes),
    changes: Stream.fromPubSub(changes),
  };
});
export class ContextualNotifications extends Context.Service<
  ContextualNotifications,
  Effect.Success<typeof make>
>()("lecturn/contextual/ContextualNotifications") {}
export const layer = Layer.effect(ContextualNotifications, make);

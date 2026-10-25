/**
 * Host context over the shared AppRuntimeState, so the beforeTurnStart
 * contribution reads what `apps.updateHostContext` wrote (A29 completes it).
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { AppRuntimeState, hostContextKey } from "./AppRuntimeState.ts";
import { AppHostContextStore } from "./services.ts";

export const layer = Layer.effect(
  AppHostContextStore,
  Effect.gen(function* () {
    const { hostContext } = yield* AppRuntimeState;
    return AppHostContextStore.of({
      // Empty text clears the entry: an app's way back out of a context it set.
      set: (target, text) =>
        Ref.update(hostContext, (entries) => {
          const next = new Map(entries);
          const key = hostContextKey(target);
          if (text.length === 0) next.delete(key);
          else next.set(key, text);
          return next;
        }),
      forTurn: (threadId, projectId) =>
        Ref.get(hostContext).pipe(
          Effect.map((entries) => {
            const texts = [
              entries.get(hostContextKey({ threadId })),
              entries.get(hostContextKey({ projectId })),
            ].filter((text) => text !== undefined);
            return texts.length === 0 ? Option.none() : Option.some(texts.join("\n\n"));
          }),
        ),
    });
  }),
);

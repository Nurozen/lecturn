/**
 * Host context over the shared AppRuntimeState, so the beforeTurnStart
 * contribution (AppsOrchestrationHooks) reads what `apps.updateHostContext`
 * wrote. In memory only: an app resends its context when it reconnects.
 */
import type { AppId, ProjectId, ThreadId } from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { type AppHostContextKey, AppRuntimeState, hostContextKey } from "./AppRuntimeState.ts";
import { AppHostContextStore } from "./services.ts";

/** The thread entry comes first: it is the more specific of the two. */
export const hostContextForTurn = (
  entries: ReadonlyMap<AppHostContextKey, string>,
  threadId: ThreadId,
  projectId: ProjectId,
): Option.Option<string> => {
  const texts = [
    entries.get(hostContextKey({ threadId })),
    entries.get(hostContextKey({ projectId })),
  ].filter((text) => text !== undefined);
  return texts.length === 0 ? Option.none() : Option.some(texts.join("\n\n"));
};

const CLOSING_TAG = "</app-context>";

/**
 * App ids are `[a-z0-9.-]` (AppId), so the attribute needs no escaping. The
 * text is the app's own, but it must not be able to end the block early and
 * pass the rest off as Lecturn's words.
 */
export const formatAppContext = (appId: AppId, text: string) =>
  `<app-context app="${appId}">\n${text.replaceAll(CLOSING_TAG, "&lt;/app-context>")}\n${CLOSING_TAG}`;

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
          Effect.map((entries) => hostContextForTurn(entries, threadId, projectId)),
        ),
    });
  }),
);

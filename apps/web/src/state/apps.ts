import { useAtomValue } from "@effect/atom-react";
import { createAppsEnvironmentAtoms } from "@lecturn/client-runtime/state/apps";
import { parseScopedProjectKey, scopedProjectKey } from "@lecturn/client-runtime/environment";
import type { AppEmbedContext, ScopedProjectRef } from "@lecturn/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

export const appsEnvironment = createAppsEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_EMBED_CONTEXT_ATOM = Atom.make<AppEmbedContext | null>(null).pipe(
  Atom.withLabel("web-app-embed-context:empty"),
);

const embedContextAtom = Atom.family((key: string) => {
  const ref = parseScopedProjectKey(key);
  return Atom.make((get): AppEmbedContext | null => {
    if (ref === null) return null;
    const result = get(
      appsEnvironment.embedContext({
        environmentId: ref.environmentId,
        input: { projectId: ref.projectId },
      }),
    );
    return Option.getOrNull(AsyncResult.value(result));
  }).pipe(Atom.withLabel(`web-app-embed-context:${key}`));
});

/** The app bound to a project; pass null for a project with no app binding, which has none. */
export function useAppEmbedContext(ref: ScopedProjectRef | null): AppEmbedContext | null {
  return useAtomValue(
    ref === null ? EMPTY_EMBED_CONTEXT_ATOM : embedContextAtom(scopedProjectKey(ref)),
  );
}

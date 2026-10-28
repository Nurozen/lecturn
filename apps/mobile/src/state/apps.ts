import { useAtomValue } from "@effect/atom-react";
import { parseScopedProjectKey, scopedProjectKey } from "@lecturn/client-runtime/environment";
import { createAppsEnvironmentAtoms } from "@lecturn/client-runtime/state/apps";
import {
  AuthAccessReadScope,
  type AppEmbedContext,
  type AppStatus,
  type EnvironmentId,
  type ScopedProjectRef,
} from "@lecturn/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentsWithScope } from "./session";

export const appsEnvironment = createAppsEnvironmentAtoms(connectionAtomRuntime);

/**
 * Connected apps by environment. Only sessions holding `access:read` may list them, so other
 * environments are not subscribed at all rather than failing.
 */
export function useAppStatusesByEnvironment(
  environments: ReadonlyArray<{ readonly environmentId: EnvironmentId }>,
): ReadonlyMap<EnvironmentId, ReadonlyArray<AppStatus>> {
  const readable = useEnvironmentsWithScope(environments, AuthAccessReadScope);
  const statusesAtom = Atom.make((get) => {
    const byEnvironment = new Map<EnvironmentId, ReadonlyArray<AppStatus>>();
    for (const environmentId of readable) {
      const apps = Option.getOrNull(
        AsyncResult.value(get(appsEnvironment.statuses({ environmentId, input: null }))),
      );
      if (apps !== null && apps.length > 0) byEnvironment.set(environmentId, apps);
    }
    return byEnvironment;
  });
  return useAtomValue(statusesAtom);
}

const EMPTY_EMBED_CONTEXT_ATOM = Atom.make<AppEmbedContext | null>(null).pipe(
  Atom.withLabel("mobile-app-embed-context:empty"),
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
  }).pipe(Atom.withLabel(`mobile-app-embed-context:${key}`));
});

/** The app bound to a project; pass null for a project without an app binding. */
export function useAppEmbedContext(ref: ScopedProjectRef | null): AppEmbedContext | null {
  return useAtomValue(
    ref === null ? EMPTY_EMBED_CONTEXT_ATOM : embedContextAtom(scopedProjectKey(ref)),
  );
}

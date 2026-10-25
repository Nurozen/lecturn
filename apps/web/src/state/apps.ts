import { useAtomValue } from "@effect/atom-react";
import { createAppsEnvironmentAtoms } from "@lecturn/client-runtime/state/apps";
import { parseScopedProjectKey, scopedProjectKey } from "@lecturn/client-runtime/environment";
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
import { environmentAtomList, environmentIdsKey } from "./environmentAtomList";
import { useEnvironmentIdentities } from "./environments";
import { useEnvironmentsWithScope } from "./session";

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

const appStatusResultsAtom = environmentAtomList("web-app-statuses", (environmentId) =>
  appsEnvironment.statuses({ environmentId, input: null }),
);

const appStatusesAtom = Atom.family((idsKey: string) => {
  const ids = idsKey === "" ? [] : (idsKey.split("\n") as EnvironmentId[]);
  const results = appStatusResultsAtom(idsKey);
  return Atom.make((get) =>
    get(results).flatMap((result, index) =>
      (Option.getOrNull(AsyncResult.value(result)) ?? []).map((app) => ({
        environmentId: ids[index]!,
        app,
      })),
    ),
  ).pipe(Atom.withLabel(`web-app-statuses-flat:${idsKey}`));
});

/**
 * Every app status this client may read, tagged with its environment. Environments
 * without `access:read` are skipped rather than subscribed to and refused.
 */
export function useAppStatuses(): ReadonlyArray<{
  readonly environmentId: EnvironmentId;
  readonly app: AppStatus;
}> {
  const environments = useEnvironmentIdentities();
  const readable = useEnvironmentsWithScope(environments, AuthAccessReadScope);
  return useAtomValue(
    appStatusesAtom(
      environmentIdsKey(
        environments
          .map((environment) => environment.environmentId)
          .filter((environmentId) => readable.has(environmentId)),
      ),
    ),
  );
}

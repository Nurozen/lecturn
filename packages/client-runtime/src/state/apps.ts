import { APPS_WS_METHODS, type AppStatus, type AppStatusStreamEvent } from "@lecturn/contracts";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe } from "../rpc/client.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";

export const EMPTY_APP_STATUSES: ReadonlyArray<AppStatus> = [];

/** An upsert keeps the app's position so a status change never reorders the list. */
export function applyAppStatusStreamEvent(
  current: ReadonlyArray<AppStatus>,
  event: AppStatusStreamEvent,
): ReadonlyArray<AppStatus> {
  switch (event.type) {
    case "snapshot":
      return event.apps;
    case "upsert": {
      const index = current.findIndex((app) => app.appId === event.app.appId);
      if (index === -1) return [...current, event.app];
      const next = [...current];
      next[index] = event.app;
      return next;
    }
    case "remove":
      return current.filter((app) => app.appId !== event.appId);
  }
}

export function createAppsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** Every connected app's status in one environment, folded from the status stream. */
    statuses: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:apps:statuses",
      subscribe: (_input: null) =>
        subscribe(APPS_WS_METHODS.appsSubscribeStatus, {}).pipe(
          Stream.mapAccum(
            () => EMPTY_APP_STATUSES,
            (current, event) => {
              const next = applyAppStatusStreamEvent(current, event);
              return [next, [next]] as const;
            },
          ),
        ),
    }),
    decidePairing: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:apps:decide-pairing",
      tag: APPS_WS_METHODS.appsDecidePairing,
    }),
    revoke: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:apps:revoke",
      tag: APPS_WS_METHODS.appsRevoke,
    }),
    setRuntimeCeiling: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:apps:set-runtime-ceiling",
      tag: APPS_WS_METHODS.appsSetRuntimeCeiling,
    }),
    delete: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:apps:delete",
      tag: APPS_WS_METHODS.appsDelete,
    }),
    /** The app bound to a project, for its reference chips, "Open in" and closed state. */
    embedContext: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:apps:embed-context",
      tag: APPS_WS_METHODS.appsSubscribeEmbedContext,
    }),
    // Only an embed token may call this: the server sets the owning app's appData on the
    // thread it creates, which a client create could not do.
    createEmbedThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:apps:create-embed-thread",
      tag: APPS_WS_METHODS.appsCreateEmbedThread,
    }),
    // The embed holds no settings scope; the server writes this one key of its own project.
    setEmbedDefaultModel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:apps:set-embed-default-model",
      tag: APPS_WS_METHODS.appsSetEmbedDefaultModel,
    }),
  };
}

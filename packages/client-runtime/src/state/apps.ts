import { APPS_WS_METHODS } from "@lecturn/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createAppsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
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

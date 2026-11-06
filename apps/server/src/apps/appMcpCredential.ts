/**
 * The `app` part of a thread's `/mcp` credential: present exactly when the
 * thread's project belongs to a connected app, so only those threads see the
 * app's tools.
 */
import type { AppId, ThreadId } from "@lecturn/contracts";
import type { McpProviderSessionConfig } from "@lecturn/provider-core/server/mcpSession";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import type { McpAppCaller } from "../mcp/McpInvocationContext.ts";
import type { ProjectionStoreV2Shape } from "../orchestration-v2/ProjectionStore.ts";
import type * as ProjectService from "../project/ProjectService.ts";
import { type AppCredentialTools, AppRuntimeState } from "./AppRuntimeState.ts";

/**
 * Reached optionally, as appTurnInstructions does, so session manager tests
 * that build no apps state mint credentials without app tool names.
 */
const appToolsFor = Effect.fn("appMcpCredential.appToolsFor")(function* (
  appId: AppId,
): Effect.fn.Return<AppCredentialTools | undefined> {
  const state = yield* Effect.serviceOption(AppRuntimeState);
  if (Option.isNone(state)) return undefined;
  const lookup = yield* Ref.get(state.value.appTools);
  if (Option.isNone(lookup)) return undefined;
  return Option.getOrUndefined(yield* lookup.value(appId));
});

export const appCredentialFields: (
  projection: ProjectionStoreV2Shape,
  projects: Option.Option<ProjectService.ProjectService["Service"]>,
  threadId: ThreadId,
) => Effect.Effect<{ readonly app?: McpAppCaller; readonly appTools?: AppCredentialTools }> =
  Effect.fn("appMcpCredential.appCredentialFields")(
    function* (projection, projects, threadId) {
      if (Option.isNone(projects)) return {};
      const { projectId } = yield* projection.getThread(threadId);
      const binding = Option.getOrUndefined(yield* projects.value.getShell(projectId))?.appBinding;
      if (binding === undefined) return {};
      const appTools = yield* appToolsFor(binding.appId);
      return {
        app: { appId: binding.appId, projectId },
        ...(appTools === undefined ? {} : { appTools }),
      };
    },
    (effect, projection, projects, threadId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not resolve the thread's connected app", {
            threadId,
            cause,
          }).pipe(Effect.as({})),
        ),
      ),
  );

/**
 * A reused credential keeps the names it was minted with, but a live lease or
 * a first headless listing can add tools since. `undefined` means unchanged.
 */
export const refreshedAppTools = Effect.fn("appMcpCredential.refreshedAppTools")(function* (
  config: McpProviderSessionConfig,
): Effect.fn.Return<McpProviderSessionConfig["app"] | undefined> {
  if (config.app === undefined) return undefined;
  const current = yield* appToolsFor(config.app.appId as AppId);
  if (current === undefined) return undefined;
  const unchanged =
    current.toolPrefix === config.app.toolPrefix &&
    current.toolNames.length === config.app.toolNames.length &&
    current.toolNames.every((name, index) => config.app?.toolNames[index] === name);
  return unchanged ? undefined : { appId: config.app.appId, ...current };
});

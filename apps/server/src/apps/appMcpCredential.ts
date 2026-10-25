/**
 * The `app` part of a thread's `/mcp` credential: present exactly when the
 * thread's project belongs to a connected app, so only those threads see the
 * app's tools.
 */
import type { ThreadId } from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { McpAppCaller } from "../mcp/McpInvocationContext.ts";
import type { ProjectionStoreV2Shape } from "../orchestration-v2/ProjectionStore.ts";
import type * as ProjectService from "../project/ProjectService.ts";

export const appCredentialFields = (
  projection: ProjectionStoreV2Shape,
  projects: Option.Option<ProjectService.ProjectService["Service"]>,
  threadId: ThreadId,
): Effect.Effect<{ readonly app?: McpAppCaller }> =>
  Effect.gen(function* () {
    if (Option.isNone(projects)) return {};
    const { projectId } = yield* projection.getThread(threadId);
    const binding = Option.getOrUndefined(yield* projects.value.getShell(projectId))?.appBinding;
    return binding === undefined ? {} : { app: { appId: binding.appId, projectId } };
  }).pipe(
    // Without the binding the thread simply gets no app tools.
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not resolve the thread's connected app", { threadId, cause }).pipe(
        Effect.as({}),
      ),
    ),
  );

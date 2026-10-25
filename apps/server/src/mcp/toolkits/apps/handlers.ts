import type { AppStatus, OrchestrationProjectShell } from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { AppRegistryService } from "../../../apps/services.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { AppsToolkit, type McpConnectedApp } from "./tools.ts";

/** An app thread is shown its own app and project only, as it reaches no other (R2.3). */
export const connectedApps = (
  scope: McpInvocationContext.McpInvocationScope,
  statuses: ReadonlyArray<AppStatus>,
  shells: ReadonlyArray<OrchestrationProjectShell>,
): ReadonlyArray<McpConnectedApp> =>
  statuses
    .filter((status) => scope.app === undefined || status.appId === scope.app.appId)
    .map((status) => ({
      appId: status.appId,
      name: status.name,
      toolPrefix: status.toolPrefix,
      state: status.state,
      live: status.live !== null,
      pairingPending: status.pendingRequest !== null,
      runtimeCeiling: status.runtimeCeiling,
      lastSeenAt: status.lastSeenAt,
      projects: shells
        .filter(
          (shell) =>
            shell.appBinding?.appId === status.appId &&
            (scope.app === undefined || shell.id === scope.app.projectId),
        )
        .map((shell) => ({
          projectId: shell.id,
          title: shell.title,
          workspaceRoot: shell.workspaceRoot,
        })),
    }));

export const layer = McpToolAccess.toLayer(AppsToolkit, {
  lecturn_apps_list: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      // A server built without the apps services has no connected apps to list.
      const registry = yield* Effect.serviceOption(AppRegistryService);
      if (Option.isNone(registry)) return { apps: [] };
      const statuses = yield* registry.value.list.pipe(Effect.mapError(unavailable));
      const projects = yield* ProjectService.ProjectService;
      const shells = yield* projects.listShells().pipe(Effect.mapError(unavailable));
      return { apps: connectedApps(scope, statuses, shells) };
    }),
  ),
});

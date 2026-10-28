import type { AppEmbedContext, AppStatus, EnvironmentId } from "@lecturn/contracts";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useAppEmbedContext, useAppStatuses } from "../../state/apps";
import { useProjects, useServerConfigs, useThreadShells } from "../../state/entities";
import { useEnvironmentIdentities } from "../../state/environments";
import {
  appStatusChip,
  appTargetWorkspace,
  buildAppsSidebarApps,
  type AppsSidebarApp,
} from "./AppsSidebar.logic";

const NO_THREADS: never[] = [];

/**
 * Apps mode's tree. `withThreads: false` skips the thread partition for callers that only
 * name the apps, such as the scope picker, so they do not recompute on every shell event.
 */
export function useAppsSidebarApps(
  options: { readonly withThreads: boolean } = { withThreads: true },
): ReadonlyArray<AppsSidebarApp> {
  const statuses = useAppStatuses();
  const projects = useProjects();
  const threads = useThreadShells(options.withThreads);
  const environments = useEnvironmentIdentities();
  const serverConfigs = useServerConfigs();
  const nowMinute = useNowMinute();
  return buildAppsSidebarApps({
    statuses,
    projects,
    threads: options.withThreads ? threads : NO_THREADS,
    environmentLabels: new Map(
      environments.map((environment) => [environment.environmentId, environment.label] as const),
    ),
    now: `${nowMinute}:00.000Z`,
    supports: (environmentId: EnvironmentId) => {
      const capabilities = serverConfigs.get(environmentId)?.environment.capabilities;
      return {
        settlement: capabilities?.threadSettlement === true,
        snooze: capabilities?.threadSnooze === true,
      };
    },
  });
}

interface AppPresentation {
  readonly name: string;
  readonly iconDataUrl: string | null;
  readonly chip: ReturnType<typeof appStatusChip> | null;
  readonly state: AppStatus["state"] | null;
  readonly openUrlTemplate: string | null;
}

/**
 * Name, icon and status from the app's status stream, or, for a session that cannot read
 * statuses, from the embed context of the workspace its actions target.
 */
export function useAppPresentation(app: AppsSidebarApp): AppPresentation {
  const target = appTargetWorkspace(app);
  const context: AppEmbedContext | null = useAppEmbedContext(
    app.primary === null && target !== null
      ? { environmentId: target.project.environmentId, projectId: target.project.id }
      : null,
  );
  const source = app.primary?.app ?? context;
  return {
    name: source?.name ?? app.name,
    iconDataUrl: source?.iconDataUrl ?? null,
    chip: source === null ? null : appStatusChip(source),
    state: source?.state ?? null,
    openUrlTemplate: source?.openUrlTemplate ?? null,
  };
}

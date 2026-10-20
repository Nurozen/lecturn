import { useMemo } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { selectProjectGroupingSettings } from "../../logicalProject";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useProjectAccountScope, useSidebarSegmentation } from "../sidebar/accountProjectGroups";
import { buildSettingsProjectGroups } from "./ProjectSettingsPanel.logic";

/**
 * Logical project groups for the settings page, sorted by display name. An
 * account-scoped `projectKey`, as a segmented sidebar links with, narrows them
 * to that account's projects; `segmentAccounts` keys and names each account's
 * groups apart, as the segmented sidebar does.
 */
export function useSettingsProjectGroups(
  projectKey = "",
  segmentAccounts = false,
): SidebarProjectSnapshot[] {
  const accountScope = useProjectAccountScope(projectKey);
  const segmentation = useSidebarSegmentation();
  const projects = useProjects();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  return useMemo(
    () =>
      buildSettingsProjectGroups({
        accountScope,
        segmentation,
        segmentAccounts,
        input: {
          projects,
          settings: projectGroupingSettings,
          primaryEnvironmentId,
          resolveEnvironmentLabel: (environmentId) =>
            environmentLabelById.get(environmentId) ?? null,
        },
      }),
    [
      accountScope,
      segmentAccounts,
      segmentation,
      environmentLabelById,
      primaryEnvironmentId,
      projectGroupingSettings,
      projects,
    ],
  );
}

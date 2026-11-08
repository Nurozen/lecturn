import { useClientSettings } from "../../hooks/useSettings";
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
  // Avoid object selector identities that rebuild groups and every settings row on each write.
  const sidebarProjectGroupingMode = useClientSettings(
    (settings) => settings.sidebarProjectGroupingMode,
  );
  const sidebarProjectGroupingOverrides = useClientSettings(
    (settings) => settings.sidebarProjectGroupingOverrides,
  );
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const labels = new Map(environments.map((entry) => [entry.environmentId, entry.label]));
  return buildSettingsProjectGroups({
    accountScope,
    segmentation,
    segmentAccounts,
    input: {
      projects,
      settings: { sidebarProjectGroupingMode, sidebarProjectGroupingOverrides },
      primaryEnvironmentId,
      resolveEnvironmentLabel: (environmentId) => labels.get(environmentId) ?? null,
    },
  });
}

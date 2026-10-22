import { useMemo } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AuthEnvironmentMaintainScope } from "@lecturn/contracts";

import { knownConnectAccountsAtom } from "~/cloud/knownAccounts";
import { usePrimaryCloudLinkState } from "~/cloud/primaryCloudLinkState";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { isElectron } from "~/env";
import { isLocalEnvironmentDisabled } from "~/localEnvironment";
import { desktopWslStateAtom } from "~/state/desktopWslState";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { primaryServerConfigAtom } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { isWslSettingsRowVisible } from "./ConnectionsSettings.logic";
import { isProviderSettingsEnvironmentAvailable } from "./ProviderSettingsPanel.logic";
import type { SettingsScopeSearch } from "./settingsScope";
import {
  filterAvailableSettingsSearchItems,
  getThreadAutoSettlementSearchAvailability,
} from "./settingsSearch";

export function useAvailableSettingsSearchItems(scopeSearch: SettingsScopeSearch = {}) {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // Stave settings live on the primary server, so its rows follow that config.
  const primaryServerConfig = useAtomValue(primaryServerConfigAtom);
  const hasConnectAccountMenu = useAtomValue(knownConnectAccountsAtom).accountIds.length > 0;
  const localEnvironmentDisabled = isLocalEnvironmentDisabled();
  const canMaintain = useEnvironmentScope(primaryEnvironmentId, AuthEnvironmentMaintainScope);
  const canManageLocalBackend = !localEnvironmentDisabled && canMaintain;
  const desktopWsl = useEnvironmentQuery(
    isElectron && canManageLocalBackend ? desktopWslStateAtom : null,
  );
  const cloudLinkState = usePrimaryCloudLinkState().data;
  // Same fallback as the Relay publishing row: older servers imply a tunnel from `linked`.
  const managedTunnelActive =
    cloudLinkState?.managedTunnelActive ?? cloudLinkState?.linked ?? false;

  return useMemo(
    () =>
      filterAvailableSettingsSearchItems({
        localEnvironmentDisabled,
        hasCloudPublicConfig: hasCloudPublicConfig(),
        hasEnvironment: environments.some((environment) => environment.serverConfig !== null),
        hasProviderSettingsEnvironment: environments.some((environment) =>
          isProviderSettingsEnvironmentAvailable({
            connectionPhase: environment.connection.phase,
            hasServerConfig: environment.serverConfig !== null,
          }),
        ),
        hasMacProviderSettingsEnvironment: environments.some(
          (environment) =>
            (scopeSearch.machine === undefined ||
              environment.environmentId === scopeSearch.machine) &&
            environment.serverConfig?.environment.platform.os === "darwin" &&
            isProviderSettingsEnvironmentAvailable({
              connectionPhase: environment.connection.phase,
              hasServerConfig: true,
            }),
        ),
        canManageLocalBackend,
        isWslSettingsRowVisible: isWslSettingsRowVisible({
          state: desktopWsl.data,
          error: desktopWsl.error,
        }),
        hasThreadAutoSettlement:
          getThreadAutoSettlementSearchAvailability(environments).eligibleEnvironmentIds.length > 0,
        hasStave: primaryServerConfig?.environment.capabilities.stave !== undefined,
        hasConnectAccountMenu,
        hasStaveLifecycle: primaryServerConfig?.settings.stave.enabled === true,
        hasStaveGrace:
          primaryServerConfig?.settings.stave.enabled === true &&
          primaryServerConfig.settings.stave.lifecycle.onAllThreadsSettled ===
            "archive-after-grace",
        hasStaveDestroy:
          primaryServerConfig?.settings.stave.enabled === true &&
          primaryServerConfig.settings.stave.lifecycle.onProjectDelete === "destroy",
        managedTunnelActive,
      }),
    [
      managedTunnelActive,
      canManageLocalBackend,
      desktopWsl.data,
      desktopWsl.error,
      environments,
      hasConnectAccountMenu,
      localEnvironmentDisabled,
      primaryServerConfig,
      scopeSearch.machine,
    ],
  );
}

import { useMemo, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@lecturn/contracts";
import { ScopedVariables } from "uniwind";
import { environmentCatalog } from "../connection/catalog";
import { useConnectAccounts } from "../features/cloud/knownAccounts";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { mobileAccountTintVariables } from "./accountTint";
import { glassAccessibilityVariables } from "./glassTheme";
import { useGlassAccessibility } from "./useGlassAccessibility";
import { AccountTintContext } from "./accountTintContext";
import { getMobileThemeRuntimeVariables } from "./mobileThemeVariables";

export function AccountTintScope({
  environmentId,
  children,
}: {
  readonly environmentId: EnvironmentId;
  readonly children: ReactNode;
}) {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const accounts = useConnectAccounts();
  const target = catalog.entries.get(environmentId)?.target;
  const id = target?._tag === "RelayConnectionTarget" ? target.accountId : undefined;
  const preset = accounts.find((account) => account.accountId === id)?.preset;
  const { themeId, themeAppearance } = useAppearancePreferences();
  const opaque = useGlassAccessibility();
  const tint = useMemo(
    () => (preset ? mobileAccountTintVariables(themeId, themeAppearance, preset) : {}),
    [themeId, themeAppearance, preset],
  );
  const variables = useMemo(() => {
    const combined = { ...getMobileThemeRuntimeVariables(themeId, themeAppearance), ...tint };
    return { ...tint, ...glassAccessibilityVariables(combined, opaque) };
  }, [themeId, themeAppearance, tint, opaque]);
  return (
    <AccountTintContext.Provider value={tint}>
      <ScopedVariables variables={variables}>{children}</ScopedVariables>
    </AccountTintContext.Provider>
  );
}

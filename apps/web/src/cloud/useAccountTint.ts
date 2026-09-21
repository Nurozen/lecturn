import type { EnvironmentId } from "@lecturn/contracts";
import { useAtomValue } from "@effect/atom-react";
import { tintThemeColors } from "@lecturn/shared/accountTint";
import { THEME_COLOR_ROLES, type ThemeColors } from "@lecturn/shared/themePalettes";
import { useMemo, useSyncExternalStore, type CSSProperties } from "react";
import {
  getAppliedThemeColors,
  getThemeColorVariable,
  subscribeToAppliedThemeColors,
  toCanonicalThemeColor,
} from "../themePalette";
import { accountByEnvironmentIdAtom, connectAccountProfilesAtom } from "./connectAccounts";

/** Subscribes to the actual applied palette so previews and same-id refreshes also recompute the tint. */
export function useAccountTint(environmentId: EnvironmentId | null | undefined): {
  readonly "data-account-tint"?: string;
  readonly style?: CSSProperties;
} {
  const owners = useAtomValue(accountByEnvironmentIdAtom);
  const profiles = useAtomValue(connectAccountProfilesAtom);
  const colors = useSyncExternalStore(
    subscribeToAppliedThemeColors,
    getAppliedThemeColors,
    () => null,
  );
  const accountId = environmentId ? owners.get(environmentId) : undefined;
  const preset = accountId ? (profiles.get(accountId)?.preset ?? "jade") : null;
  return useMemo(() => {
    if (!accountId || !preset || !colors) return {};
    const canonical = Object.fromEntries(
      THEME_COLOR_ROLES.map((role) => [role, toCanonicalThemeColor(colors[role]) ?? colors[role]]),
    ) as unknown as ThemeColors;
    const tinted = tintThemeColors(canonical, preset);
    return {
      "data-account-tint": preset,
      style: Object.fromEntries(
        THEME_COLOR_ROLES.map((role) => [getThemeColorVariable(role), tinted[role]]),
      ) as CSSProperties,
    };
  }, [accountId, colors, preset]);
}

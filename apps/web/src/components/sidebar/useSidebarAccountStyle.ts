import { knownConnectAccountsAtom } from "../../cloud/knownAccounts";
import { sidebarOwnerForEnvironments } from "./sidebarAccountStyle.logic";
import { useAtomValue } from "@effect/atom-react";
import { accountTintColor } from "@lecturn/shared/accountTint";
import { useCallback, type CSSProperties } from "react";
import {
  accountByEnvironmentIdAtom,
  connectAccountProfilesAtom,
} from "../../cloud/connectAccounts";

/** Account colors distinguish multiple accounts; local and single-account views use gold.
 * A logical project spanning local and owned environments stays neutral. */
export function useSidebarAccountStyle() {
  const owners = useAtomValue(accountByEnvironmentIdAtom);
  const profiles = useAtomValue(connectAccountProfilesAtom);
  const multiAccount = useAtomValue(knownConnectAccountsAtom).accountIds.length > 1;
  return useCallback(
    (environmentIds: ReadonlyArray<string>): CSSProperties => {
      const accountId = sidebarOwnerForEnvironments(environmentIds, owners);
      const useAccountColor = multiAccount && accountId;
      const tint = useAccountColor
        ? accountTintColor(profiles.get(accountId)?.preset)
        : "var(--sidebar-neutral-tint)";
      return {
        "--account-tint": tint,
        "--sidebar-tree-tint": tint,
        // Champagne neutral edges match the pane rail; do not boost their chroma.
        "--sidebar-tree-connector": useAccountColor
          ? `oklch(from ${tint} 0.8 calc(c * 1.2) h)`
          : "var(--sidebar-neutral-light)",
        "--sidebar-tree-edge": useAccountColor
          ? `oklch(from ${tint} 0.78 calc(c * 1.25) h)`
          : "var(--sidebar-neutral-light)",
      } as CSSProperties;
    },
    [owners, profiles, multiAccount],
  );
}

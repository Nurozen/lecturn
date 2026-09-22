import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@lecturn/contracts";
import { knownConnectAccountsAtom } from "../../cloud/knownAccounts";
import { useAccountTint } from "../../cloud/useAccountTint";
import "./project-settings-glass.css";

/** Portalled editors carry their actual environment's color instead of the active chat's. */
export function useSettingsAccountGlass(environmentId: EnvironmentId | null | undefined) {
  const tint = useAccountTint(environmentId);
  const accounts = useAtomValue(knownConnectAccountsAtom);
  return {
    ...tint,
    "data-glass-neutral": accounts.accountIds.length < 2 || !tint["data-account-id"] || undefined,
  };
}

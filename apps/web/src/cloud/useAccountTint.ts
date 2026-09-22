import type { EnvironmentId } from "@lecturn/contracts";
import { useAtomValue } from "@effect/atom-react";
import { accountTintColor } from "@lecturn/shared/accountTint";
import type { CSSProperties } from "react";
import { accountByEnvironmentIdAtom, connectAccountProfilesAtom } from "./connectAccounts";

/** Ownership colors decorate surfaces; theme text, actions and status colors stay stable. */
export function useAccountTint(environmentId: EnvironmentId | null | undefined): {
  readonly "data-account-tint"?: string;
  readonly "data-account-id"?: string;
  readonly style?: CSSProperties;
} {
  const owners = useAtomValue(accountByEnvironmentIdAtom);
  const profiles = useAtomValue(connectAccountProfilesAtom);
  const accountId = environmentId ? owners.get(environmentId) : undefined;
  if (!accountId) return {};
  const preset = profiles.get(accountId)?.preset ?? "jade";
  return {
    "data-account-tint": preset,
    "data-account-id": accountId,
    style: { "--account-tint": accountTintColor(preset) } as CSSProperties,
  };
}

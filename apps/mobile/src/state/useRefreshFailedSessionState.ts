import { refreshSessionStateIfFailed } from "@lecturn/client-runtime/state/session";
import type { EnvironmentId } from "@lecturn/contracts";
import { useFocusEffect } from "@react-navigation/native";

import { appAtomRegistry } from "./atom-registry";
import { environmentSession } from "./session";

/** Refetches a failed session status whenever the calling screen gains focus. */
export function useRefreshFailedSessionState(environmentId: EnvironmentId | null): void {
  useFocusEffect(() => {
    if (environmentId === null) return;
    refreshSessionStateIfFailed(
      appAtomRegistry,
      environmentSession.sessionStateAtom(environmentId),
    );
  });
}

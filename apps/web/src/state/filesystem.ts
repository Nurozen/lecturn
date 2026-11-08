import {
  createFilesystemEnvironmentAtoms,
  resolveFilesystemReadAccess,
} from "@lecturn/client-runtime/state/filesystem";
import { RegistryContext } from "@effect/atom-react";
import { refreshSessionStateIfFailed } from "@lecturn/client-runtime/state/session";
import type { EnvironmentId } from "@lecturn/contracts";
import { useContext, useEffect } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentPresentation } from "./presentation";
import { useEnvironmentQuery } from "./query";
import { environmentSession } from "./session";

export const filesystemEnvironment = createFilesystemEnvironmentAtoms(connectionAtomRuntime);

export function useFilesystemReadAccess(environmentId: EnvironmentId | null) {
  const session = useEnvironmentQuery(
    environmentId === null ? null : environmentSession.sessionStateAtom(environmentId),
  );
  const environment = useEnvironmentPresentation(environmentId);
  return resolveFilesystemReadAccess({
    isCatalogReady: environment.isReady,
    connection: environment.presentation?.connection ?? null,
    session: session.data,
    sessionError: session.error,
  });
}

/**
 * Refetches a failed session status when a file-access view mounts. The status
 * atom stays mounted by other views, so a cached failure would not otherwise
 * revalidate. Call it from views, not per-row helpers.
 */
export function useRefreshFailedSessionState(environmentId: EnvironmentId | null): void {
  const registry = useContext(RegistryContext);
  // oxlint-disable-next-line lecturn/no-unreasoned-state-sync -- refetches a cached failed session status atom in the registry when the view mounts
  useEffect(() => {
    if (environmentId === null) return;
    refreshSessionStateIfFailed(registry, environmentSession.sessionStateAtom(environmentId));
  }, [environmentId, registry]);
}

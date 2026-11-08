import {
  createFilesystemEnvironmentAtoms,
  resolveFilesystemReadAccess,
} from "@lecturn/client-runtime/state/filesystem";
import { refreshSessionStateIfFailed } from "@lecturn/client-runtime/state/session";
import type { EnvironmentId } from "@lecturn/contracts";
import { useEffect } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useEnvironmentPresentation } from "./presentation";
import { useEnvironmentQuery } from "./query";
import { environmentSession } from "./session";

export const filesystemEnvironment = createFilesystemEnvironmentAtoms(connectionAtomRuntime);

export function useFilesystemReadAccess(environmentId: EnvironmentId | null) {
  const session = useEnvironmentQuery(
    environmentId === null ? null : environmentSession.sessionStateAtom(environmentId),
  );
  useEffect(() => {
    if (environmentId === null) return;
    refreshSessionStateIfFailed(
      appAtomRegistry,
      environmentSession.sessionStateAtom(environmentId),
    );
  }, [environmentId]);
  const environment = useEnvironmentPresentation(environmentId);
  return resolveFilesystemReadAccess({
    isCatalogReady: environment.isReady,
    connection: environment.presentation?.connection ?? null,
    session: session.data,
    sessionError: session.error,
  });
}

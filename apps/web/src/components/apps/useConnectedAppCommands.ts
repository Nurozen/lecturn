import { useAtomValue } from "@effect/atom-react";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@lecturn/client-runtime/state/runtime";
import type { AppRuntimeCeiling, AppStatus, EnvironmentId } from "@lecturn/contracts";
import { useState } from "react";

import { appsEnvironment } from "~/state/apps";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  connectedAppActionError,
  type ConnectedAppAction,
} from "../settings/ConnectedAppsSettings.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";

const FAILURE_TITLES: Readonly<Record<ConnectedAppAction, string>> = {
  approve: "Could not approve app",
  deny: "Could not deny app",
  revoke: "Could not revoke app",
  ceiling: "Could not change runtime ceiling",
  delete: "Could not remove app",
};

/**
 * The connected-app mutations shared by the pairing prompt and Settings, each
 * reporting its own failure. Every one needs `access:write`, so `canManage`
 * covers them all.
 */
export function useConnectedAppCommands(environmentId: EnvironmentId | null) {
  const canManage = useAtomValue(appsEnvironment.revoke.permissionAtom(environmentId));
  const [busyAppId, setBusyAppId] = useState<string | null>(null);
  const decidePairing = useAtomCommand(appsEnvironment.decidePairing, { reportFailure: false });
  const revokeApp = useAtomCommand(appsEnvironment.revoke, { reportFailure: false });
  const setCeiling = useAtomCommand(appsEnvironment.setRuntimeCeiling, { reportFailure: false });
  const deleteApp = useAtomCommand(appsEnvironment.delete, { reportFailure: false });

  const run = async (
    app: Pick<AppStatus, "appId" | "name">,
    action: ConnectedAppAction,
    execute: (environmentId: EnvironmentId) => Promise<AtomCommandResult<unknown, unknown>>,
    options: { readonly deleteThreads?: boolean } = {},
  ): Promise<boolean> => {
    if (environmentId === null || !canManage) return false;
    setBusyAppId(app.appId);
    // React Compiler rejects try/finally, so the busy flag is cleared on both paths by hand.
    let result: AtomCommandResult<unknown, unknown>;
    try {
      result = await execute(environmentId);
    } catch (error) {
      setBusyAppId(null);
      throw error;
    }
    setBusyAppId(null);
    if (result._tag === "Success") return true;
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: FAILURE_TITLES[action],
          description: connectedAppActionError(action, squashAtomCommandFailure(result), options),
        }),
      );
    }
    return false;
  };

  return {
    canManage,
    busyAppId,
    /** The ceiling is applied before the grant so the app never runs above it. */
    approve: (app: AppStatus, requestedCeiling?: AppRuntimeCeiling) => {
      const ceiling = requestedCeiling ?? app.runtimeCeiling;
      const request = app.pendingRequest;
      if (request === null) return Promise.resolve(false);
      return run(app, "approve", async (id) => {
        if (ceiling !== app.runtimeCeiling) {
          const set = await setCeiling({ environmentId: id, input: { appId: app.appId, ceiling } });
          if (set._tag === "Failure") return set;
        }
        return decidePairing({
          environmentId: id,
          input: { requestId: request.requestId, decision: "grant" },
        });
      });
    },
    deny: (app: AppStatus) => {
      const request = app.pendingRequest;
      if (request === null) return Promise.resolve(false);
      return run(app, "deny", (id) =>
        decidePairing({
          environmentId: id,
          input: { requestId: request.requestId, decision: "deny" },
        }),
      );
    },
    revoke: (app: AppStatus) =>
      run(app, "revoke", (id) => revokeApp({ environmentId: id, input: { appId: app.appId } })),
    setRuntimeCeiling: (app: AppStatus, ceiling: AppRuntimeCeiling) =>
      run(app, "ceiling", (id) =>
        setCeiling({ environmentId: id, input: { appId: app.appId, ceiling } }),
      ),
    remove: (app: AppStatus, deleteThreads: boolean) =>
      run(
        app,
        "delete",
        (id) => deleteApp({ environmentId: id, input: { appId: app.appId, deleteThreads } }),
        { deleteThreads },
      ),
  };
}

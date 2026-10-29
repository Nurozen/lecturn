import { useAtomValue } from "@effect/atom-react";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@lecturn/client-runtime/state/runtime";
import type { AppStatus, EnvironmentId } from "@lecturn/contracts";
import { useState } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { appsEnvironment } from "../../state/apps";
import { useAtomCommand } from "../../state/use-atom-command";

type ConnectedAppAction = "approve" | "deny" | "revoke";

const FAILURE_TITLES: Readonly<Record<ConnectedAppAction, string>> = {
  approve: "Could not approve app",
  deny: "Could not deny app",
  revoke: "Could not revoke app",
};

function failureMessage(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim().length > 0
  ) {
    return error.message;
  }
  return "The environment refused the change.";
}

/**
 * Pairing decisions and revoke for one environment. Each needs `access:write`; the server checks
 * again, so `canManage` only decides whether the controls are offered.
 */
export function useConnectedAppCommands(environmentId: EnvironmentId) {
  const canManage = useAtomValue(appsEnvironment.revoke.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const decidePairing = useAtomCommand(appsEnvironment.decidePairing, { reportFailure: false });
  const revokeApp = useAtomCommand(appsEnvironment.revoke, { reportFailure: false });

  const run = async (
    action: ConnectedAppAction,
    execute: () => Promise<AtomCommandResult<unknown, unknown>>,
  ): Promise<boolean> => {
    if (!canManage) return false;
    setBusy(true);
    // `.finally`, not try/finally: the React Compiler cannot lower a try without a catch.
    const result = await execute().finally(() => setBusy(false));
    if (result._tag === "Success") return true;
    if (!isAtomCommandInterrupted(result)) {
      Dialog.alert(FAILURE_TITLES[action], failureMessage(squashAtomCommandFailure(result)));
    }
    return false;
  };

  const decide = (app: AppStatus, decision: "grant" | "deny") => {
    const request = app.pendingRequest;
    if (request === null) return Promise.resolve(false);
    return run(decision === "grant" ? "approve" : "deny", () =>
      decidePairing({ environmentId, input: { requestId: request.requestId, decision } }),
    );
  };

  return {
    canManage,
    busy,
    approve: (app: AppStatus) => decide(app, "grant"),
    deny: (app: AppStatus) => decide(app, "deny"),
    revoke: (app: AppStatus) =>
      run("revoke", () => revokeApp({ environmentId, input: { appId: app.appId } })),
  };
}

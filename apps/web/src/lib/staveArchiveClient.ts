import { staveRpcErrorMessage } from "@lecturn/client-runtime/errors";
import type { StaveArchiveClient } from "@lecturn/client-runtime/state/stave-archive";
import { runAtomCommand, squashAtomCommandFailure } from "@lecturn/client-runtime/state/runtime";
import type { EnvironmentId } from "@lecturn/contracts";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { staveDryRun, staveSpacesRead } from "../state/stave";
import { staveOperations } from "../state/staveOperations";
import { randomUUID } from "./utils";

function failureMessage(result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}) {
  const error = squashAtomCommandFailure(result);
  return (
    staveRpcErrorMessage(error) ??
    (error instanceof Error && error.message.length > 0
      ? error.message
      : "The Stave request failed.")
  );
}

/**
 * Web binding of the shared archive runners (`restoreStaveArchive`,
 * `undoStaveArchive`, `deleteStaveArchive`): operations run through the web
 * operation manager, so a progress view can follow `stateAtom(operationId)`.
 */
export function webStaveArchiveClient(environmentId: EnvironmentId): StaveArchiveClient {
  return {
    newOperationId: randomUUID,
    run: async (operationId, operation) => {
      const result = await runAtomCommand(
        appAtomRegistry,
        staveOperations.run,
        { environmentId, operationId, operation },
        { reportFailure: false },
      );
      if (result._tag === "Failure") throw new Error(failureMessage(result));
      return result.value;
    },
    listSpaces: async () => {
      const result = await runAtomCommand(
        appAtomRegistry,
        staveSpacesRead,
        { environmentId, input: { includeArchived: true } },
        { reportFailure: false },
      );
      if (result._tag === "Failure") throw new Error(failureMessage(result));
      return result.value;
    },
    dryRun: async (operation) => {
      const result = await runAtomCommand(
        appAtomRegistry,
        staveDryRun,
        { environmentId, input: { operation } },
        { reportFailure: false },
      );
      if (result._tag === "Failure") throw new Error(failureMessage(result));
      return result.value;
    },
  };
}

import {
  staveArchiveUndo,
  undoStaveArchive,
  type StaveArchiveUndo,
} from "@lecturn/client-runtime/state/stave-archive";
import type { EnvironmentId, StaveOperationResult } from "@lecturn/contracts";

import { webStaveArchiveClient } from "../../lib/staveArchiveClient";
import { notifyStaveMutation } from "../../staveMutation";
import { toastManager } from "../ui/toast";

const UNDO_TOAST_TIMEOUT_MS = 10_000;

/**
 * "Space archived" / "Saga archived" with an Undo that restores the archive
 * entries the operation produced. Does nothing for any other result, so
 * callers can pass every finished operation's result.
 */
export function showStaveArchiveUndoToast(
  environmentId: EnvironmentId,
  result: StaveOperationResult | undefined,
): void {
  const undo = result === undefined ? null : staveArchiveUndo(result);
  if (undo === null) return;
  const toastId = toastManager.add({
    type: "success",
    title: undo.title,
    description: undo.description,
    timeout: UNDO_TOAST_TIMEOUT_MS,
    actionProps: {
      children: "Undo",
      onClick: () => {
        toastManager.close(toastId);
        void restoreArchive(environmentId, undo);
      },
    },
  });
}

async function restoreArchive(environmentId: EnvironmentId, undo: StaveArchiveUndo) {
  const noun = undo.title === "Saga archived" ? "saga" : "space";
  const progressId = toastManager.add({
    type: "loading",
    title: `Restoring ${noun}…`,
    timeout: 0,
  });
  const final = await undoStaveArchive(webStaveArchiveClient(environmentId), undo);
  // A failed restore may still have moved some entries back.
  notifyStaveMutation(environmentId);
  toastManager.close(progressId);
  if (final.status === "failed") {
    toastManager.add({
      type: "error",
      title: `Could not restore ${noun}`,
      description: final.message,
    });
  } else {
    toastManager.add({
      type: "success",
      title: noun === "saga" ? "Saga restored" : "Space restored",
    });
  }
}

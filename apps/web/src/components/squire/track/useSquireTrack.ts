import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@lecturn/client-runtime/state/runtime";
import type { EnvironmentId, SquireGrantInput } from "@lecturn/contracts";

import { randomUUID } from "../../../lib/utils";
import { squireEnvironment } from "../../../state/squires";
import { useAtomCommand } from "../../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import type { SquireContainerTrackMenu, SquireThreadTrackMenu } from "./readSquireTrack";
import {
  parseSquireTrackMenuId,
  squireSelectionGrants,
  squireTrackGrant,
  type SquireTrackChoice,
} from "./squireTrack.logic";

/**
 * Runs a Track or Stop tracking choice. Each grant is its own command, so a multi-select
 * track stops at the first refusal and says so.
 */
export function useSquireTrack() {
  const track = useAtomCommand(squireEnvironment.track, { reportFailure: false });
  const untrack = useAtomCommand(squireEnvironment.untrack, { reportFailure: false });

  const run = async (
    environmentId: EnvironmentId,
    choice: SquireTrackChoice,
    grants: ReadonlyArray<SquireGrantInput>,
  ) => {
    const command = choice.action === "track" ? track : untrack;
    for (const grant of grants) {
      const result = await command({
        environmentId,
        input: { requestId: randomUUID(), squireId: choice.squireId, grant },
      });
      if (result._tag === "Success") continue;
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title:
              choice.action === "track" ? "Could not start tracking" : "Could not stop tracking",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
      return false;
    }
    return true;
  };

  /** False when the clicked id is not a Squire item, so the caller handles it. */
  const handleThreadMenu = (menu: SquireThreadTrackMenu | null, id: string) => {
    const choice = parseSquireTrackMenuId(id);
    if (choice === null) return false;
    const tracker = menu?.trackers.find((candidate) => candidate.id === choice.squireId);
    if (menu && tracker) {
      void run(
        menu.environmentId,
        choice,
        squireSelectionGrants(tracker, menu.scopes, choice.action),
      );
    }
    return true;
  };

  const handleContainerMenu = (menu: SquireContainerTrackMenu | null, id: string) => {
    const choice = parseSquireTrackMenuId(id);
    if (choice === null) return false;
    if (menu) void run(menu.environmentId, choice, [squireTrackGrant(menu.target)]);
    return true;
  };

  return { run, handleThreadMenu, handleContainerMenu };
}

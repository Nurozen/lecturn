import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@lecturn/client-runtime/state/shell";
import type { SquireEnvironmentState } from "@lecturn/client-runtime/state/squire";
import type { EnvironmentId } from "@lecturn/contracts";
import { Atom } from "effect/reactivity";

import { uuidv4 } from "../../lib/uuid";
import { squireEnvironment, useSquireSupported } from "../../state/squire";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  squireTrackGrant,
  squireTrackingActions,
  type SquireTrackingAction,
} from "./squireTracking.logic";

const NO_STATE_ATOM = Atom.make<SquireEnvironmentState | null>(null);

/** Lecturn: Track and Stop tracking per Squire for a thread's actions menu. */
export function useSquireThreadTracking(
  environmentId: EnvironmentId | null,
  thread: EnvironmentThreadShell | null,
): {
  readonly actions: ReadonlyArray<SquireTrackingAction>;
  readonly run: (action: SquireTrackingAction) => void;
} {
  const supported = useSquireSupported(environmentId);
  const state = useAtomValue(
    supported && environmentId !== null ? squireEnvironment.state(environmentId) : NO_STATE_ATOM,
  );
  const canTrack = useAtomValue(squireEnvironment.track.permissionAtom(environmentId));
  const canUntrack = useAtomValue(squireEnvironment.untrack.permissionAtom(environmentId));
  const track = useAtomCommand(squireEnvironment.track, "track thread with Squire");
  const untrack = useAtomCommand(squireEnvironment.untrack, "stop tracking thread with Squire");
  if (environmentId === null || thread === null) return { actions: [], run: () => {} };
  const actions = squireTrackingActions(state, thread).filter((action) =>
    action.kind === "track" ? canTrack : canUntrack,
  );
  const run = (action: SquireTrackingAction) => {
    void (action.kind === "track" ? track : untrack)({
      environmentId,
      input: {
        requestId: uuidv4(),
        squireId: action.squireId,
        grant: squireTrackGrant(thread.id),
      },
    });
  };
  return { actions, run };
}

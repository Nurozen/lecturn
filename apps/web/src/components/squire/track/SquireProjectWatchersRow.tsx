import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, StaveProjectInfo } from "@lecturn/contracts";
import { useState } from "react";

import { squireEnvironment, useSquireEnvironmentState } from "../../../state/squires";
import { SettingsRow } from "../../settings/settingsLayout";
import { Button } from "../../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import { squireContainerTarget } from "./readSquireTrack";
import { squireTrackers, squireTrackGrant, squireTracksTarget } from "./squireTrack.logic";
import { useSquireTrack } from "./useSquireTrack";

/**
 * "Squires watching this project" in project settings, the project entry point in flat mode,
 * which has no project rows to open a menu on.
 */
export function SquireProjectWatchersRow(props: {
  readonly environmentId: EnvironmentId;
  readonly project: {
    readonly id: string;
    readonly stave?: Pick<StaveProjectInfo, "spaceId" | "isSaga"> | null | undefined;
  };
}) {
  const { environmentId } = props;
  const state = useSquireEnvironmentState(environmentId);
  const canTrack = useAtomValue(squireEnvironment.track.permissionAtom(environmentId));
  const canUntrack = useAtomValue(squireEnvironment.untrack.permissionAtom(environmentId));
  const { run } = useSquireTrack();
  const [pending, setPending] = useState(false);
  if (state === null) return null;
  const trackers = squireTrackers(state.squires);
  if (trackers.length === 0) return null;
  const target = squireContainerTarget(props.project);
  const rows = trackers.map((tracker) => ({
    tracker,
    tracked: squireTracksTarget(tracker.grants, target),
  }));
  const watching = rows.filter((row) => row.tracked).map((row) => row.tracker.name);
  const offered = rows.filter((row) => (row.tracked ? canUntrack : canTrack));
  const noun =
    target.kind === "project" ? "project" : target.kind === "staveSaga" ? "saga" : "space";

  const choose = async (row: (typeof rows)[number]) => {
    setPending(true);
    await run(
      environmentId,
      { action: row.tracked ? "untrack" : "track", squireId: row.tracker.id },
      [squireTrackGrant(target)],
    );
    setPending(false);
  };

  return (
    <SettingsRow
      title="Squires watching this project"
      description={watching.length > 0 ? watching.join(", ") : `No Squire watches this ${noun}.`}
      control={
        offered.length > 0 ? (
          <Menu>
            <MenuTrigger
              render={
                <Button size="sm" variant="outline" disabled={pending}>
                  Change
                </Button>
              }
            />
            <MenuPopup align="end">
              {offered.map((row) => (
                <MenuItem key={row.tracker.id} onClick={() => void choose(row)}>
                  {row.tracked
                    ? `Stop tracking (${row.tracker.name})`
                    : `Track with ${row.tracker.name}`}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        ) : null
      }
    />
  );
}

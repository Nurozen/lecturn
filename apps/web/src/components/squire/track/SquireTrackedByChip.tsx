import { scopeProjectRef, scopeThreadRef } from "@lecturn/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@lecturn/contracts";
import { useNavigate } from "@tanstack/react-router";
import { memo } from "react";

import { useProject, useQuietThreadShell } from "../../../state/entities";
import { useSquireEnvironmentState } from "../../../state/squires";
import { ThreadDetailsControl } from "../../chat/ThreadDetailsControl";
import { ThreadDetailsSection } from "../../chat/ThreadDetailsSection";
import { SquireMark } from "../SquireMark";
import { squireThreadScope, squireTrackers, squireTracksTarget } from "./squireTrack.logic";

/**
 * "Tracked by Release" in the thread's details, the place to see tracking (D39). Each row
 * opens that Squire's view. Squire threads and untracked threads show nothing.
 */
export const SquireTrackedByChip = memo(function SquireTrackedByChip(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { environmentId } = props;
  const navigate = useNavigate();
  const thread = useQuietThreadShell(scopeThreadRef(environmentId, props.threadId));
  const project = useProject(thread ? scopeProjectRef(environmentId, thread.projectId) : null);
  const state = useSquireEnvironmentState(environmentId);
  if (thread === null || thread.squire != null || state === null) return null;
  const target = { kind: "thread" as const, ...squireThreadScope(thread, project) };
  const trackerIds = new Set(
    squireTrackers(state.squires)
      .filter((tracker) => squireTracksTarget(tracker.grants, target))
      .map((tracker) => tracker.id),
  );
  const tracking = state.squires.filter((entry) => trackerIds.has(entry.squire.id));
  if (tracking.length === 0) return null;
  return (
    <ThreadDetailsSection
      headingId="thread-details-squires-heading"
      title="Squires"
      showHeading={false}
    >
      {tracking.map(({ squire }) => (
        <ThreadDetailsControl
          key={squire.id}
          size="sm"
          variant="ghost"
          part="row"
          onClick={() =>
            void navigate({
              to: "/squires/$environmentId/$squireId",
              params: { environmentId, squireId: squire.id },
              search: {},
            })
          }
        >
          <SquireMark
            state="waiting"
            palette={squire.companion.palette}
            size={16}
            label={squire.name}
          />
          <span className="min-w-0 flex-1 truncate">Tracked by {squire.name}</span>
        </ThreadDetailsControl>
      ))}
    </ThreadDetailsSection>
  );
});

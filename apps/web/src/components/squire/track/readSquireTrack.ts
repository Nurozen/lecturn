import { scopeProjectRef } from "@lecturn/client-runtime/environment";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type ProjectId,
  type StaveProjectInfo,
  type ThreadId,
} from "@lecturn/contracts";

import { appAtomRegistry } from "../../../rpc/atomRegistry";
import { readProject } from "../../../state/entities";
import { readEnvironmentScope } from "../../../state/session";
import { squireCapableAtom, squireEnvironment } from "../../../state/squires";
import {
  squireSelectionMenuState,
  squireThreadScope,
  squireTrackers,
  squireTrackMenuState,
  type SquireContainerKind,
  type SquireThreadScope,
  type SquireTracker,
  type SquireTrackMenuState,
  type SquireTrackTarget,
} from "./squireTrack.logic";

export interface SquireTrackSource {
  readonly trackers: ReadonlyArray<SquireTracker>;
  readonly canTrack: boolean;
  readonly canUntrack: boolean;
}

/**
 * Read at menu-open time, so the sidebar never re-renders on Squire snapshots. The Squires
 * group keeps the state subscribed for every readable, Squire-capable environment; the
 * checks come first so a menu never opens a subscription of its own.
 */
function readSquireTrackSource(environmentId: EnvironmentId): SquireTrackSource | null {
  if (!appAtomRegistry.get(squireCapableAtom(environmentId))) return null;
  if (!readEnvironmentScope(environmentId, AuthOrchestrationReadScope)) return null;
  const canTrack = appAtomRegistry.get(squireEnvironment.track.permissionAtom(environmentId));
  const canUntrack = appAtomRegistry.get(squireEnvironment.untrack.permissionAtom(environmentId));
  if (!canTrack && !canUntrack) return null;
  const state = appAtomRegistry.get(squireEnvironment.state(environmentId));
  if (state === null) return null;
  const trackers = squireTrackers(state.squires);
  return trackers.length === 0 ? null : { trackers, canTrack, canUntrack };
}

interface TrackableThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly squire?: unknown;
}

export interface SquireThreadTrackMenu {
  readonly environmentId: EnvironmentId;
  readonly trackers: ReadonlyArray<SquireTracker>;
  readonly scopes: ReadonlyArray<SquireThreadScope>;
  readonly state: SquireTrackMenuState;
}

function readThreadScope(thread: TrackableThread): SquireThreadScope {
  return squireThreadScope(
    thread,
    readProject(scopeProjectRef(thread.environmentId, thread.projectId)),
  );
}

/** One thread's menu; Squire threads are left to the caller (they are never trackable). */
export function readSquireThreadTrackMenu(thread: TrackableThread): SquireThreadTrackMenu | null {
  const source = readSquireTrackSource(thread.environmentId);
  if (source === null) return null;
  const scope = readThreadScope(thread);
  return {
    environmentId: thread.environmentId,
    trackers: source.trackers,
    scopes: [scope],
    state: squireTrackMenuState(source.trackers, { kind: "thread", ...scope }, source),
  };
}

/**
 * Multi-select: Squire threads drop out, and a selection across environments offers
 * nothing, since each environment has its own Squires.
 */
export function readSquireSelectionTrackMenu(
  threads: ReadonlyArray<TrackableThread>,
): SquireThreadTrackMenu | null {
  const trackable = threads.filter((thread) => thread.squire == null);
  const environmentId = trackable[0]?.environmentId;
  if (environmentId === undefined) return null;
  if (trackable.some((thread) => thread.environmentId !== environmentId)) return null;
  const source = readSquireTrackSource(environmentId);
  if (source === null) return null;
  const scopes = trackable.map(readThreadScope);
  return {
    environmentId,
    trackers: source.trackers,
    scopes,
    state: squireSelectionMenuState(source.trackers, scopes, source),
  };
}

export interface SquireContainerTrackMenu {
  readonly environmentId: EnvironmentId;
  readonly target: Extract<SquireTrackTarget, { kind: SquireContainerKind }>;
  readonly state: SquireTrackMenuState;
}

/** A Stave space is tracked as a space and a saga's coordinating space as its saga. */
export function squireContainerTarget(project: {
  readonly id: string;
  readonly stave?: Pick<StaveProjectInfo, "spaceId" | "isSaga"> | null | undefined;
}): SquireContainerTrackMenu["target"] {
  if (!project.stave) return { kind: "project", targetId: project.id };
  return {
    kind: project.stave.isSaga ? "staveSaga" : "staveSpace",
    targetId: project.stave.spaceId,
  };
}

export function readSquireContainerTrackMenu(
  environmentId: EnvironmentId,
  target: SquireContainerTrackMenu["target"],
): SquireContainerTrackMenu | null {
  const source = readSquireTrackSource(environmentId);
  if (source === null) return null;
  return { environmentId, target, state: squireTrackMenuState(source.trackers, target, source) };
}

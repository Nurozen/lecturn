import type {
  ContextMenuItem,
  Squire,
  SquireGrantInput,
  SquireGrantKind,
  SquireId,
  StaveProjectInfo,
} from "@lecturn/contracts";

type Grant = Pick<SquireGrantInput, "kind" | "targetId">;

export type SquireContainerKind = Exclude<SquireGrantKind, "thread" | "exclusion">;

/** Where a thread sits, for the grants that can cover it. */
export interface SquireThreadScope {
  readonly threadId: string;
  readonly projectId: string;
  readonly staveSpaceId: string | null;
  readonly staveSagaId: string | null;
}

export type SquireTrackTarget =
  | ({ readonly kind: "thread" } & SquireThreadScope)
  | { readonly kind: SquireContainerKind; readonly targetId: string };

export interface SquireTracker {
  readonly id: SquireId;
  readonly name: string;
  readonly grants: ReadonlyArray<Grant>;
}

/** Mirrors the server's membership: a saga's own coordinating space is inside its saga. */
export function squireStaveScope(
  stave: Pick<StaveProjectInfo, "spaceId" | "isSaga" | "memberOf"> | null | undefined,
): Pick<SquireThreadScope, "staveSpaceId" | "staveSagaId"> {
  if (!stave) return { staveSpaceId: null, staveSagaId: null };
  return {
    staveSpaceId: stave.spaceId,
    staveSagaId: stave.isSaga ? stave.spaceId : (stave.memberOf ?? null),
  };
}

export function squireThreadScope(
  thread: { readonly id: string; readonly projectId: string },
  project: { readonly stave?: StaveProjectInfo | null | undefined } | null,
): SquireThreadScope {
  return { threadId: thread.id, projectId: thread.projectId, ...squireStaveScope(project?.stave) };
}

/**
 * The Squires a client may offer tracking with: never the Lead (it has no scope), and only
 * Squires that are set up, paused ones included.
 */
export function squireTrackers(
  squires: ReadonlyArray<{
    readonly squire: Pick<Squire, "id" | "name" | "role" | "status" | "lifecycle" | "grants">;
  }>,
): SquireTracker[] {
  return squires.flatMap(({ squire }) =>
    squire.role === "squire" &&
    squire.lifecycle === "ready" &&
    (squire.status === "active" || squire.status === "paused")
      ? [{ id: squire.id, name: squire.name, grants: squire.grants }]
      : [],
  );
}

/** A thread grant or a granted container covers a thread; an exclusion beats both. */
export function squireCoversThread(
  grants: ReadonlyArray<Grant>,
  scope: SquireThreadScope,
): boolean {
  if (grants.some((grant) => grant.kind === "exclusion" && grant.targetId === scope.threadId)) {
    return false;
  }
  return grants.some((grant) => {
    switch (grant.kind) {
      case "thread":
        return grant.targetId === scope.threadId;
      case "project":
        return grant.targetId === scope.projectId;
      case "staveSpace":
        return scope.staveSpaceId !== null && grant.targetId === scope.staveSpaceId;
      case "staveSaga":
        return scope.staveSagaId !== null && grant.targetId === scope.staveSagaId;
      case "exclusion":
        return false;
    }
  });
}

/** A container is tracked only by its own grant; a project inside a granted space is not. */
export function squireTracksTarget(
  grants: ReadonlyArray<Grant>,
  target: SquireTrackTarget,
): boolean {
  if (target.kind === "thread") return squireCoversThread(grants, target);
  return grants.some((grant) => grant.kind === target.kind && grant.targetId === target.targetId);
}

export function squireTrackGrant(target: SquireTrackTarget): SquireGrantInput {
  return target.kind === "thread"
    ? { kind: "thread", targetId: target.threadId }
    : { kind: target.kind, targetId: target.targetId };
}

// ── Menus ─────────────────────────────────────────────────────

export type SquireTrackMenuId =
  | "squire-track"
  | `squire-track:${string}`
  | "squire-untrack"
  | `squire-untrack:${string}`;

export interface SquireTrackMenuState {
  readonly squires: ReadonlyArray<{
    readonly id: SquireId;
    readonly name: string;
    readonly tracked: boolean;
  }>;
  readonly canTrack: boolean;
  readonly canUntrack: boolean;
  /** Multi-select appends the selection size, like the other bulk items. */
  readonly count?: number | undefined;
}

export function squireTrackMenuState(
  trackers: ReadonlyArray<SquireTracker>,
  target: SquireTrackTarget,
  access: { readonly canTrack: boolean; readonly canUntrack: boolean },
): SquireTrackMenuState {
  return {
    ...access,
    squires: trackers.map((tracker) => ({
      id: tracker.id,
      name: tracker.name,
      tracked: squireTracksTarget(tracker.grants, target),
    })),
  };
}

/**
 * "Track with Release", or "Track with ▸ Release / Research" when several Squires could;
 * "Stop tracking (Release)", or "Stop tracking ▸ …" when several track it.
 */
export function buildSquireTrackMenuItems(
  state: SquireTrackMenuState,
  options: { readonly separatorBefore?: boolean } = {},
): ContextMenuItem<SquireTrackMenuId>[] {
  const suffix = state.count === undefined ? "" : ` (${state.count})`;
  const toTrack = state.canTrack ? state.squires.filter((squire) => !squire.tracked) : [];
  const toUntrack = state.canUntrack ? state.squires.filter((squire) => squire.tracked) : [];
  const items: ContextMenuItem<SquireTrackMenuId>[] = [];
  if (toTrack.length === 1) {
    const [squire] = toTrack;
    items.push({
      id: `squire-track:${squire!.id}`,
      label: `Track with ${squire!.name}${suffix}`,
      icon: "eye",
    });
  } else if (toTrack.length > 1) {
    items.push({
      id: "squire-track",
      label: `Track with${suffix}`,
      icon: "eye",
      children: toTrack.map((squire) => ({
        id: `squire-track:${squire.id}` as const,
        label: squire.name,
      })),
    });
  }
  if (toUntrack.length === 1) {
    const [squire] = toUntrack;
    items.push({
      id: `squire-untrack:${squire!.id}`,
      label: `Stop tracking (${squire!.name})${suffix}`,
      icon: "eye-off",
    });
  } else if (toUntrack.length > 1) {
    items.push({
      id: "squire-untrack",
      label: `Stop tracking${suffix}`,
      icon: "eye-off",
      children: toUntrack.map((squire) => ({
        id: `squire-untrack:${squire.id}` as const,
        label: squire.name,
      })),
    });
  }
  if (options.separatorBefore && items[0]) items[0] = { ...items[0], separatorBefore: true };
  return items;
}

export interface SquireTrackChoice {
  readonly action: "track" | "untrack";
  readonly squireId: SquireId;
}

export function parseSquireTrackMenuId(id: string): SquireTrackChoice | null {
  const match = /^squire-(track|untrack):(.+)$/.exec(id);
  if (!match) return null;
  return { action: match[1] as SquireTrackChoice["action"], squireId: match[2] as SquireId };
}

// ── Multi-select ──────────────────────────────────────────────

/** A Squire untracks the selection only when it already tracks every selected thread. */
export function squireSelectionMenuState(
  trackers: ReadonlyArray<SquireTracker>,
  scopes: ReadonlyArray<SquireThreadScope>,
  access: { readonly canTrack: boolean; readonly canUntrack: boolean },
): SquireTrackMenuState {
  return {
    ...access,
    count: scopes.length,
    squires: trackers.map((tracker) => ({
      id: tracker.id,
      name: tracker.name,
      tracked:
        scopes.length > 0 && scopes.every((scope) => squireCoversThread(tracker.grants, scope)),
    })),
  };
}

/**
 * Track adds a thread grant to each selected thread not yet covered; untrack sends each
 * thread's grant, and the server turns a container-covered one into an exclusion.
 */
export function squireSelectionGrants(
  tracker: SquireTracker,
  scopes: ReadonlyArray<SquireThreadScope>,
  action: SquireTrackChoice["action"],
): SquireGrantInput[] {
  return scopes
    .filter((scope) => (action === "track" ? !squireCoversThread(tracker.grants, scope) : true))
    .map((scope) => ({ kind: "thread", targetId: scope.threadId }));
}

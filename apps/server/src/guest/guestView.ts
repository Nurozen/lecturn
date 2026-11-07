import type {
  GuestShareView,
  GuestThreadModel,
  OrchestrationV2AppThread,
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadProjection,
  ServerProvider,
} from "@lecturn/contracts";

/**
 * Lecturn: the thread fields a guest receives, the ones upstream's thread record has. Everything
 * the fork adds stays with the owner: palette queries (`opens`), Lecturn Apps metadata, the
 * Squire marker, an import's cwd and session ids, and the fork point. A new thread field is
 * withheld until it is listed here.
 */
export const GUEST_THREAD_FIELDS = [
  "createdBy",
  "creationSource",
  "id",
  "projectId",
  "title",
  "providerInstanceId",
  "modelSelection",
  "runtimeMode",
  "interactionMode",
  "branch",
  "worktreePath",
  "linkedPullRequest",
  "pullRequests",
  "branchPullRequest",
  "activeProviderThreadId",
  "historyOrigin",
  "lineage",
  "forkedFrom",
  "createdAt",
  "updatedAt",
  "archivedAt",
  "settledOverride",
  "settledAt",
  "unsettledAt",
  "snoozedUntil",
  "snoozedAt",
  "lastSnoozeWakeAt",
  "limitRecovery",
  "guestShare",
  "pinnedAt",
  "autoSettleDisabledAt",
  "pinOrderKey",
  "activeOrderKey",
  "lastVisitedAt",
  "titleRegeneration",
  "rollbackRequestId",
  "rollbackFailure",
  "deletedAt",
] as const satisfies ReadonlyArray<keyof OrchestrationV2AppThread>;

/** The thread record as a guest receives it: only `GUEST_THREAD_FIELDS`. */
export function guestThread(thread: OrchestrationV2AppThread): OrchestrationV2AppThread {
  const allowed: Partial<Record<keyof OrchestrationV2AppThread, unknown>> = {};
  for (const field of GUEST_THREAD_FIELDS) {
    if (Object.hasOwn(thread, field)) allowed[field] = thread[field];
  }
  return allowed as OrchestrationV2AppThread;
}

export function guestThreadProjection<Projection extends OrchestrationV2ThreadProjection>(
  projection: Projection,
): Projection {
  return { ...projection, thread: guestThread(projection.thread) };
}

type ThreadRecordEvent = Extract<
  OrchestrationV2DomainEvent,
  { readonly payload: OrchestrationV2AppThread }
>;

// Every event whose payload is the whole thread record; typecheck fails until a new one is listed.
const THREAD_RECORD_EVENTS: Record<ThreadRecordEvent["type"], true> = {
  "thread.created": true,
  "thread.archived": true,
  "thread.unarchived": true,
  "thread.deleted": true,
  "thread.settled": true,
  "thread.unsettled": true,
  "thread.snoozed": true,
  "thread.unsnoozed": true,
  "thread.pinned": true,
  "thread.auto-settle-set": true,
  "thread.unpinned": true,
  "thread.pin-reordered": true,
  "thread.active-reordered": true,
  "thread.visited": true,
  "thread.marked-unread": true,
  "thread.metadata-updated": true,
  "thread.pull-request-synced": true,
  "thread.runtime-mode-updated": true,
  "thread.interaction-mode-updated": true,
  "thread.model-selection-updated": true,
  "thread.provider-switched": true,
  "thread.imported": true,
  "thread.guest-share-updated": true,
};

const isThreadRecordEvent = (event: OrchestrationV2DomainEvent): event is ThreadRecordEvent =>
  Object.hasOwn(THREAD_RECORD_EVENTS, event.type);

/** A wire event as a guest receives it: a thread record payload goes through `guestThread`. */
export function guestDomainEvent(event: OrchestrationV2DomainEvent): OrchestrationV2DomainEvent {
  return isThreadRecordEvent(event) ? { ...event, payload: guestThread(event.payload) } : event;
}

/** The thread's model as the owner's composer labels it, from the configured providers. */
export function guestThreadModel(
  selection: OrchestrationV2AppThread["modelSelection"],
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver" | "models">>,
): GuestThreadModel {
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  const model = provider?.models.find((candidate) => candidate.slug === selection.model);
  return {
    driver: provider?.driver ?? null,
    name: model?.name ?? selection.model,
    ...(model?.shortName === undefined ? {} : { shortName: model.shortName }),
    ...(model?.subProvider === undefined ? {} : { subProvider: model.subProvider }),
  };
}

/** The share as its guest sees it, or null before the guest has joined. */
export function guestShareView(
  thread: OrchestrationV2AppThread,
  model: GuestThreadModel,
): GuestShareView | null {
  const share = thread.guestShare;
  if (!share || share.guestName === null) return null;
  return {
    shareId: share.id,
    title: thread.title,
    guestName: share.guestName,
    expiresAt: share.expiresAt,
    messages: share.messages,
    model,
  };
}

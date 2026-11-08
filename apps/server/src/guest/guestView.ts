import type {
  GuestShareView,
  GuestThreadModel,
  OrchestrationV2AppThread,
  OrchestrationV2DomainEvent,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
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

/**
 * Lecturn: the turn item types a guest receives; typecheck fails until a new one is decided.
 * A link request names the owner's other machines and their addresses, so it stays with the
 * owner, as `linkOrigin` and `delegatedFrom` do. A type missing here is withheld.
 */
const GUEST_TURN_ITEM_TYPES: Record<OrchestrationV2TurnItem["type"], boolean> = {
  notification: true,
  user_message: true,
  assistant_message: true,
  reasoning: true,
  proposed_plan: true,
  todo_list: true,
  user_input_request: true,
  file_change: true,
  command_execution: true,
  file_search: true,
  web_search: true,
  approval_request: true,
  checkpoint: true,
  run_interrupt_request: true,
  run_interrupt_result: true,
  system_notice: true,
  error: true,
  compaction: true,
  handoff: true,
  fork: true,
  thread_created: true,
  secret_request: true,
  link_request: false,
  subagent: true,
  dynamic_tool: true,
};

/** Drops `remoteChild`: where a task runs on a linked machine names that machine. */
function withoutRemoteChild<Value extends { readonly remoteChild?: unknown }>(
  record: Value,
): Value {
  if (!Object.hasOwn(record, "remoteChild")) return record;
  const { remoteChild: _remoteChild, ...rest } = record;
  return rest as Value;
}

/** A turn item as a guest receives it, or null when it is withheld. */
export function guestTurnItem<
  Item extends { readonly type: string; readonly remoteChild?: unknown },
>(item: Item): Item | null {
  if (!Object.hasOwn(GUEST_TURN_ITEM_TYPES, item.type)) return null;
  if (!GUEST_TURN_ITEM_TYPES[item.type as OrchestrationV2TurnItem["type"]]) return null;
  return item.type === "subagent" ? withoutRemoteChild(item) : item;
}

/** A subagent record as a guest receives it. */
export function guestSubagent(subagent: OrchestrationV2Subagent): OrchestrationV2Subagent {
  return withoutRemoteChild(subagent);
}

export function guestThreadProjection<Projection extends OrchestrationV2ThreadProjection>(
  projection: Projection,
): Projection {
  // One result per item, so a visible row and its turn item stay the same object.
  const shared = new Map<OrchestrationV2TurnItem, OrchestrationV2TurnItem | null>();
  const share = (item: OrchestrationV2TurnItem) => {
    if (!shared.has(item)) shared.set(item, guestTurnItem(item));
    return shared.get(item) ?? null;
  };
  return {
    ...projection,
    thread: guestThread(projection.thread),
    subagents: projection.subagents.map(guestSubagent),
    turnItems: projection.turnItems.flatMap((item) => share(item) ?? []),
    visibleTurnItems: projection.visibleTurnItems.flatMap((row) => {
      const item = share(row.item);
      return item === null ? [] : [item === row.item ? row : { ...row, item }];
    }),
  };
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

/**
 * A wire event as a guest receives it, or null when it is withheld: a thread record goes through
 * `guestThread`, a turn item through `guestTurnItem`, a subagent through `guestSubagent`.
 */
export function guestDomainEvent(
  event: OrchestrationV2DomainEvent,
): OrchestrationV2DomainEvent | null {
  if (isThreadRecordEvent(event)) return { ...event, payload: guestThread(event.payload) };
  if (event.type === "turn-item.updated") {
    const item = guestTurnItem(event.payload);
    return item === null ? null : item === event.payload ? event : { ...event, payload: item };
  }
  if (event.type === "subagent.updated") {
    const subagent = guestSubagent(event.payload);
    return subagent === event.payload ? event : { ...event, payload: subagent };
  }
  return event;
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

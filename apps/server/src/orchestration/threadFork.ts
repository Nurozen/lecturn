import type {
  ChatAttachment,
  CheckpointRef,
  DispatchableClientOrchestrationCommand,
  ForkedTurnRow,
  IsoDateTime,
  OrchestrationCheckpointSummary,
  OrchestrationThread,
  OrchestrationThreadActivity,
  ProviderInstanceId,
  ThreadForkProviderSource,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { EventId, MessageId } from "@t3tools/contracts";
import { UUID_NAMESPACE_DNS, uuidV5 } from "@t3tools/shared/uuid";

import { deriveCopiedAttachmentId } from "../attachmentStore.ts";
import { CHECKPOINT_REFS_PREFIX, checkpointRefForThreadTurn } from "../checkpointing/Utils.ts";
import type { ProjectionTurn } from "../persistence/Services/ProjectionTurns.ts";
import type { ProviderRuntimeBinding } from "../provider/Services/ProviderSessionDirectory.ts";

/**
 * Server-materialized thread.fork command minus the commandId the dispatcher
 * mints when it wraps this assembly into a dispatch.
 */
export type MaterializedThreadForkCommand = Omit<
  Extract<DispatchableClientOrchestrationCommand, { type: "thread.fork" }>,
  "commandId"
>;

/** Why a fork request cannot be assembled from the source thread's state. */
export type ThreadForkAssemblyFailure =
  | { readonly kind: "source-deleted"; readonly threadId: ThreadId }
  | { readonly kind: "turn-not-found"; readonly turnId: TurnId }
  | {
      readonly kind: "turn-not-completed";
      readonly turnId: TurnId;
      readonly state: ProjectionTurn["state"];
    }
  | { readonly kind: "anchor-unavailable"; readonly turnId: TurnId }
  | { readonly kind: "attachment-id-underivable"; readonly attachmentId: string }
  | { readonly kind: "duplicate-alias-target"; readonly checkpointRef: CheckpointRef };

/**
 * One checkpoint ref the dispatcher must alias in the shared ref store before
 * dispatching the assembled command: `from` is the source thread's ref, `to`
 * the child's canonical `turn/<n>` name already embedded in the history.
 */
export interface ThreadForkAliasRef {
  readonly from: CheckpointRef;
  readonly to: CheckpointRef;
}

/**
 * One attachment file the dispatcher must copy under the child's namespace.
 * `finalId` is the child-side id the copied message rows already carry;
 * `uuid` feeds copyClaimedAttachment so the file lands at the same id.
 */
export interface ThreadForkAttachmentCopy {
  readonly attachment: ChatAttachment;
  readonly uuid: string;
  readonly finalId: string;
}

/**
 * The provider session a fork actually runs on: the source's live binding
 * when it carries an instance and cursor, else the nearest-ancestor snapshot
 * the source itself inherited (an unsent fork forwards its own forkSource).
 * Null when nothing in the lineage ever bound a provider session. The ws
 * dispatcher gates fork capability on this instance, and the assembler
 * snapshots it into the child's forkSource, so both stay in lockstep.
 */
export function resolveForkSessionSource(input: {
  readonly sourceBinding: ProviderRuntimeBinding | null;
  readonly sourceForkSource: ThreadForkProviderSource | null;
}): {
  readonly providerInstanceId: ProviderInstanceId;
  readonly resumeCursor: unknown;
} | null {
  const binding = input.sourceBinding;
  if (
    binding !== null &&
    binding.providerInstanceId !== undefined &&
    binding.resumeCursor !== null &&
    binding.resumeCursor !== undefined
  ) {
    return { providerInstanceId: binding.providerInstanceId, resumeCursor: binding.resumeCursor };
  }
  if (input.sourceForkSource !== null) {
    return {
      providerInstanceId: input.sourceForkSource.providerInstanceId,
      resumeCursor: input.sourceForkSource.resumeCursor,
    };
  }
  return null;
}

export interface AssembleThreadForkInput {
  /**
   * Source thread detail: messages, proposed plans and creation metadata.
   * Its activity window is capped, so activities ride in separately.
   */
  readonly source: OrchestrationThread;
  /**
   * Source turn rows in chronological order, pending placeholders (null
   * turn id) excluded — the ProjectionSnapshotQuery.listThreadTurnsById
   * shape.
   */
  readonly sourceTurns: ReadonlyArray<ProjectionTurn>;
  /** Every source activity, unbounded. */
  readonly sourceActivities: ReadonlyArray<OrchestrationThreadActivity>;
  /**
   * The source's own persisted provider snapshot. An unsent fork has no
   * binding of its own; its child inherits this snapshot instead.
   */
  readonly sourceForkSource: ThreadForkProviderSource | null;
  /** Live provider binding of the source thread, when one exists. */
  readonly sourceBinding: ProviderRuntimeBinding | null;
  readonly childThreadId: ThreadId;
  /** Fork point: the child inherits history through this turn, inclusive. */
  readonly throughTurnId: TurnId;
  /** UI anchor the user clicked; null for fork-at-end entry points. */
  readonly sourceMessageId: MessageId | null;
  /** Child title; null falls back to "<source title> (fork)". */
  readonly title: string | null;
  /** Child creation time (server-canonicalized). */
  readonly createdAt: IsoDateTime;
  /**
   * The provider needs a native anchor to fork mid-thread (Claude sessions
   * recorded before anchors were captured): reject when the fork turn has no
   * anchor and completed turns follow it.
   */
  readonly requiresAnchor: boolean;
  /** Fresh-id source for minted message/activity/plan ids; injectable for tests. */
  readonly mintUuid: () => string;
}

export type AssembleThreadForkResult =
  | {
      readonly ok: true;
      readonly command: MaterializedThreadForkCommand;
      readonly aliasRefs: ReadonlyArray<ThreadForkAliasRef>;
      readonly attachmentCopies: ReadonlyArray<ThreadForkAttachmentCopy>;
    }
  | { readonly ok: false; readonly failure: ThreadForkAssemblyFailure };

/**
 * A kept source turn row: identified by a turn id, which per the input
 * contract also rules out the pending state (pending placeholders carry null
 * turn ids and are excluded upstream).
 */
type IdentifiedTurnRow = ProjectionTurn & {
  readonly turnId: TurnId;
  readonly state: ForkedTurnRow["state"];
};

/**
 * Pure fork assembler: slices the source history through the fork turn, mints
 * child-side ids for every copied row, re-namespaces canonical checkpoint
 * refs, plans deterministic attachment copies and snapshots the provider
 * session, producing the server-materialized thread.fork command plus the
 * side-effect plans (ref aliases, file copies) the dispatcher runs before
 * dispatch. No IO: every read the assembly needs is an input.
 */
export function assembleThreadFork(input: AssembleThreadForkInput): AssembleThreadForkResult {
  const { source } = input;

  if (source.deletedAt !== null) {
    return { ok: false, failure: { kind: "source-deleted", threadId: source.id } };
  }

  const forkTurn = input.sourceTurns.find((row) => row.turnId === input.throughTurnId);
  if (forkTurn === undefined) {
    return { ok: false, failure: { kind: "turn-not-found", turnId: input.throughTurnId } };
  }
  if (forkTurn.state !== "completed") {
    return {
      ok: false,
      failure: {
        kind: "turn-not-completed",
        turnId: input.throughTurnId,
        state: forkTurn.state,
      },
    };
  }

  const forkIndex = input.sourceTurns.indexOf(forkTurn);
  const keptRows = input.sourceTurns
    .slice(0, forkIndex + 1)
    .filter((row): row is IdentifiedTurnRow => row.turnId !== null);
  const keptTurnIds = new Set<TurnId>(keptRows.map((row) => row.turnId));

  // Mirrors the provider-side assistant message list: interrupted and errored
  // turns can still emit an assistant message, so every kept turn that
  // produced one advances the positional fork boundary.
  const throughTurnOrdinal = keptRows.filter((row) => row.assistantMessageId !== null).length;
  // "At end" means the fork turn is literally the source's last turn row: a
  // later running, interrupted or errored turn may already have content in
  // the provider's native session even though it never completed, so a
  // whole-session fork there would give the agent history the child does not
  // show.
  const atEnd = forkIndex === input.sourceTurns.length - 1;
  const anchor = forkTurn.providerTurnRef ?? null;

  if (input.requiresAnchor && anchor === null && !atEnd) {
    return { ok: false, failure: { kind: "anchor-unavailable", turnId: input.throughTurnId } };
  }

  // Null-turn rows have no turn to slice on, so the fork turn's completion
  // time bounds them: a user message queued after the fork point stays with
  // the source, while genuinely pre-first-turn rows (which predate every
  // turn) ride along.
  // Compared as epoch milliseconds, not strings: canonical timestamps are
  // UTC ISO strings, but a numeric compare stays correct even if an offset
  // form ever reaches a persisted row.
  const forkCompletedAtMs = forkTurn.completedAt === null ? null : Date.parse(forkTurn.completedAt);
  const keepsRow = (turnId: TurnId | null, createdAt: IsoDateTime) =>
    turnId === null
      ? forkCompletedAtMs === null || Date.parse(createdAt) <= forkCompletedAtMs
      : keptTurnIds.has(turnId);

  const attachmentCopies: Array<ThreadForkAttachmentCopy> = [];
  const copiedAttachmentIds = new Map<string, string>();
  let underivableAttachmentId: string | null = null;
  const copyAttachment = (attachment: ChatAttachment): ChatAttachment => {
    const existingId = copiedAttachmentIds.get(attachment.id);
    if (existingId !== undefined) {
      return { ...attachment, id: existingId };
    }
    const uuid = uuidV5(UUID_NAMESPACE_DNS, `${attachment.id}:${input.childThreadId}`);
    const finalId = deriveCopiedAttachmentId({
      sourceAttachmentId: attachment.id,
      childThreadId: input.childThreadId,
      uuid,
    });
    if (finalId === null) {
      // Recorded as an assembly failure below: falling through would leave
      // the child's message rows pointing at the parent's attachment file.
      underivableAttachmentId ??= attachment.id;
      return attachment;
    }
    copiedAttachmentIds.set(attachment.id, finalId);
    attachmentCopies.push({ attachment, uuid, finalId });
    return { ...attachment, id: finalId };
  };

  const messageIdMap = new Map<MessageId, MessageId>();
  const messages = source.messages
    .filter((message) => keepsRow(message.turnId, message.createdAt))
    .map((message) => {
      const id =
        message.role === "assistant"
          ? MessageId.make(`assistant:${input.mintUuid()}`)
          : MessageId.make(input.mintUuid());
      messageIdMap.set(message.id, id);
      const copied = { ...message, id };
      return message.attachments === undefined
        ? copied
        : { ...copied, attachments: message.attachments.map(copyAttachment) };
    });
  if (underivableAttachmentId !== null) {
    return {
      ok: false,
      failure: { kind: "attachment-id-underivable", attachmentId: underivableAttachmentId },
    };
  }

  const activities = input.sourceActivities
    .filter((activity) => keepsRow(activity.turnId, activity.createdAt))
    .map((activity) => ({ ...activity, id: EventId.make(input.mintUuid()) }));

  const planIdMap = new Map<string, string>();
  const proposedPlans = source.proposedPlans
    .filter((plan) => keepsRow(plan.turnId, plan.createdAt))
    .map((plan) => {
      const id = input.mintUuid();
      planIdMap.set(plan.id, id);
      return { ...plan, id };
    });

  const mapMessageId = (id: MessageId | null) =>
    id === null ? null : (messageIdMap.get(id) ?? null);

  const turns = keptRows.map((row): ForkedTurnRow => {
    const pendingMessageId = mapMessageId(row.pendingMessageId);
    const assistantMessageId = mapMessageId(row.assistantMessageId);

    const sourcePlan =
      row.sourceProposedPlanThreadId !== null && row.sourceProposedPlanId !== null
        ? { threadId: row.sourceProposedPlanThreadId, planId: row.sourceProposedPlanId }
        : undefined;
    const mintedPlanId = sourcePlan === undefined ? undefined : planIdMap.get(sourcePlan.planId);
    const sourceProposedPlan =
      sourcePlan === undefined
        ? undefined
        : sourcePlan.threadId === source.id && mintedPlanId !== undefined
          ? { threadId: input.childThreadId, planId: mintedPlanId }
          : sourcePlan;

    const checkpoint: OrchestrationCheckpointSummary | undefined =
      row.checkpointRef !== null &&
      row.checkpointTurnCount !== null &&
      row.checkpointStatus !== null &&
      row.completedAt !== null
        ? {
            turnId: row.turnId,
            checkpointTurnCount: row.checkpointTurnCount,
            checkpointRef: row.checkpointRef.startsWith(CHECKPOINT_REFS_PREFIX)
              ? checkpointRefForThreadTurn(input.childThreadId, row.checkpointTurnCount)
              : row.checkpointRef,
            status: row.checkpointStatus,
            files: [...row.checkpointFiles],
            assistantMessageId,
            completedAt: row.completedAt,
          }
        : undefined;

    return {
      turnId: row.turnId,
      state: row.state,
      requestedAt: row.requestedAt,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      pendingMessageId,
      assistantMessageId,
      ...(sourceProposedPlan === undefined ? {} : { sourceProposedPlan }),
      ...(checkpoint === undefined ? {} : { checkpoint }),
      providerTurnRef: row.providerTurnRef ?? null,
    };
  });

  const aliasRefs: Array<ThreadForkAliasRef> = [];
  const aliasedFroms = new Set<CheckpointRef>();
  const aliasedTos = new Set<CheckpointRef>();
  // Two distinct source refs landing on one child ref would leave the child's
  // checkpoint history pointing at whichever alias won; that only happens on
  // corrupt turn rows, so the assembly fails instead of guessing.
  let duplicateAliasTarget: CheckpointRef | null = null;
  const pushAlias = (from: CheckpointRef, to: CheckpointRef) => {
    if (aliasedFroms.has(from)) {
      return;
    }
    if (aliasedTos.has(to)) {
      duplicateAliasTarget ??= to;
      return;
    }
    aliasedFroms.add(from);
    aliasedTos.add(to);
    aliasRefs.push({ from, to });
  };
  for (const row of keptRows) {
    if (
      row.checkpointRef === null ||
      row.checkpointTurnCount === null ||
      !row.checkpointRef.startsWith(CHECKPOINT_REFS_PREFIX)
    ) {
      continue;
    }
    if (aliasRefs.length === 0) {
      pushAlias(
        checkpointRefForThreadTurn(source.id, 0),
        checkpointRefForThreadTurn(input.childThreadId, 0),
      );
    }
    pushAlias(
      row.checkpointRef,
      checkpointRefForThreadTurn(input.childThreadId, row.checkpointTurnCount),
    );
  }
  if (duplicateAliasTarget !== null) {
    return {
      ok: false,
      failure: { kind: "duplicate-alias-target", checkpointRef: duplicateAliasTarget },
    };
  }

  const session = resolveForkSessionSource({
    sourceBinding: input.sourceBinding,
    sourceForkSource: input.sourceForkSource,
  });
  const forkSource: ThreadForkProviderSource | null =
    session === null ? null : { ...session, providerTurnRef: anchor, throughTurnOrdinal, atEnd };

  const maxKeptTurnCount = keptRows.reduce<number | null>(
    (max, row) =>
      row.checkpointTurnCount === null
        ? max
        : max === null
          ? row.checkpointTurnCount
          : Math.max(max, row.checkpointTurnCount),
    null,
  );

  const command: MaterializedThreadForkCommand = {
    type: "thread.fork",
    threadId: input.childThreadId,
    sourceThreadId: source.id,
    throughTurnId: input.throughTurnId,
    createdAt: input.createdAt,
    thread: {
      projectId: source.projectId,
      title: input.title ?? `${source.title} (fork)`,
      modelSelection: source.modelSelection,
      runtimeMode: source.runtimeMode,
      interactionMode: source.interactionMode,
      branch: source.branch,
      worktreePath: source.worktreePath,
    },
    forkedFrom: {
      threadId: source.id,
      turnId: input.throughTurnId,
      turnCount: forkTurn.checkpointTurnCount ?? maxKeptTurnCount ?? 0,
      messageId: input.sourceMessageId,
    },
    forkSource,
    history: { messages, activities, proposedPlans, turns },
  };

  return { ok: true, command, aliasRefs, attachmentCopies };
}

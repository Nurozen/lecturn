/**
 * The command allowlist on Squire-marked threads, always on so a
 * home thread listed by a switch-off or pre-Squire client stays guarded.
 * Default deny: only Squire modules (inside `SquireDispatchOrigin`) run
 * arbitrary commands on a marked thread; anyone else may read, send with the
 * thread's own model, answer a request, and stop.
 *
 * Inside `SquireDispatchOrigin` it also re-checks a held execution's or an
 * accept's trigger under the target's command lock.
 */
import {
  CommandId,
  ModelSelection,
  type OrchestrationV2ServerCommand,
  SquireCardId,
  SquireId,
  SquireThreadMarker,
  ThreadId,
} from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import {
  LecturnHookRejectedError,
  type LecturnCommandAdmissionInput,
  LecturnOrchestrationHooks,
} from "../orchestration-v2/fork/LecturnOrchestrationHooks.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as OrchestrationCommandReceipts from "../persistence/OrchestrationCommandReceipts.ts";
import {
  decodeSquireActionIntent,
  parseSquireActionCommandId,
  squirePreconditionBroken,
} from "./squireActionIntent.ts";
import { SquireDispatchOrigin } from "./SquireDispatchOrigin.ts";
import * as SquireRepository from "./SquireRepository.ts";

const CONTRIBUTION = "squire";

/**
 * - `squire`: only a Squire-dispatched command passes.
 * - `user`: passes from any caller.
 * - `user-message`: a user's message in the thread's own model (`allowedUserMessage`).
 * - `plumbing`: server bookkeeping that cannot change provider, model, modes,
 *   cwd, PR links, or lifecycle.
 */
type SquireCommandRule = "squire" | "user" | "user-message" | "plumbing";

// Typed against the full server command union, so a command type added
// upstream fails typecheck at t3-sync until it is classified here.
export const SQUIRE_COMMAND_RULES = {
  "thread.create": "squire",
  "thread.import": "squire",
  "thread.archive": "squire",
  "thread.unarchive": "squire",
  "thread.delete": "squire",
  "thread.settle": "squire",
  "thread.auto-settle": "squire",
  "thread.unsettle": "squire",
  "thread.snooze": "squire",
  "thread.unsnooze": "squire",
  "thread.auto-settle.set": "squire",
  "thread.pin": "squire",
  "thread.unpin": "squire",
  "thread.pin.reorder": "squire",
  "thread.active.reorder": "squire",
  "thread.visit": "user",
  "thread.mark-unread": "user",
  "thread.metadata.update": "squire",
  "thread.pull-request.link": "squire",
  "thread.pull-request.unlink": "squire",
  "thread.pull-request-link.sync": "squire",
  "thread.pull-request.watch": "squire",
  "thread.pull-request.sync": "squire",
  "thread.pull-request-watch.sync": "squire",
  "thread.title.regeneration.complete": "squire",
  "thread.runtime-mode.set": "squire",
  "thread.interaction-mode.set": "squire",
  "thread.model-selection.set": "squire",
  "provider-session.detach": "squire",
  "message.dispatch": "user-message",
  "prepared-run.release": "squire",
  "prepared-run.progress": "squire",
  "prepared-run.fail": "squire",
  "prepared-run.retry": "squire",
  "notification.delivery.accept": "plumbing",
  "subagent.stop": "squire",
  "run.interrupt": "user",
  "queued-message.promote-to-steer": "squire",
  "queue.resume": "user",
  "queued-run.reorder": "squire",
  "queued-run.cancel": "squire",
  "queued-run.edit": "squire",
  "runtime-request.respond": "user",
  "thread.user-input.dismiss": "squire",
  "checkpoint.rollback": "squire",
  "checkpoint.rollback.fail": "squire",
  "thread.fork": "squire",
  "thread.merge_back": "squire",
  "delegated_task.request": "squire",
  "delegated_task.wake-policy": "squire",
  "delegated_task.completion-delivery.acknowledge": "squire",
  "delegated_task.completion-delivery.dispose": "squire",
  "thread.created.record": "squire",
  "provider.switch": "squire",
  "thread.background-work.settle": "plumbing",
  // A user's Stop, like `run.interrupt` (provenance is stamped the same way).
  "thread.stop": "user",
  "thread.app-data.set": "squire",
  "thread.continued-in.set": "squire",
  "runtime-request.app-expire": "squire",
  "secret_request.record": "squire",
} as const satisfies Record<OrchestrationV2ServerCommand["type"], SquireCommandRule>;

// A type the table does not know (a newer peer, a decode gap) is Squire-only.
const ruleOf = (type: string): SquireCommandRule =>
  Object.hasOwn(SQUIRE_COMMAND_RULES, type)
    ? SQUIRE_COMMAND_RULES[type as keyof typeof SQUIRE_COMMAND_RULES]
    : "squire";

const sameModel = Schema.toEquivalence(ModelSelection);

const USER_DISPATCH_MODES: ReadonlySet<string> = new Set([
  "start_immediately",
  "queue_after_active",
  "steer_active",
]);

type MessageDispatch = Extract<OrchestrationV2ServerCommand, { readonly type: "message.dispatch" }>;

/**
 * `threadModel` is the marked thread's current selection; it is read only
 * when the message names a model. `message:squire:` ids belong to Squire
 * deliveries, which a client must not forge.
 */
const allowedUserMessage = (command: MessageDispatch, threadModel: ModelSelection | undefined) =>
  command.createdBy === "user" &&
  USER_DISPATCH_MODES.has(command.dispatchMode.type) &&
  !command.messageId.startsWith("message:squire:") &&
  (command.modelSelection === undefined ||
    (threadModel !== undefined && sameModel(command.modelSelection, threadModel)));

/** Whether a command from outside `SquireDispatchOrigin` may run on a marked thread. */
const allowedOnMarkedThread = (
  command: OrchestrationV2ServerCommand,
  threadModel: ModelSelection | undefined,
): boolean => {
  switch (ruleOf(command.type)) {
    case "user":
    case "plumbing":
      return true;
    case "user-message":
      return command.type === "message.dispatch" && allowedUserMessage(command, threadModel);
    case "squire":
      return false;
  }
};

// Every thread the command acts on: its lock thread plus a fork, merge-back,
// or delegated-task source or target (`ThreadManagementService.ts`
// `existingThreadIdsForCommand`). Read structurally so a new command shape
// that names a thread is still covered.
const namedThreadIds = (command: OrchestrationV2ServerCommand): ReadonlyArray<ThreadId> => {
  const ids: Array<ThreadId> = [];
  if ("threadId" in command) ids.push(command.threadId);
  if ("parentThreadId" in command) ids.push(command.parentThreadId);
  if ("sourceThreadId" in command) ids.push(command.sourceThreadId);
  if ("targetThreadId" in command) ids.push(command.targetThreadId);
  return ids;
};

/** The marker a committed command gives its thread (marking is Squire-only). */
const markerSetBy = (
  command: OrchestrationV2ServerCommand,
): { readonly threadId: ThreadId; readonly marker: SquireThreadMarker } | undefined => {
  if (command.type === "thread.create" && command.squire !== undefined) {
    return { threadId: command.threadId, marker: command.squire };
  }
  if (command.type === "thread.fork" && command.squireProbe !== undefined) {
    return {
      threadId: command.targetThreadId,
      marker: { squireId: command.squireProbe.squireId, role: "probe" },
    };
  }
  return undefined;
};

const reject = (reason: string, cause?: unknown) =>
  new LecturnHookRejectedError({
    hook: "aroundCommand",
    contribution: CONTRIBUTION,
    reason,
    ...(cause === undefined ? {} : { cause }),
  });

const MarkedThreadRows = Schema.Array(
  Schema.Struct({ thread_id: ThreadId, marker: Schema.String }),
);
const decodeMarkedThreadRows = Schema.decodeUnknownEffect(MarkedThreadRows);
const decodeMarker = Schema.decodeUnknownOption(Schema.fromJsonString(SquireThreadMarker));
// A marker this build cannot read (a newer role) still guards its thread.
const UNREADABLE_MARKER: SquireThreadMarker = {
  squireId: SquireId.make("squire:unknown"),
  role: "home",
};

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const squires = yield* Effect.serviceOption(SquireRepository.SquireRepository);
  const receipts = yield* Effect.serviceOption(
    OrchestrationCommandReceipts.OrchestrationCommandReceiptRepository,
  );
  const loading = yield* Semaphore.make(1);
  // Loaded on the first command, not at layer build, so the read never runs
  // before the projection is ready. Afterwards an unmarked command costs one
  // map lookup per named thread.
  let marked: Map<ThreadId, SquireThreadMarker> | undefined;

  // Reads only the marker column of live thread rows: the hook is installed
  // with the switch off too, so building every thread shell here would tax the
  // first command after each start for users who never made a Squire.
  const loadMarked = Effect.gen(function* () {
    if (marked !== undefined) return marked;
    const rows = yield* sql`SELECT thread_id, json_extract(payload_json, '$.squire') AS marker
      FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL AND json_extract(payload_json, '$.squire') IS NOT NULL`.pipe(
      Effect.flatMap(decodeMarkedThreadRows),
    );
    const loaded = new Map<ThreadId, SquireThreadMarker>();
    for (const row of rows) {
      loaded.set(
        row.thread_id,
        Option.getOrElse(decodeMarker(row.marker), () => UNREADABLE_MARKER),
      );
    }
    marked = loaded;
    return loaded;
  }).pipe(
    loading.withPermits(1),
    Effect.mapError((cause) => reject("Could not check Squire threads. Try again.", cause)),
  );
  const markedThreads = Effect.suspend(() =>
    marked === undefined ? loadMarked : Effect.succeed(marked),
  );

  const managedBy = (marker: SquireThreadMarker) =>
    Option.match(squires, {
      onNone: () => Effect.succeed(Option.none<SquireRepository.SquireRow>()),
      onSome: (repository) => repository.getSquire(marker.squireId),
    }).pipe(
      Effect.map(
        Option.match({
          onNone: () => "Managed by Squire",
          onSome: (squire) => `Managed by Squire ${squire.name}`,
        }),
      ),
      Effect.orElseSucceed(() => "Managed by Squire"),
    );

  const threadModel = (threadId: ThreadId) =>
    projections.getThread(threadId).pipe(
      Effect.map((thread) => thread.modelSelection),
      Effect.orElseSucceed(() => undefined),
    );

  const track = (command: OrchestrationV2ServerCommand) =>
    Effect.sync(() => {
      const set = markerSetBy(command);
      if (set !== undefined) marked?.set(set.threadId, set.marker);
      else if (command.type === "thread.delete") marked?.delete(command.threadId);
    });

  /**
   * A replay passes (its receipt decides); a first dispatch is refused
   * when the user wrote in the target, or a newer trigger arrived, since the
   * intent was written. Same shape as the orchestrator's under-lock
   * `DispatchModeLimit` recheck, without editing the orchestrator.
   */
  const unreadable = (cause: unknown) =>
    reject("Could not re-check the Squire action. Try again.", cause);
  const recheckTrigger = Effect.fn("SquireCommandHook.recheckTrigger")(function* (
    command: OrchestrationV2ServerCommand,
  ) {
    if (command.type !== "message.dispatch") return;
    const parsed = parseSquireActionCommandId(command.commandId);
    if (parsed === undefined || Option.isNone(squires)) return;
    if (Option.isSome(receipts)) {
      const receipt = yield* receipts.value
        .getByCommandId({ commandId: CommandId.make(command.commandId) })
        .pipe(Effect.mapError(unreadable));
      if (Option.isSome(receipt)) return;
    }
    const card = yield* squires.value
      .getCard(SquireCardId.make(parsed.cardId))
      .pipe(Effect.mapError(unreadable));
    const intent = Option.flatMap(card, (row) => decodeSquireActionIntent(row.intent_json));
    if (Option.isNone(intent) || intent.value.type !== "steer") {
      return yield* reject("This Squire action no longer exists.");
    }
    if (intent.value.threadId !== command.threadId) {
      return yield* reject("This Squire action names another thread.");
    }
    const broken = yield* squirePreconditionBroken(
      projections,
      command.threadId,
      intent.value.precondition,
    ).pipe(Effect.mapError(unreadable));
    if (broken !== undefined) {
      return yield* reject(`Not sent: ${broken} after the Squire raised it.`);
    }
  });

  // Wraps every dispatched command; the dispatch owns the span.
  const aroundCommand = Effect.fnUntraced(function* <A, E, R>(
    input: LecturnCommandAdmissionInput,
    commit: Effect.Effect<A, E, R>,
  ): Effect.fn.Return<A, E | LecturnHookRejectedError, R> {
    if (input.scope !== "thread") return yield* commit;
    const command = input.command;
    const markers = yield* markedThreads;
    if (yield* SquireDispatchOrigin) {
      yield* recheckTrigger(command);
      return yield* commit.pipe(Effect.tap(() => track(command)));
    }
    if (markerSetBy(command) !== undefined) {
      return yield* reject("Only a Squire can create Squire threads.");
    }
    let marker: SquireThreadMarker | undefined;
    for (const threadId of namedThreadIds(command)) {
      marker ??= markers.get(threadId);
    }
    if (marker === undefined) return yield* commit;
    const model =
      command.type === "message.dispatch" && command.modelSelection !== undefined
        ? yield* threadModel(command.threadId)
        : undefined;
    if (allowedOnMarkedThread(command, model)) return yield* commit;
    return yield* reject(yield* managedBy(marker));
  });

  return { name: CONTRIBUTION, aroundCommand };
});

/** Registers the allowlist on the registry the orchestrator resolves. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const hooks = yield* LecturnOrchestrationHooks;
    yield* hooks.register(yield* make);
  }),
);

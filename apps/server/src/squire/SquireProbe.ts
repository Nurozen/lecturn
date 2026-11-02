// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no synchronous hash.
import * as NodeCrypto from "node:crypto";

/**
 * "Ask about this" (P7.5, D25): the user's question about a card goes to a
 * temporary fork of the card's target thread, marked as a probe, so it runs
 * the deny runtime with auto-decline, gets no MCP session, and is refused
 * every command from outside Squire modules. The answer lands in the card's
 * `ask_json` when the reactor sees the probe's run end; the probe is then
 * deleted, since an archived shell still streams. Nothing is written to the
 * source thread or to the Squire's home thread.
 */
import {
  CommandId,
  MessageId,
  type OrchestrationV2Run,
  type RunId,
  SquireCardAsk,
  type SquireCardId,
  SquireError,
  type SquireId,
  type SquireItemAskInput,
  type SquireItemAskResult,
  ThreadId,
} from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { withSquireDispatchOrigin } from "./SquireDispatchOrigin.ts";
import { orSquireError } from "./SquireLifecycle.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireService from "./SquireService.ts";

export class SquireProbe extends Context.Service<
  SquireProbe,
  {
    /** A retry with the same `requestId` returns the same ask and forks once. */
    readonly ask: (
      input: typeof SquireItemAskInput.Type,
    ) => Effect.Effect<typeof SquireItemAskResult.Type, SquireError>;
    /**
     * The reactor saw a probe's run end: store the answer on its card, then
     * delete the probe. Safe to repeat for later updates of the same run.
     */
    readonly finish: (input: {
      readonly squireId: SquireId;
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly status: OrchestrationV2Run["status"];
    }) => Effect.Effect<void, SquireError>;
    /**
     * Run once at startup: an ask a crash left `running` gets its missing
     * fork or message sent under the stored ids, or, when its run already
     * ended unseen, its answer stored and the probe deleted.
     */
    readonly reconcileStartup: Effect.Effect<void, SquireError>;
  }
>()("lecturn/squire/SquireProbe") {}

const probeKey = (cardId: SquireCardId, requestId: string) =>
  NodeCrypto.createHash("sha256").update(`${cardId}\0${requestId}`).digest("hex").slice(0, 32);

/** Derived from the ask, so a retried RPC finds the same probe (A9). */
export const probeThreadIdFor = (cardId: SquireCardId, requestId: string) =>
  ThreadId.make(`thread:squire-probe:${probeKey(cardId, requestId)}`);

export const probeForkCommandId = (cardId: SquireCardId, requestId: string) =>
  CommandId.make(`server:squire:probe:${probeKey(cardId, requestId)}`);

const probeMessageId = (cardId: SquireCardId, requestId: string) =>
  MessageId.make(`message:squire-probe:${probeKey(cardId, requestId)}`);

const TERMINAL_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "rolled_back",
]);

const ALL_CARD_STATUSES = [
  "held",
  "open",
  "accepting",
  "executing",
  "resolved",
  "executed",
  "dismissed",
  "outdated",
] as const satisfies ReadonlyArray<SquireRepository.SquireCardRow["status"]>;

const PROBE_TITLE = "Ask about this";

// The deny runtime is the enforcement; this only keeps the answer on topic.
const probePrompt = (question: string) =>
  [
    "Answer this question about the conversation so far. Read and explain only:",
    "do not edit files, run commands that change anything, or contact anyone.",
    "",
    question,
  ].join("\n");

const encodeAsk = Schema.encodeSync(Schema.fromJsonString(SquireCardAsk));
const decodeAsk = Schema.decodeUnknownOption(Schema.fromJsonString(SquireCardAsk));

const askOf = (card: SquireRepository.SquireCardRow) =>
  card.ask_json === null ? Option.none() : decodeAsk(card.ask_json);

const refuse = (code: SquireError["code"], message: string) =>
  Effect.fail(new SquireError({ code, message }));

const make = Effect.gen(function* () {
  const repository = yield* SquireRepository.SquireRepository;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const service = yield* SquireService.SquireService;
  const config = yield* ServerConfig.ServerConfig;
  // Asks are rare; one at a time keeps two different requests on one card from both forking.
  const asking = yield* Semaphore.make(1);

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const storeAsk = (cardId: SquireCardId, ask: SquireCardAsk) =>
    Effect.flatMap(nowIso, (updatedAt) =>
      repository.updateCard({
        id: cardId,
        fromStatuses: ALL_CARD_STATUSES,
        patch: { ask_json: encodeAsk(ask) },
        updatedAt,
      }),
    );

  const deleteProbe = (threadId: ThreadId) =>
    withSquireDispatchOrigin(
      orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make(`server:squire:probe-delete:${threadId}`),
        threadId,
      }),
    );

  /** Both commands replay from their receipts on a retry. */
  const startProbe = (
    card: SquireRepository.SquireCardRow,
    sourceThreadId: ThreadId,
    ask: SquireCardAsk,
  ) =>
    withSquireDispatchOrigin(
      Effect.gen(function* () {
        const probeThreadId = probeThreadIdFor(card.id, ask.requestId);
        const forkCommandId = probeForkCommandId(card.id, ask.requestId);
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: forkCommandId,
          sourceThreadId,
          targetThreadId: probeThreadId,
          sourcePoint: { type: "latest_stable" },
          // An explicit title, so the probe's first turn generates none.
          title: PROBE_TITLE,
          squireProbe: { squireId: card.squire_id },
          createdBy: "system",
          creationSource: "server",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${forkCommandId}:ask`),
          threadId: probeThreadId,
          messageId: probeMessageId(card.id, ask.requestId),
          text: probePrompt(ask.question),
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "system",
          creationSource: "server",
        });
      }),
    );

  const ask: SquireProbe["Service"]["ask"] = Effect.fn("SquireProbe.ask")(
    function* (input) {
      if (!config.squireEnabled) {
        return yield* refuse("disabled_by_server", "Squires are turned off on this server.");
      }
      if (!config.threadForkingEnabled) {
        return yield* refuse(
          "not_available",
          "Ask is not available: forking is off on this server.",
        );
      }
      const found = yield* repository.getCard(input.cardId);
      if (Option.isNone(found)) return yield* refuse("not_found", "This item no longer exists.");
      const card = found.value;
      const current = Option.getOrNull(askOf(card));
      if (current !== null && current.requestId === input.requestId) {
        if (current.status === "running" && card.target_thread_id !== null) {
          yield* startProbe(card, card.target_thread_id, current).pipe(
            Effect.catch((cause) => Effect.logWarning("Squire probe retry failed", { cause })),
          );
        }
        return { ask: current };
      }
      if (current?.status === "running") {
        return yield* refuse("invalid_request", "An answer to the last question is on its way.");
      }
      const sourceThreadId = card.target_thread_id;
      if (sourceThreadId === null) {
        return yield* refuse("invalid_request", "This item has no thread to ask about.");
      }
      const source = yield* projections.getThreadShell(sourceThreadId);
      if (source === null || source.squire !== undefined) {
        return yield* refuse("not_found", "The thread for this item no longer exists.");
      }
      const support = yield* service.probeSupport(source.providerInstanceId);
      if (!support.supported) {
        return yield* refuse(
          "provider_unsupported",
          support.reason ?? "Ask is not available for this provider.",
        );
      }
      const { runs } = yield* projections.getThreadRecords(sourceThreadId, ["runs"]);
      if (!runs.some((run) => run.status === "completed" && run.checkpointId !== null)) {
        return yield* refuse("not_available", "This thread has no finished turn to ask about yet.");
      }

      // Stored first, so a crash after the fork still has a card to answer.
      const running: SquireCardAsk = {
        requestId: input.requestId,
        question: input.question,
        status: "running",
        answer: null,
        error: null,
        askedAt: yield* nowIso,
      };
      yield* storeAsk(card.id, running);
      const started = yield* startProbe(card, sourceThreadId, running).pipe(Effect.result);
      if (Result.isFailure(started)) {
        yield* Effect.logWarning("Squire probe failed to start", { cause: started.failure });
        const failed: SquireCardAsk = {
          ...running,
          status: "failed",
          error: "The question could not be sent. Try again.",
        };
        yield* storeAsk(card.id, failed);
        yield* deleteProbe(probeThreadIdFor(card.id, running.requestId)).pipe(Effect.ignore);
        return { ask: failed };
      }
      return { ask: running };
    },
    (effect) => asking.withPermits(1)(effect),
    orSquireError("ask about this item"),
  );

  const lastAssistantText = (threadId: ThreadId, runId: RunId) =>
    projections
      .getThreadRecords(threadId, ["turnItems"], {
        turnItemRunId: runId,
        turnItemTypes: ["assistant_message"],
      })
      .pipe(
        Effect.map(({ turnItems }) =>
          turnItems
            .toSorted((left, right) => left.ordinal - right.ordinal)
            .flatMap((item) =>
              item.type === "assistant_message" && item.text.trim() !== ""
                ? [item.text.trim()]
                : [],
            )
            .at(-1),
        ),
      );

  const finish: SquireProbe["Service"]["finish"] = Effect.fn("SquireProbe.finish")(function* (
    input,
  ) {
    const cards = yield* repository.listCards({ squireId: input.squireId });
    for (const card of cards) {
      const current = Option.getOrNull(askOf(card));
      if (current?.status !== "running") continue;
      if (probeThreadIdFor(card.id, current.requestId) !== input.threadId) continue;
      const answer =
        input.status === "completed"
          ? yield* lastAssistantText(input.threadId, input.runId)
          : undefined;
      yield* storeAsk(
        card.id,
        answer === undefined
          ? {
              ...current,
              status: "failed",
              error:
                input.status === "completed"
                  ? "The question finished without an answer."
                  : "The question stopped before it was answered.",
            }
          : { ...current, status: "answered", answer },
      );
    }
    yield* deleteProbe(input.threadId);
  }, orSquireError("store the answer"));

  const reconcileCard = (card: SquireRepository.SquireCardRow, current: SquireCardAsk) =>
    Effect.gen(function* () {
      const threadId = probeThreadIdFor(card.id, current.requestId);
      const probe = yield* projections.getThreadShell(threadId);
      const { messages } =
        probe === null
          ? { messages: [] }
          : yield* projections.getThreadRecords(threadId, ["messages"], {
              messageIds: [probeMessageId(card.id, current.requestId)],
            });
      const runId = messages[0]?.runId ?? null;
      if (runId === null) {
        if (messages.length > 0) return; // Queued; the worker starts it.
        if (card.target_thread_id === null) {
          return yield* storeAsk(card.id, {
            ...current,
            status: "failed",
            error: "The question stopped before it was answered.",
          });
        }
        return yield* startProbe(card, card.target_thread_id, current);
      }
      const { runs } = yield* projections.getThreadRecords(threadId, ["runs"], {
        runIds: [runId],
      });
      const run = runs[0];
      // A live run reaches the reactor when runtime recovery ends it.
      if (run === undefined || !TERMINAL_RUN_STATUSES.has(run.status)) return;
      yield* finish({ squireId: card.squire_id, threadId, runId, status: run.status });
    });

  const reconcileStartup: SquireProbe["Service"]["reconcileStartup"] = Effect.gen(function* () {
    for (const card of yield* repository.listCards({})) {
      const current = Option.getOrNull(askOf(card));
      if (current?.status !== "running") continue;
      yield* reconcileCard(card, current).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Squire probe reconcile failed; marking the ask failed", {
            cardId: card.id,
            cause,
          }).pipe(
            Effect.andThen(
              storeAsk(card.id, {
                ...current,
                status: "failed",
                error: "The question could not be resumed. Ask again.",
              }),
            ),
            Effect.andThen(deleteProbe(probeThreadIdFor(card.id, current.requestId))),
            Effect.ignore,
          ),
        ),
      );
    }
  }).pipe(orSquireError("resume questions"), Effect.withSpan("SquireProbe.reconcileStartup"));

  return SquireProbe.of({ ask, finish, reconcileStartup });
});

export const layer = Layer.effect(SquireProbe, make);

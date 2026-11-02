import {
  SquireTurnSummary,
  type ModelSelection,
  type ProviderInstanceId,
  type RunId,
  type SquireId,
  type SquireSummaryInput,
  type SquireSummaryModelOutput,
  type ThreadId,
  squireOutcome,
} from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import type { PersistenceSqlError } from "../persistence/Errors.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { SquireRepository, type SquireSummaryRow } from "./SquireRepository.ts";
import { SquireHooks } from "./squireHooks.ts";
import { squireDeterministicSummary, squireSummaryWithModel } from "./SquireSummaryInput.ts";

/** P3.4: delivery waits this long for a summary; the model call gets the same budget. */
export const SQUIRE_SUMMARY_BUDGET = Duration.seconds(20);

/** `terminal` at run end; `request:<requestId>` for the provisional summary taken at a wait (D18). */
export type SquireSummaryStage = "terminal" | `request:${string}`;

export interface SquireSummaryKey {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly stage: SquireSummaryStage;
}

/** A Squire tracking the thread, as the payer rule sees it. */
export interface SquireSummaryTracker {
  readonly squireId: SquireId;
  readonly createdAt: string;
  readonly active: boolean;
  readonly turnFinishedOn: boolean;
  readonly summaryModelSelection: ModelSelection | null;
}

export interface SquireSummaryRequest extends SquireSummaryKey {
  readonly trackers: ReadonlyArray<SquireSummaryTracker>;
  /**
   * Set for a fixture-owned thread (D44j): its summary is the fixture's, or
   * deterministic fields only, and no provider is ever called.
   */
  readonly fixture?: { readonly summary: SquireTurnSummary | null };
}

export interface SquireStoredSummary {
  readonly status: SquireSummaryRow["status"];
  readonly summary: SquireTurnSummary;
  readonly payerSquireId: SquireId | null;
}

export class SquireRunSourceError extends Schema.TaggedError<SquireRunSourceError>()(
  "SquireRunSourceError",
  { threadId: Schema.String, runId: Schema.String, detail: Schema.String },
) {}

/** Reads one run from orchestration state as a summary input. */
export class SquireRunSource extends Context.Service<
  SquireRunSource,
  {
    readonly load: (key: SquireSummaryKey) => Effect.Effect<
      {
        readonly input: SquireSummaryInput;
        /**
         * The run's own provider instance at its cheap preset, or null when
         * that instance cannot write isolated Squire summaries.
         */
        readonly threadModel: ModelSelection | null;
      },
      SquireRunSourceError
    >;
  }
>()("lecturn/squire/SquireSummaries/SquireRunSource") {}

export class SquireSummaries extends Context.Service<
  SquireSummaries,
  {
    /**
     * Returns the stored summary for the stage, generating it first when
     * absent. Concurrent and repeated calls share one model call per stage.
     */
    readonly ensure: (
      request: SquireSummaryRequest,
    ) => Effect.Effect<SquireStoredSummary, PersistenceSqlError | SquireRunSourceError>;
    /**
     * The summary an event renders: its own stage when given; otherwise the
     * terminal summary, or the latest provisional one before the run ends.
     */
    readonly read: (
      key: Omit<SquireSummaryKey, "stage"> & { readonly stage?: SquireSummaryStage },
    ) => Effect.Effect<Option.Option<SquireStoredSummary>, PersistenceSqlError>;
    /** Startup: a summary left generating by a crash keeps its deterministic fields only. */
    readonly settleInterrupted: Effect.Effect<number, PersistenceSqlError>;
  }
>()("lecturn/squire/SquireSummaries") {}

const encodeSummary = Schema.encodeSync(Schema.fromJsonString(SquireTurnSummary));
const decodeSummary = Schema.decodeUnknownSync(Schema.fromJsonString(SquireTurnSummary));

const toStored = (row: SquireSummaryRow): SquireStoredSummary => {
  const summary = decodeSummary(row.summary_json);
  return {
    status: row.status,
    // A row settled by a restart keeps the JSON written before generation.
    summary: row.status === "partial" ? { ...summary, summaryStatus: "partial" } : summary,
    payerSquireId: row.payer_squire_id,
  };
};

/**
 * D18 payer chain: the summary setting of the earliest-created active Squire
 * tracking the thread with turn-finished on; then the thread's own provider;
 * then the environment's text generation model; else none (partial).
 */
export function chooseSquireSummaryPayer(
  trackers: ReadonlyArray<SquireSummaryTracker>,
  threadModel: ModelSelection | null,
  settingsModel: ModelSelection | null,
): { readonly modelSelection: ModelSelection; readonly payerSquireId: SquireId | null } | null {
  const owner = trackers
    .filter((tracker) => tracker.active && tracker.turnFinishedOn)
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  if (owner?.summaryModelSelection) {
    return { modelSelection: owner.summaryModelSelection, payerSquireId: owner.squireId };
  }
  const fallback = threadModel ?? settingsModel;
  return fallback ? { modelSelection: fallback, payerSquireId: null } : null;
}

const keyString = (key: SquireSummaryKey) => `${key.threadId}\u0000${key.runId}\u0000${key.stage}`;

export const make = Effect.gen(function* () {
  const repository = yield* SquireRepository;
  const source = yield* SquireRunSource;
  const generator = yield* TextGeneration;
  const settings = yield* ServerSettingsService;
  // 7.3: the overlap detector follows every stored summary (D30).
  const hooks = yield* Effect.serviceOption(SquireHooks);
  const inFlight = new Map<
    string,
    Deferred.Deferred<SquireStoredSummary, PersistenceSqlError | SquireRunSourceError>
  >();
  // One summary call at a time per provider instance (D18), so a burst of
  // run ends never fans out into parallel CLI processes.
  const permits = new Map<ProviderInstanceId, Semaphore.Semaphore>();
  const permitFor = (instanceId: ProviderInstanceId) => {
    let permit = permits.get(instanceId);
    if (!permit) {
      permit = Semaphore.makeUnsafe(1);
      permits.set(instanceId, permit);
    }
    return permit;
  };

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const rowKey = (key: SquireSummaryKey) => ({
    thread_id: key.threadId,
    run_id: key.runId,
    stage: key.stage,
  });

  const callModel = (
    input: SquireSummaryInput,
    outcome: SquireTurnSummary["outcome"],
    modelSelection: ModelSelection,
  ): Effect.Effect<Option.Option<SquireSummaryModelOutput>> => {
    const generate = generator.generateSquireTurnSummary;
    if (!generate) return Effect.succeedNone;
    return generate({ cwd: "/", summaryInput: input, outcome, modelSelection }).pipe(
      permitFor(modelSelection.instanceId).withPermits(1),
      Effect.timeoutOption(SQUIRE_SUMMARY_BUDGET),
      // Errors carry no conversation text; one the user can act on (a login
      // the Squire home cannot reach) is logged in its own words.
      Effect.tapError((error) =>
        Effect.logWarning("Squire summary is partial", {
          instanceId: modelSelection.instanceId,
          reason: error.detail,
        }),
      ),
      // Failure is an honest partial; the sanitized error stays in traces.
      Effect.catchCause(() => Effect.succeedNone),
    );
  };

  const generate = Effect.fn("SquireSummaries.generate")(function* (request: SquireSummaryRequest) {
    const existing = yield* repository.getSummary(rowKey(request));
    if (Option.isSome(existing)) return toStored(existing.value);

    const { input, threadModel } = yield* source.load(request);
    // A user stop has no event outcome; the event overlay carries the outcome shown.
    const outcome = squireOutcome(input.session) ?? "stopped";
    const deterministic = squireDeterministicSummary(input, outcome);
    const createdAt = yield* nowIso;
    const inserted = yield* repository.insertSummary({
      ...rowKey(request),
      status: "generating",
      summary_json: encodeSummary(deterministic),
      payer_squire_id: null,
      created_at: createdAt,
      updated_at: createdAt,
    });
    if (!inserted) {
      const raced = yield* repository.getSummary(rowKey(request));
      if (Option.isSome(raced)) return toStored(raced.value);
    }

    let summary = deterministic;
    let payerSquireId: SquireId | null = null;
    if (request.fixture) {
      summary = request.fixture.summary ?? deterministic;
    } else {
      const settingsModel = yield* settings.getSettings.pipe(
        Effect.map((value) => value.textGenerationModelSelection),
        Effect.orElseSucceed(() => null),
      );
      const payer = chooseSquireSummaryPayer(request.trackers, threadModel, settingsModel);
      if (payer) {
        const model = yield* callModel(input, outcome, payer.modelSelection);
        if (Option.isSome(model)) {
          summary = squireSummaryWithModel(deterministic, model.value);
          payerSquireId = payer.payerSquireId;
        }
      }
    }
    const status = summary.summaryStatus;
    const finished = yield* repository.finishSummary({
      ...rowKey(request),
      status,
      summary_json: encodeSummary(summary),
      payer_squire_id: payerSquireId,
      updated_at: yield* nowIso,
    });
    if (finished && Option.isSome(hooks)) {
      yield* hooks.value.summaryStored({
        threadId: request.threadId,
        runId: request.runId,
        stage: request.stage,
        summary,
      });
    }
    return { status, summary, payerSquireId } satisfies SquireStoredSummary;
  });

  const ensure: SquireSummaries["Service"]["ensure"] = (request) =>
    Effect.gen(function* () {
      const key = keyString(request);
      const pending = inFlight.get(key);
      if (pending) return yield* Deferred.await(pending);
      const done = yield* Deferred.make<
        SquireStoredSummary,
        PersistenceSqlError | SquireRunSourceError
      >();
      inFlight.set(key, done);
      return yield* generate(request).pipe(
        Effect.exit,
        Effect.tap((exit) => Deferred.done(done, exit)),
        Effect.ensuring(Effect.sync(() => inFlight.delete(key))),
        Effect.flatten,
      );
    });

  const read: SquireSummaries["Service"]["read"] = (key) =>
    Effect.gen(function* () {
      if (key.stage) {
        const row = yield* repository.getSummary(rowKey({ ...key, stage: key.stage }));
        return Option.map(row, toStored);
      }
      const rows = yield* repository.listRunSummaries({
        thread_id: key.threadId,
        run_id: key.runId,
      });
      const chosen = rows.find((row) => row.stage === "terminal") ?? rows.at(-1);
      return Option.map(Option.fromNullishOr(chosen), toStored);
    });

  return SquireSummaries.of({
    ensure,
    read,
    settleInterrupted: nowIso.pipe(Effect.flatMap(repository.settleGeneratingSummaries)),
  });
});

export const layer = Layer.effect(SquireSummaries, make);

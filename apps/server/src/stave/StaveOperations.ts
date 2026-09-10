import { StaveRuntimeFence } from "./StaveRuntimeFence.ts";
import { StaveExecution } from "./StaveExecution.ts";
import { AnalyticsService } from "../telemetry/AnalyticsService.ts";
import { staveTelemetryEvent } from "./StaveTelemetry.ts";
/**
 * StaveOperations - application-lifetime runner for the long Stave mutations
 * behind `stave.runOperation` / `stave.observeOperation` (deviation 26).
 *
 * Every operation is started ONCE per client-supplied `operationId` on a
 * fiber owned by this service's scope (a WebSocket-bound fiber would die with
 * the tab), and its progress is kept in a registry entry: a bounded ring
 * buffer of `StaveProgressEvent`s numbered by a per-operation `sequence`
 * (1-based), plus a PubSub for live followers. `run` starts when the id is
 * new, attaches (replay after `afterSequence`, then follow live) when the id
 * is running or finished with the same payload fingerprint, and refuses a
 * different payload under the same id. Terminal entries stay 24h so a
 * reconnecting client can still read the outcome; after that the id is
 * `operation_expired` for good.
 *
 * Progress is Lecturn-orchestrated (deviation 2): each Stave invocation is a
 * `phase_started` / `output` / `phase_finished` triple, Stave's `notes[]` and
 * `plan[]` arrive as `output` with `stream: "notes" | "plan"`, and the
 * operation ends with `finished { kind, result }` or `failed { error }`.
 * Nothing is compensated automatically: a failed `createSpace` leaves the
 * partial space for the explicit `removePartialSpace`, which is bound to the
 * manifest stamp the create produced (`incarnation_mismatch` otherwise).
 *
 * Mutations on one space root are serialised by a keyed mutex (`withSpaceLock`)
 * so admission and lifecycle sweeps can share the same lock later.
 *
 * @module StaveOperations
 */
import {
  CommandId,
  ProjectId,
  type StaveCreateSpaceOperation,
  type StaveLifecycleActionOperation,
  type StaveCreateSagaOperation,
  type StaveMemoryAttachResult,
  type StaveObserveOperationInput,
  type StaveOperation,
  type StaveOperationError,
  type StaveOperationKind,
  StaveOperationRejectedError,
  type StaveOperationResult,
  type StaveProgressEvent,
  type StaveProgressOutputStream,
  type StaveRegisterRepoOperation,
  type StaveRemovePartialSpaceOperation,
  type StaveRunOperationInput,
  type StaveSetupOperation,
  type StaveSagaReview,
  type StaveDryRunPlan,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  StaveLifecycleRepository,
  type StaveLifecycleRow,
} from "../persistence/Services/StaveLifecycleRepository.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { WorkspacePaths } from "../workspace/WorkspacePaths.ts";
import { isPathUnder, StaveSpaceLock } from "./StaveSpaceLock.ts";
import * as Stream from "effect/Stream";
import * as NodeCrypto from "node:crypto";

import { normalizeDispatchCommand } from "../orchestration/Normalizer.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProcessRunner } from "../processRunner.ts";
import {
  buildStaveArgv,
  STAVE_VERB_POLICY,
  StaveCli,
  type StaveSpaceCreateInput,
  type StaveStreamOptions,
  type StaveVerb,
} from "./StaveCli.ts";
import { StaveReadCache } from "./StaveReadCache.ts";
import { StaveConfigReader } from "./StaveConfigReader.ts";
import { StaveError, StaveErrorCode, StaveErrorDetails } from "./StaveError.ts";
import { isStaveDryRunPlan } from "./staveJson.ts";
import { STAVE_ARCHIVE_DIRECTORY_NAME, StaveWorkspaceReader } from "./StaveWorkspaceReader.ts";

// ── Limits ────────────────────────────────────────────────────

/** Per-operation ring buffer: whichever of the two bounds is hit first evicts from the front. */
export const STAVE_OPERATION_EVENT_LIMIT = 2_000;
export const STAVE_OPERATION_BYTE_LIMIT = 4 * 1024 * 1024;
/** Registry-wide bound; the least recently attached entries lose their oldest events first. */
export const STAVE_REGISTRY_BYTE_LIMIT = 64 * 1024 * 1024;
/** How long a finished/failed operation stays attachable. */
export const STAVE_OPERATION_RETENTION = Duration.hours(24);

export interface StaveOperationsLimits {
  readonly eventLimit?: number;
  readonly byteLimit?: number;
  readonly registryByteLimit?: number;
  readonly retention?: Duration.Input;
}

// ── Pre-flight refusals ───────────────────────────────────────

/** A refusal raised by Lecturn before (or between) Stave invocations; carries no verb. */
export class StaveRefusalError extends Schema.TaggedErrorClass<StaveRefusalError>()(
  "StaveRefusalError",
  {
    code: StaveErrorCode,
    message: Schema.String,
    details: Schema.NullOr(StaveErrorDetails),
  },
) {}

const refuse = (code: StaveErrorCode, message: string, details: StaveErrorDetails | null = null) =>
  new StaveRefusalError({ code, message, details });

// ── Pure helpers ──────────────────────────────────────────────

/** Compare RFC3339 instants without discarding the manifest's nanoseconds. */
export function sameManifestIncarnation(left: string, right: string): boolean {
  const epoch = (value: string) => {
    const match = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (match === null) return null;
    const seconds = Date.parse(`${match[1]}${match[3]}`);
    return Number.isFinite(seconds)
      ? BigInt(seconds) * 1_000_000n + BigInt((match[2] ?? "").padEnd(9, "0"))
      : null;
  };
  const first = epoch(left);
  return first !== null && first === epoch(right);
}

/** Stable identity of an operation payload; equal payloads may share an id. */
export function fingerprintOperation(operation: StaveOperation): string {
  return NodeCrypto.createHash("sha256").update(stableStringify(operation)).digest("hex");
}

/** Approximate wire size of one buffered event. */
const eventBytes = (event: StaveProgressEvent): number => JSON.stringify(event).length;

const isTerminalEvent = (event: StaveProgressEvent): boolean =>
  event.kind === "finished" || event.kind === "failed";

/** Userinfo in a URL is the one place a repo url can carry a token. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username.length === 0 && url.password.length === 0) {
      return raw;
    }
    url.username = "***";
    url.password = "";
    return url.href;
  } catch {
    return raw;
  }
}

/** The `stave ...` line shown for a phase; a builder failure shows just the verb. */
export function commandLineOf(
  verb: StaveVerb,
  built: Result.Result<ReadonlyArray<string>, string>,
) {
  return Result.isSuccess(built) ? `stave ${built.success.join(" ")}` : `stave ${verb}`;
}

/** Stave's `.archive/` basenames: the exact id or `<id>-<14-digit timestamp>`. */
export function archiveEntriesMatching(spaceId: string, entries: ReadonlyArray<string>) {
  const timestamped = new RegExp(`^${spaceId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d{14}$`);
  return entries.filter((entry) => entry === spaceId || timestamped.test(entry));
}

/** The Stave verb each operation kind runs, for errors raised before it is invoked. */
export const STAVE_OPERATION_VERB: Readonly<Record<StaveOperationKind, StaveVerb>> = {
  lifecycleAction: "space destroy",
  createSpace: "space create",
  registerRepo: "repos add",
  addRepo: "space add",
  removeRepo: "space remove",
  syncSpace: "space sync",
  retarget: "space retarget",
  archiveSpace: "space archive",
  destroySpace: "space destroy",
  restoreSpace: "space restore",
  removePartialSpace: "space destroy",
  setup: "setup",
  memoryAttach: "memory attach",
  memoryDetach: "memory detach",
  createSaga: "saga create",
  sagaAdd: "saga add",
  sagaRemove: "saga remove",
  sagaSync: "saga sync",
  sagaArchive: "saga archive",
  sagaDestroy: "saga destroy",
};

export function toOperationError(
  cause: Cause.Cause<StaveError | StaveRefusalError>,
): StaveOperationError {
  const failure = Cause.findErrorOption(cause);
  if (Option.isSome(failure)) {
    const error = failure.value;
    return error._tag === "StaveError"
      ? { code: error.code, message: error.message, details: error.details, verb: error.verb }
      : { code: error.code, message: error.message, details: error.details };
  }
  const squashed = Cause.squash(cause);
  return {
    code: "unknown",
    message: Cause.hasInterruptsOnly(cause)
      ? "The operation was interrupted before it finished."
      : squashed instanceof Error
        ? squashed.message
        : String(squashed),
    details: null,
  };
}

// ── Registry ──────────────────────────────────────────────────

interface BufferedEvent {
  readonly event: StaveProgressEvent;
  readonly bytes: number;
}

/** The partial space a failed `createSpace` left behind, surfaced in `failed.error.details`. */
interface PartialSpace {
  readonly spaceId: string;
  readonly spacePath: string;
  readonly manifestCreatedAt: string;
}

export type StaveOperationState = "running" | "finished" | "failed";

interface RegistryEntry {
  readonly operationId: string;
  readonly kind: StaveOperationKind;
  readonly fingerprint: string;
  state: StaveOperationState;
  readonly events: Array<BufferedEvent>;
  bytes: number;
  /** Sequence the next emitted event receives (1-based). */
  nextSequence: number;
  terminalAtMs: number | null;
  lastAccessMs: number;
  /** Set as soon as `space create` returns, before verify/project.create can still fail. */
  partialSpace: PartialSpace | null;
  partialCleanupEdges: unknown | null;
  readonly pubsub: PubSub.PubSub<StaveProgressEvent>;
}

const earliestSequence = (entry: RegistryEntry): number =>
  entry.events[0]?.event.sequence ?? entry.nextSequence;

/** What tests and diagnostics may read about an entry. */
export interface StaveOperationSummary {
  readonly operationId: string;
  readonly kind: StaveOperationKind;
  readonly state: StaveOperationState;
  readonly earliestSequence: number;
  readonly nextSequence: number;
  readonly bufferedEvents: number;
  readonly manifestCreatedAt: string | null;
}

// ── Service ───────────────────────────────────────────────────

export interface StaveOperationsShape {
  /** Start-or-attach; the stream ends after the terminal event. */
  readonly run: (
    input: StaveRunOperationInput,
  ) => Stream.Stream<StaveProgressEvent, StaveOperationRejectedError>;
  /** Attach to a known operation (running or retained). */
  readonly observe: (
    input: StaveObserveOperationInput,
  ) => Stream.Stream<StaveProgressEvent, StaveOperationRejectedError>;
  /** `--dry-run --json` plan for the kinds that support it; `invalid_arguments` otherwise. */
  readonly dryRun: (operation: StaveOperation) => Effect.Effect<StaveDryRunPlan, StaveError>;
  /** Serialises `effect` with every other mutation on the same canonical root. */
  readonly withSpaceLock: <A, E, R>(
    root: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly executeLifecycle: (
    operation: StaveLifecycleActionOperation,
    revalidate?: Effect.Effect<void, StaveError | StaveRefusalError>,
    revalidateParticipant?: (
      projectId: ProjectId,
    ) => Effect.Effect<void, StaveError | StaveRefusalError>,
  ) => Effect.Effect<void, StaveError | StaveRefusalError>;
  readonly reconcileIncomplete: Effect.Effect<void, StaveError | StaveRefusalError>;
  readonly summary: (operationId: string) => Effect.Effect<Option.Option<StaveOperationSummary>>;
}

export class StaveOperations extends Context.Service<StaveOperations, StaveOperationsShape>()(
  "t3/stave/StaveOperations",
) {}

type OperationOutcome = StaveOperationResult;

export const make = Effect.fn("StaveOperations.make")(function* (
  limits: StaveOperationsLimits = {},
) {
  const cli = yield* StaveCli;
  const execution = yield* StaveExecution;
  const withExecution = <A, E, R>(operation: StaveOperation, effect: Effect.Effect<A, E, R>) =>
    operation.kind === "lifecycleAction" &&
    (operation.action === "keep" || operation.action === "dismiss")
      ? effect
      : execution.withExecution(effect, {
          writableConfig: operation.kind === "setup" || operation.kind === "registerRepo",
        });
  const analytics = yield* AnalyticsService;
  const recordOutcome = (
    operation: StaveOperation,
    trigger: "interactive" | "automatic",
    exit: Exit.Exit<OperationOutcome, StaveError | StaveRefusalError>,
  ) => {
    const event = staveTelemetryEvent(
      operation,
      trigger,
      Exit.isSuccess(exit)
        ? { state: "success" }
        : { state: "failure", code: toOperationError(exit.cause).code },
    );
    return event === null ? Effect.void : analytics.record(event.event, event.properties);
  };
  const configReader = yield* StaveConfigReader;
  const workspaceReader = yield* StaveWorkspaceReader;
  const readCache = yield* Effect.serviceOption(StaveReadCache);
  const invalidateReads = Option.isSome(readCache) ? readCache.value.invalidate : Effect.void;
  const processRunner = yield* ProcessRunner;
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lifecycle = yield* StaveLifecycleRepository;
  const providers = yield* ProviderService;
  const terminals = yield* TerminalManager;
  const workspacePaths = yield* WorkspacePaths;
  const serviceScope = yield* Effect.scope;
  const normalizerContext =
    yield* Effect.context<Effect.Services<ReturnType<typeof normalizeDispatchCommand>>>();

  const eventLimit = limits.eventLimit ?? STAVE_OPERATION_EVENT_LIMIT;
  const byteLimit = limits.byteLimit ?? STAVE_OPERATION_BYTE_LIMIT;
  const registryByteLimit = limits.registryByteLimit ?? STAVE_REGISTRY_BYTE_LIMIT;
  const retentionMs = Duration.toMillis(limits.retention ?? STAVE_OPERATION_RETENTION);

  const entries = new Map<string, RegistryEntry>();
  /** Ids whose tombstone was reaped; re-running them is refused, never restarted. */
  const expired = new Set<string>();
  let registryBytes = 0;

  yield* Effect.addFinalizer(() =>
    Effect.forEach(entries.values(), (entry) => PubSub.shutdown(entry.pubsub), {
      discard: true,
    }),
  );

  // ── keyed mutex ─────────────────────────────────────────────

  const spaceLock = yield* StaveSpaceLock;
  const runtimeFence = yield* StaveRuntimeFence;
  const withSpaceLock = <A, E, R>(root: string, effect: Effect.Effect<A, E, R>) =>
    runtimeFence.withFence(root, spaceLock.withSpaceLock(root, effect));

  // ── ring buffer ─────────────────────────────────────────────

  const dropOldest = (entry: RegistryEntry): boolean => {
    // The newest event is never evicted: a retained entry must still replay
    // its terminal event, a running one its latest phase.
    if (entry.events.length <= 1) {
      return false;
    }
    const [dropped] = entry.events.splice(0, 1);
    if (dropped !== undefined) {
      entry.bytes -= dropped.bytes;
      registryBytes -= dropped.bytes;
    }
    return true;
  };

  const enforceRegistryLimit = () => {
    while (registryBytes > registryByteLimit) {
      let victim: RegistryEntry | undefined;
      for (const candidate of entries.values()) {
        if (
          candidate.events.length > 1 &&
          (victim === undefined || candidate.lastAccessMs < victim.lastAccessMs)
        ) {
          victim = candidate;
        }
      }
      if (victim === undefined || !dropOldest(victim)) {
        return;
      }
    }
  };

  const append = (entry: RegistryEntry, event: StaveProgressEvent) => {
    const bytes = eventBytes(event);
    entry.events.push({ event, bytes });
    entry.bytes += bytes;
    registryBytes += bytes;
    while ((entry.events.length > eventLimit || entry.bytes > byteLimit) && dropOldest(entry)) {
      // evict until both per-operation bounds hold
    }
    enforceRegistryLimit();
  };

  /** Numbers, buffers and broadcasts one event; atomic so no follower sees a gap. */
  const emit = (
    entry: RegistryEntry,
    build: (base: { operationId: string; sequence: number }) => StaveProgressEvent,
  ) =>
    Effect.uninterruptible(
      Effect.suspend(() => {
        const sequence = entry.nextSequence;
        entry.nextSequence += 1;
        const event = build({ operationId: entry.operationId, sequence });
        append(entry, event);
        return PubSub.publish(entry.pubsub, event);
      }),
    ).pipe(Effect.asVoid);

  // ── retention ───────────────────────────────────────────────

  const reapExpired = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (const entry of entries.values()) {
      if (entry.terminalAtMs !== null && now - entry.terminalAtMs >= retentionMs) {
        entries.delete(entry.operationId);
        expired.add(entry.operationId);
        registryBytes -= entry.bytes;
        yield* PubSub.shutdown(entry.pubsub);
      }
    }
  });

  // ── attach ──────────────────────────────────────────────────

  const attach = (
    entry: RegistryEntry,
    afterSequence: number | undefined,
  ): Stream.Stream<StaveProgressEvent> =>
    Stream.unwrap(
      Effect.gen(function* () {
        entry.lastAccessMs = yield* Clock.currentTimeMillis;
        // Subscribe BEFORE reading the buffer so an event published between
        // the snapshot and the follow is seen exactly once (filtered by sequence).
        const subscription =
          entry.state === "running" ? yield* PubSub.subscribe(entry.pubsub) : null;
        const cursor = afterSequence ?? 0;
        const earliest = earliestSequence(entry);
        const replay: Array<StaveProgressEvent> = [];
        let last = cursor;
        if (cursor + 1 < earliest) {
          // Before the reset the client tracked `cursor`; after it, `earliest - 1`
          // is where the replayed events continue from.
          replay.push({
            operationId: entry.operationId,
            sequence: earliest - 1,
            kind: "reset",
            earliestSequence: earliest,
          });
          last = earliest - 1;
        }
        for (const { event } of entry.events) {
          if (event.sequence > last) {
            replay.push(event);
            last = event.sequence;
          }
        }
        const replayed = Stream.fromIterable(replay);
        const lastReplayed = replay.at(-1);
        if (
          subscription === null ||
          (lastReplayed !== undefined && isTerminalEvent(lastReplayed))
        ) {
          return replayed;
        }
        const floor = last;
        const live = Stream.fromSubscription(subscription).pipe(
          Stream.filter((event) => event.sequence > floor),
          Stream.takeUntil(isTerminalEvent),
        );
        return Stream.concat(replayed, live);
      }),
    );

  // ── phases ──────────────────────────────────────────────────

  const output =
    (entry: RegistryEntry, phase: string, stream: StaveProgressOutputStream) => (text: string) =>
      emit(entry, (base) => ({ ...base, kind: "output", phase, stream, text }));

  const emitNotes = (entry: RegistryEntry, phase: string, notes: ReadonlyArray<string>) =>
    Effect.forEach(notes, output(entry, phase, "notes"), { discard: true });

  /** `phase_started` → body → `phase_finished` (also on failure, so the UI can close the step). */
  const phase = <A, E, R>(
    entry: RegistryEntry,
    name: string,
    commandLine: string | undefined,
    body: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      yield* emit(entry, (base) => ({
        ...base,
        kind: "phase_started",
        phase: name,
        ...(commandLine === undefined ? {} : { commandLine }),
      }));
      const startedAt = yield* Clock.currentTimeMillis;
      return yield* body.pipe(
        Effect.onExit(() =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((endedAt) =>
              emit(entry, (base) => ({
                ...base,
                kind: "phase_finished",
                phase: name,
                durationMs: Math.max(0, endedAt - startedAt),
              })),
            ),
          ),
        ),
      );
    });

  /** Raw lines reach the client only for json-less verbs; `--json` verbs print one document at exit. */
  const streamOptions = (entry: RegistryEntry, verb: StaveVerb): StaveStreamOptions =>
    STAVE_VERB_POLICY[verb].output === "prose" ? { onLine: output(entry, verb, "stdout") } : {};

  /** One Stave invocation as a phase named after its verb; `notes[]` land inside the phase. */
  const invoke = <A>(
    entry: RegistryEntry,
    verb: StaveVerb,
    built: Result.Result<ReadonlyArray<string>, string>,
    call: (stream: StaveStreamOptions) => Effect.Effect<A, StaveError>,
    notesOf: (result: A) => ReadonlyArray<string> = () => [],
  ) =>
    phase(
      entry,
      verb,
      commandLineOf(verb, built),
      call(streamOptions(entry, verb)).pipe(
        Effect.tap((result) => emitNotes(entry, verb, notesOf(result))),
      ),
    );

  /** Notes of a mutation answer, or none when Stave answered with a plan. */
  const notesUnlessPlan = <A extends { readonly notes: ReadonlyArray<string> }>(
    result: A | StaveDryRunPlan,
  ) => (isStaveDryRunPlan(result) ? [] : result.notes);

  // ── shared steps ────────────────────────────────────────────

  const loadRoots = Effect.gen(function* () {
    const snapshot = yield* configReader.load;
    if (!snapshot.exists || snapshot.agentWorkDir === undefined) {
      return yield* refuse(
        "not_setup",
        `Stave is not set up: no config at '${snapshot.configPath}'. Run setup first.`,
        { configPath: snapshot.configPath },
      );
    }
    return { snapshot, agentWorkDir: snapshot.agentWorkDir };
  });

  /** realpath of the path, else of its parent plus basename, else the lexical resolution. */
  const canonicalPath = (target: string) =>
    fileSystem.realPath(target).pipe(
      Effect.catch(() =>
        fileSystem
          .realPath(path.dirname(target))
          .pipe(Effect.map((parent) => path.join(parent, path.basename(target)))),
      ),
      Effect.orElseSucceed(() => path.resolve(target)),
    );

  /** Drop the cached manifest and, when a project sits on the root, refresh its projection. */
  const afterMutation = (root: string) =>
    Effect.gen(function* () {
      yield* workspaceReader.invalidate(root);
      yield* invalidateReads;
      const project = yield* snapshotQuery
        .getActiveProjectByWorkspaceRoot(root)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(project)) {
        return;
      }
      yield* engine
        .dispatch({
          type: "project.refresh",
          commandId: CommandId.make(`server:stave:refresh:${NodeCrypto.randomUUID()}`),
          projectId: project.value.id,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("stave: project.refresh after mutation failed", {
              root,
              cause,
            }),
          ),
        );
    });

  const unexpectedPlan = (verb: StaveVerb) =>
    new StaveError({
      code: "unreadable",
      message: `stave ${verb} answered with a dry-run plan although none was requested`,
      details: null,
      exitCode: 0,
      stderrTail: null,
      verb,
    });

  // ── createSpace ─────────────────────────────────────────────

  const preflightCreateSpace = (
    entry: RegistryEntry,
    operation: StaveCreateSpaceOperation,
    agentWorkDir: string,
    candidate: string,
    bareRepoPathOf: (repo: string) => string | undefined,
  ) =>
    Effect.gen(function* () {
      const note = output(entry, "pre-flight", "notes");
      if (operation.after.length > 0 && operation.saga === undefined) {
        return yield* refuse("invalid_arguments", "`after` requires a saga.");
      }
      // Anything at the exact candidate path, dangling symlinks included:
      // Stave would create inside a manifest-less directory.
      const siblings = yield* fileSystem
        .readDirectory(agentWorkDir)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      if (siblings.includes(operation.spaceId)) {
        return yield* refuse("space_exists", `Something already exists at '${candidate}'.`, {
          spaceId: operation.spaceId,
          path: candidate,
        });
      }
      // A project aliased onto the same physical directory would break the
      // one-lease-per-project assumption; compare realpaths.
      const candidateReal = yield* canonicalPath(candidate);
      const shell = yield* snapshotQuery
        .getShellSnapshot()
        .pipe(Effect.mapError((cause) => refuse("unknown", cause.message)));
      for (const project of shell.projects) {
        const projectReal = yield* canonicalPath(project.workspaceRoot);
        if (projectReal === candidateReal) {
          return yield* refuse(
            "space_exists",
            `Project '${project.title}' already uses '${project.workspaceRoot}'.`,
            {
              spaceId: operation.spaceId,
              projectId: project.id,
              workspaceRoot: project.workspaceRoot,
            },
          );
        }
      }
      // Warnings only: leftover branches from an earlier incarnation, and an
      // archive set that a later `restore` could not pick from.
      for (const edit of operation.edits) {
        const bareRepoPath = bareRepoPathOf(edit.repo);
        if (bareRepoPath === undefined) {
          continue;
        }
        const listed = yield* processRunner
          .run({
            command: "git",
            args: ["-C", bareRepoPath, "branch", "--list", `stave/${operation.spaceId}/*`],
            stdin: "",
          })
          .pipe(
            Effect.map((result) => (result.code === 0 ? result.stdout.trim() : "")),
            Effect.orElseSucceed(() => ""),
          );
        if (listed.length > 0) {
          const branches = listed
            .split("\n")
            .map((line) => line.replace(/^[*+ ]+/, "").trim())
            .filter((line) => line.length > 0);
          yield* note(
            `Repo '${edit.repo}' still has branches from an earlier '${operation.spaceId}' space: ${branches.join(", ")}.`,
          );
        }
      }
      const archives = yield* fileSystem
        .readDirectory(path.join(agentWorkDir, STAVE_ARCHIVE_DIRECTORY_NAME))
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      const matching = archiveEntriesMatching(operation.spaceId, archives);
      if (matching.length >= 2) {
        yield* note(
          `${matching.length} archived spaces match '${operation.spaceId}' (${matching.join(", ")}); a later restore will need --from.`,
        );
      }
    });

  const createProject = (spacePath: string, title: string) =>
    Effect.gen(function* () {
      const projectId = ProjectId.make(NodeCrypto.randomUUID());
      const command = yield* normalizeDispatchCommand({
        type: "project.create",
        commandId: CommandId.make(
          `server:stave:create:${path.basename(spacePath)}:${NodeCrypto.randomUUID()}`,
        ),
        projectId,
        title,
        workspaceRoot: spacePath,
        createWorkspaceRootIfMissing: false,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      }).pipe(Effect.provide(normalizerContext));
      const { sequence } = yield* engine.dispatch(command, { staveReconciliation: true });
      return { projectId, sequence };
    }).pipe(
      Effect.mapError((cause) =>
        refuse("unknown", `The space was created but the project could not be: ${cause.message}`, {
          spacePath,
        }),
      ),
    );

  const uncertainCreation = (
    spaceId: string,
    spacePath: string,
    error: StaveError | StaveRefusalError,
  ) =>
    Effect.gen(function* () {
      yield* workspaceReader.invalidate(spacePath);
      const info = yield* workspaceReader.load(spacePath);
      const exists = yield* fileSystem.exists(spacePath).pipe(Effect.orElseSucceed(() => true));
      if (!exists) return yield* error;
      return yield* refuse(
        error.code,
        `${error.message} A space may remain at '${spacePath}'. Import and review it before removing it; creation ownership could not be verified.`,
        {
          ...error.details,
          uncertainPartialSpace: {
            spaceId,
            spacePath,
            ...(Option.isSome(info) && info.value.createdAt !== undefined
              ? { manifestCreatedAt: info.value.createdAt }
              : {}),
          },
        },
      );
    });

  const runCreateSpace = (entry: RegistryEntry, operation: StaveCreateSpaceOperation) =>
    Effect.gen(function* () {
      const { snapshot, agentWorkDir } = yield* loadRoots;
      const candidate = path.join(agentWorkDir, operation.spaceId);
      const bareRepoPathOf = (repo: string) =>
        snapshot.repos.find((entry) => entry.name === repo)?.bareRepoPath;
      return yield* withRoots(
        [
          candidate,
          ...(operation.saga === undefined ? [] : [path.join(agentWorkDir, operation.saga)]),
        ],
        Effect.gen(function* () {
          yield* phase(
            entry,
            "pre-flight",
            undefined,
            preflightCreateSpace(entry, operation, agentWorkDir, candidate, bareRepoPathOf),
          );

          if (operation.saga !== undefined) {
            const saga = yield* cli.spaceStatus(operation.saga);
            if (saga.manifest.saga === undefined)
              return yield* refuse("invalid_arguments", "The target is not a saga.");
            yield* checkSpace({
              kind: "syncSpace",
              workspaceRoot: path.join(agentWorkDir, operation.saga),
              expectedManifestCreatedAt: saga.manifest.createdAt,
              referencesOnly: false,
            });
          }
          const mutation = yield* Effect.scoped(
            Effect.gen(function* () {
              const input = yield* spaceCreateInput(operation, false);
              const created = yield* invoke(
                entry,
                "space create",
                buildStaveArgv.spaceCreate(input),
                (stream) => cli.spaceCreate(input, stream),
                notesUnlessPlan,
              ).pipe(
                Effect.catch((error) => uncertainCreation(operation.spaceId, candidate, error)),
              );
              if (isStaveDryRunPlan(created)) {
                return yield* unexpectedPlan("space create");
              }
              return created;
            }),
          );
          entry.partialSpace = {
            spaceId: mutation.spaceId,
            spacePath: mutation.spacePath,
            manifestCreatedAt: mutation.manifest.createdAt,
          };

          const status = yield* phase(
            entry,
            "verify",
            commandLineOf("space status", buildStaveArgv.spaceStatus(operation.spaceId)),
            cli.spaceStatus(operation.spaceId),
          );
          if (status.manifest.createdAt !== mutation.manifest.createdAt) {
            return yield* refuse(
              "incarnation_mismatch",
              `The manifest at '${status.spacePath}' was written by another create (${status.manifest.createdAt}).`,
              { expected: mutation.manifest.createdAt, actual: status.manifest.createdAt },
            );
          }
          yield* workspaceReader.invalidate(mutation.spacePath);

          const { projectId, sequence } = yield* phase(
            entry,
            "project.create",
            undefined,
            createProject(mutation.spacePath, operation.title ?? operation.spaceId),
          );
          yield* invalidateReads;
          return {
            kind: "createSpace",
            result: { ...mutation, projectId, sequence },
          } satisfies OperationOutcome;
        }).pipe(
          Effect.ensuring(
            operation.saga === undefined
              ? invalidateReads
              : afterMutation(path.join(agentWorkDir, operation.saga)),
          ),
        ),
      );
    });

  /** The wizard's pasted spec becomes a scoped temp file for `--spec`. */
  const spaceCreateInput = (operation: StaveCreateSpaceOperation, dryRun: boolean) =>
    Effect.gen(function* () {
      let spec = operation.specPath;
      if (operation.specText !== undefined) {
        const specFile = yield* fileSystem.makeTempFileScoped({
          prefix: "stave-spec-",
          suffix: ".md",
        });
        yield* fileSystem.writeFileString(specFile, operation.specText);
        spec = specFile;
      }
      return {
        id: operation.spaceId,
        kind: operation.spaceKind,
        spec,
        edits: operation.edits.map((edit) =>
          edit.base === undefined ? edit.repo : `${edit.repo}:${edit.base}`,
        ),
        references: operation.references.map((reference) =>
          reference.ref === undefined ? reference.repo : `${reference.repo}:${reference.ref}`,
        ),
        memory: operation.memory.map((memory) => memory.spec),
        saga: operation.saga,
        after: operation.after,
        common: operation.common,
        includeWeak: operation.includeWeak,
        noLearn: operation.noLearn,
        dryRun,
      } satisfies StaveSpaceCreateInput;
    }).pipe(
      Effect.mapError((cause) =>
        refuse("unknown", `Could not write the spec file: ${cause.message}`),
      ),
    );

  // ── removePartialSpace ──────────────────────────────────────

  const runRemovePartialSpace = (
    entry: RegistryEntry,
    operation: StaveRemovePartialSpaceOperation,
  ) =>
    Effect.gen(function* () {
      const { agentWorkDir } = yield* loadRoots;
      const root = path.join(agentWorkDir, operation.spaceId);
      yield* workspaceReader.invalidate(root);
      const partialInfo = yield* workspaceReader.load(root);
      if (Option.isSome(partialInfo) && partialInfo.value.isSaga) {
        const status = yield* cli.spaceStatus(operation.spaceId);
        if ((status.manifest.saga?.members.length ?? 0) > 0)
          return yield* refuse(
            "invalid_arguments",
            "This partial saga now has members. Import it and review the full saga teardown before removing it.",
          );
        const outcome = yield* runSagaOperation(
          entry,
          {
            kind: "sagaDestroy",
            sagaRoot: root,
            expectedManifestCreatedAt: operation.expectedManifestCreatedAt,
            force: operation.force === true,
            memory: "destroy",
          },
          false,
        );
        if (outcome.kind !== "sagaDestroy")
          return yield* refuse("unknown", "Partial saga cleanup returned an unexpected result.");
        return {
          kind: "removePartialSpace" as const,
          result: {
            spaceId: operation.spaceId,
            spacePath: root,
            destroyed: true as const,
            memory: "destroy" as const,
            notes: outcome.result.notes,
          },
        };
      }
      const project = yield* snapshotQuery
        .getActiveProjectByWorkspaceRoot(root)
        .pipe(Effect.mapError((cause) => refuse("unknown", cause.message)));
      if (Option.isSome(project)) {
        const outcome = yield* runSpaceOperation(entry, {
          kind: "destroySpace",
          workspaceRoot: root,
          expectedManifestCreatedAt: operation.expectedManifestCreatedAt,
          sagaRemoveConfirmed: operation.sagaRemoveConfirmed,
          force: operation.force === true,
          memory: "destroy",
        });
        if (outcome.kind !== "destroySpace")
          return yield* refuse(
            "unknown",
            "Partial cleanup returned an unexpected operation result.",
          );
        return { kind: "removePartialSpace" as const, result: outcome.result };
      }
      return yield* withSpaceLock(
        path.join(agentWorkDir, operation.spaceId),
        Effect.gen(function* () {
          const status = yield* phase(
            entry,
            "pre-flight",
            commandLineOf("space status", buildStaveArgv.spaceStatus(operation.spaceId)),
            cli.spaceStatus(operation.spaceId),
          );
          if (
            !sameManifestIncarnation(status.manifest.createdAt, operation.expectedManifestCreatedAt)
          ) {
            return yield* refuse(
              "incarnation_mismatch",
              `The space at '${status.spacePath}' is not the one the failed create produced (${status.manifest.createdAt} vs ${operation.expectedManifestCreatedAt}).`,
              { expected: operation.expectedManifestCreatedAt, actual: status.manifest.createdAt },
            );
          }
          const candidate = path.join(agentWorkDir, operation.spaceId);
          if (
            path.resolve(status.spacePath) !== path.resolve(candidate) ||
            (yield* canonicalPath(candidate)) !== path.resolve(candidate)
          )
            return yield* refuse(
              "invalid_arguments",
              "Symlink-aliased partial spaces cannot be removed.",
            );
          const shell = yield* snapshotQuery
            .getShellSnapshot()
            .pipe(Effect.mapError((cause) => refuse("unknown", cause.message)));
          for (const project of shell.projects) {
            if (yield* isPathUnder(candidate, project.workspaceRoot))
              return yield* refuse(
                "nested_project",
                "A project now uses this partial space. Delete it from project settings.",
              );
          }
          const memberships = yield* membership(operation.spaceId, status.manifest.createdAt);
          if (memberships.length > 0 && operation.sagaRemoveConfirmed !== true)
            return yield* refuse(
              "saga_member",
              "Remove this partial space from its saga before destroying it.",
              {
                sagaId: memberships[0]?.sagaId,
                dependentEdges: memberships.flatMap((member) =>
                  member.removedEdges.flatMap((edge) =>
                    edge.after
                      .filter((after) => after === operation.spaceId)
                      .map((after) => ({ memberId: edge.memberId, after })),
                  ),
                ),
                memberships,
              },
            );
          if (
            providers.stopSessionsUnder === undefined ||
            terminals.closeSessionsUnder === undefined
          )
            return yield* refuse("unknown", "Session quiescence is unavailable.");
          yield* providers
            .stopSessionsUnder(candidate)
            .pipe(Effect.mapError((cause) => refuse("unknown", cause.message)));
          yield* terminals
            .closeSessionsUnder(candidate)
            .pipe(Effect.mapError((cause) => refuse("unknown", cause.message)));
          entry.partialCleanupEdges = memberships.length > 0 ? memberships : null;
          for (const member of memberships) {
            const removal = { sagaId: member.sagaId, spaceId: operation.spaceId };
            yield* invoke(
              entry,
              "saga remove",
              buildStaveArgv.sagaRemove(removal),
              (stream) => cli.sagaRemove(removal, stream),
              notesUnlessPlan,
            ).pipe(Effect.ensuring(afterMutation(member.sagaRoot)));
          }
          const input = {
            id: operation.spaceId,
            force: operation.force === true,
            memory: "destroy" as const,
          };
          const destroyed = yield* invoke(
            entry,
            "space destroy",
            buildStaveArgv.spaceDestroy(input),
            (stream) => cli.spaceDestroy(input, stream),
            notesUnlessPlan,
          ).pipe(Effect.ensuring(afterMutation(status.spacePath)));
          if (isStaveDryRunPlan(destroyed)) {
            return yield* unexpectedPlan("space destroy");
          }
          return { kind: "removePartialSpace", result: destroyed } satisfies OperationOutcome;
        }),
      );
    });

  // ── setup / registerRepo ────────────────────────────────────

  const runSetup = (entry: RegistryEntry, operation: StaveSetupOperation) =>
    Effect.gen(function* () {
      const snapshot = yield* configReader.load;
      return yield* withSpaceLock(
        snapshot.configPath,
        Effect.gen(function* () {
          const input = { force: operation.force };
          const result = yield* invoke(entry, "setup", buildStaveArgv.setup(input), (stream) =>
            cli.setup(input, stream),
          );
          yield* configReader.invalidate;
          return { kind: "setup", result } satisfies OperationOutcome;
        }),
      );
    });

  const runRegisterRepo = (entry: RegistryEntry, operation: StaveRegisterRepoOperation) =>
    Effect.gen(function* () {
      const snapshot = yield* configReader.load;
      return yield* withSpaceLock(
        snapshot.configPath,
        Effect.gen(function* () {
          const input = { name: operation.name, url: operation.url, adopt: operation.adopt };
          const result = yield* invoke(
            entry,
            "repos add",
            buildStaveArgv.reposAdd({ ...input, url: redactUrl(operation.url) }),
            (stream) => cli.reposAdd(input, stream),
            notesUnlessPlan,
          );
          if (isStaveDryRunPlan(result)) {
            return yield* unexpectedPlan("repos add");
          }
          yield* configReader.invalidate;
          return { kind: "registerRepo", result } satisfies OperationOutcome;
        }),
      );
    });

  // ── space edits and durable lifecycle ──────────────────────

  type SpaceOperation = Exclude<
    Extract<StaveOperation, { workspaceRoot: string }>,
    StaveLifecycleActionOperation
  >;
  const asRefusal = (cause: { readonly message: string }) => refuse("unknown", cause.message);
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const freshInfo = (root: string) =>
    Effect.gen(function* () {
      yield* workspaceReader.invalidate(root);
      const info = yield* workspaceReader.load(root);
      if (Option.isNone(info))
        return yield* refuse("unreadable", `Cannot read the Stave manifest at '${root}'.`);
      return info.value;
    });
  const checkSpace = (operation: SpaceOperation) =>
    Effect.gen(function* () {
      const info = yield* freshInfo(operation.workspaceRoot);
      if (
        operation.expectedManifestCreatedAt === undefined ||
        info.createdAt === undefined ||
        !sameManifestIncarnation(info.createdAt, operation.expectedManifestCreatedAt)
      ) {
        return yield* refuse(
          "incarnation_mismatch",
          "The space incarnation changed or was not supplied. Refresh the project before trying again.",
        );
      }
      if (operation.kind === "archiveSpace" && info.state !== "live")
        return yield* refuse(
          "archived_project",
          "Only a live space can be archived. Restore this archive first.",
        );
      const { agentWorkDir } = yield* loadRoots;
      const expected =
        info.state === "archived"
          ? path.join(agentWorkDir, STAVE_ARCHIVE_DIRECTORY_NAME, info.archiveBasename ?? "")
          : path.join(agentWorkDir, info.spaceId);
      if (
        path.resolve(operation.workspaceRoot) !== path.resolve(expected) ||
        (yield* canonicalPath(operation.workspaceRoot)) !== path.resolve(operation.workspaceRoot)
      ) {
        return yield* refuse(
          "invalid_arguments",
          "Symlink-aliased or noncanonical space roots cannot be mutated.",
        );
      }
      const shell = yield* snapshotQuery.getShellSnapshot().pipe(Effect.mapError(asRefusal));
      for (const project of shell.projects) {
        if (
          project.workspaceRoot !== operation.workspaceRoot &&
          (yield* canonicalPath(project.workspaceRoot)) ===
            (yield* canonicalPath(operation.workspaceRoot))
        ) {
          return yield* refuse("invalid_arguments", "Another project aliases this physical space.");
        }
      }
      return info;
    });

  const membership = (spaceId: string, stamp: string) =>
    Effect.gen(function* () {
      const sagas = yield* cli.sagaList.pipe(
        Effect.mapError(() => refuse("membership_unknown", "Saga membership could not be read.")),
      );
      const found: Array<{
        sagaId: string;
        sagaRoot: string;
        removedEdges: Array<{ memberId: string; after: ReadonlyArray<string> }>;
      }> = [];
      for (const saga of sagas) {
        if (saga.error !== undefined)
          return yield* refuse(
            "membership_unknown",
            "A saga manifest is unreadable; membership cannot be established.",
          );
        if (!saga.isSaga) continue;
        const status = yield* cli
          .spaceStatus(saga.logicalId ?? saga.id)
          .pipe(
            Effect.mapError(() => refuse("membership_unknown", `Cannot read saga '${saga.id}'.`)),
          );
        const members = status.manifest.saga?.members ?? [];
        if (
          members.some(
            (member) =>
              member.id === spaceId &&
              (member.createdAt === undefined || sameManifestIncarnation(member.createdAt, stamp)),
          )
        ) {
          found.push({
            sagaId: status.spaceId,
            sagaRoot: saga.path,
            removedEdges: members
              .filter((member) => member.id === spaceId || member.after.includes(spaceId))
              .map((member) => ({ memberId: member.id, after: member.after })),
          });
        }
      }
      return found;
    });

  const deleteProject = (projectId: ProjectId) =>
    engine
      .dispatch({
        type: "project.delete",
        commandId: CommandId.make(`server:stave:delete:${NodeCrypto.randomUUID()}`),
        projectId,
        force: true,
      })
      .pipe(Effect.mapError(asRefusal), Effect.asVoid);

  type LifecycleRow = StaveLifecycleRow;
  const reconcileRow = (row: LifecycleRow) =>
    Effect.gen(function* () {
      const active = yield* snapshotQuery
        .getProjectShellById(row.projectId)
        .pipe(Effect.mapError(asRefusal));
      if (Option.isSome(active) && active.value.workspaceRoot !== row.workspaceRoot) {
        // A transition may have committed its path update before its final journal write.
        const currentInfo = yield* workspaceReader.load(active.value.workspaceRoot);
        if (
          Option.isNone(currentInfo) ||
          currentInfo.value.spaceId !== row.spaceId ||
          currentInfo.value.createdAt === undefined ||
          row.manifestCreatedAt === null ||
          !sameManifestIncarnation(currentInfo.value.createdAt, row.manifestCreatedAt)
        )
          return yield* refuse(
            "incarnation_mismatch",
            "The project now belongs to another workspace. Recovery will not change it.",
          );
      }
      if (row.disposition === "destroyed") {
        if (Option.isSome(active) && active.value.id === row.projectId)
          yield* deleteProject(row.projectId);
        return { disposition: "destroyed" as const, workspaceRoot: row.workspaceRoot };
      }
      // An empty inventory is only evidence about the captured installation.
      // A durable row from another configuration must remain repairable.
      const { agentWorkDir } = yield* loadRoots;
      const liveParent = yield* canonicalPath(agentWorkDir);
      const archiveParent = yield* canonicalPath(
        path.join(agentWorkDir, STAVE_ARCHIVE_DIRECTORY_NAME),
      );
      const rowParent = yield* canonicalPath(path.dirname(row.workspaceRoot));
      if (rowParent !== liveParent && rowParent !== archiveParent)
        return yield* refuse(
          "invalid_arguments",
          "This lifecycle record belongs to another Stave configuration. Select its configuration before retrying recovery.",
        );
      const live = yield* cli.spaceList({});
      const archives = yield* cli.spaceList({ archived: true });
      const matches: Array<{ root: string; archived: boolean; basename: string | null }> = [];
      for (const item of [...live, ...archives]) {
        if (item.error !== undefined)
          return yield* refuse(
            "unreadable",
            "A space manifest is unreadable; lifecycle reconciliation needs repair.",
          );
        const info = yield* freshInfo(item.path);
        if (
          info.spaceId === row.spaceId &&
          info.createdAt !== undefined &&
          row.manifestCreatedAt !== null &&
          sameManifestIncarnation(info.createdAt, row.manifestCreatedAt)
        ) {
          matches.push({
            root: item.path,
            archived: info.state === "archived",
            basename: info.archiveBasename ?? null,
          });
        }
      }
      if (matches.length > 1)
        return yield* refuse(
          "ambiguous_archive",
          "More than one root has this space incarnation; repair the duplicate before retrying.",
        );
      const match = matches[0];
      if (match === undefined) {
        if (row.ownerToken !== null) {
          const terminal = yield* lifecycle
            .updateDisposition({
              projectId: row.projectId,
              leaseEpoch: row.leaseEpoch,
              ownerToken: row.ownerToken,
              now: yield* nowIso,
              patch: { disposition: "destroyed" },
            })
            .pipe(Effect.mapError(asRefusal));
          if (!terminal)
            return yield* refuse("space_transitioning", "The lifecycle lease was lost.");
        }
        if (Option.isSome(active) && active.value.id === row.projectId)
          yield* deleteProject(row.projectId);
        return { disposition: "destroyed" as const, workspaceRoot: row.workspaceRoot };
      }
      if (
        Option.isSome(active) &&
        active.value.id === row.projectId &&
        active.value.workspaceRoot !== match.root
      ) {
        const workspaceRoot = yield* workspacePaths
          .normalizeWorkspaceRoot(match.root)
          .pipe(Effect.mapError(asRefusal));
        yield* engine
          .dispatch(
            {
              type: "project.meta.update",
              commandId: CommandId.make(`server:stave:retarget:${NodeCrypto.randomUUID()}`),
              projectId: row.projectId,
              workspaceRoot,
            },
            { staveReconciliation: true },
          )
          .pipe(Effect.mapError(asRefusal));
      }
      if (row.disposition === "restoring" && !match.archived && row.ownerToken !== null) {
        const reset = yield* lifecycle
          .resetScheduleEpisode({
            projectId: row.projectId,
            leaseEpoch: row.leaseEpoch,
            ownerToken: row.ownerToken,
            now: yield* nowIso,
            anchorAt: null,
            scheduledAt: null,
            archiveDeadlineAt: null,
            disposition: "live",
          })
          .pipe(Effect.mapError(asRefusal));
        if (!reset)
          return yield* refuse("space_transitioning", "The restore recovery lease was lost.");
      }
      yield* afterMutation(match.root);
      return {
        disposition: match.archived ? ("archived" as const) : ("live" as const),
        workspaceRoot: match.root,
        archiveBasename: match.basename,
      };
    });

  const withSpaceOperationLocks = <A, E, R>(
    operation: SpaceOperation,
    body: (roots: ReadonlyArray<string>) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const roots = [operation.workspaceRoot];
      if (operation.kind === "restoreSpace") {
        const info = yield* freshInfo(operation.workspaceRoot);
        const { agentWorkDir } = yield* loadRoots;
        roots.push(path.join(agentWorkDir, info.spaceId));
      }
      return yield* withRoots(roots, body(roots));
    });

  const runSpaceOperation = (
    entry: RegistryEntry,
    operation: SpaceOperation,
    durableTarget?: LifecycleRow,
    revalidate: Effect.Effect<void, StaveError | StaveRefusalError> = Effect.void,
  ): Effect.Effect<OperationOutcome, StaveError | StaveRefusalError> =>
    withSpaceOperationLocks(operation, (mutationRoots) =>
      Effect.gen(function* () {
        const info = yield* checkSpace(operation);
        const id = info.spaceId;
        if (operation.kind === "restoreSpace") {
          const { agentWorkDir } = yield* loadRoots;
          if (path.resolve(path.join(agentWorkDir, id)) !== path.resolve(mutationRoots[1]!))
            return yield* refuse(
              "incarnation_mismatch",
              "The restore destination changed while acquiring its locks. Refresh the project before trying again.",
            );
          if (info.state !== "archived" || operation.from !== info.archiveBasename)
            return yield* refuse(
              "incarnation_mismatch",
              "The selected archive no longer matches this project.",
            );
          if (yield* fileSystem.exists(mutationRoots[1]!).pipe(Effect.mapError(asRefusal)))
            return yield* refuse(
              "space_exists",
              "The live destination already exists. Resolve it before restoring this archive.",
            );
        }
        if (info.isSaga && (operation.kind === "archiveSpace" || operation.kind === "destroySpace"))
          return yield* refuse(
            "saga_space",
            "Use Archive saga or Destroy saga to review all member spaces.",
          );
        const isLifecycle =
          operation.kind === "archiveSpace" ||
          operation.kind === "destroySpace" ||
          operation.kind === "restoreSpace";
        if (!isLifecycle && info.state !== "live")
          return yield* refuse("archived_project", "Restore this space before editing it.");
        const project = yield* snapshotQuery
          .getActiveProjectByWorkspaceRoot(operation.workspaceRoot)
          .pipe(Effect.mapError(asRefusal));
        let lease: LifecycleRow | undefined;
        let removedEdges: unknown = null;
        if (isLifecycle) {
          if (Option.isNone(project) && durableTarget === undefined)
            return yield* refuse(
              "invalid_arguments",
              "Lifecycle operations require an active project.",
            );
          const projectId = durableTarget?.projectId ?? Option.getOrThrow(project).id;
          if (
            durableTarget !== undefined &&
            Option.isSome(project) &&
            project.value.id !== projectId
          )
            return yield* refuse("incarnation_mismatch", "Another project now owns this root.");
          const shell = yield* snapshotQuery.getShellSnapshot().pipe(Effect.mapError(asRefusal));
          for (const other of shell.projects) {
            if (
              other.id !== projectId &&
              (yield* Effect.findFirst(mutationRoots, (root) =>
                isPathUnder(root, other.workspaceRoot),
              ).pipe(Effect.map(Option.isSome)))
            )
              return yield* refuse(
                "nested_project",
                `Project '${other.title}' is nested inside this space.`,
              );
          }
          const now = yield* nowIso;
          const row = yield* lifecycle
            .ensure({
              projectId,
              workspaceRoot: operation.workspaceRoot,
              spaceId: id,
              manifestCreatedAt: info.createdAt ?? null,
              now,
            })
            .pipe(Effect.mapError(asRefusal));
          if (
            (row.spaceId !== null && row.spaceId !== id) ||
            (row.manifestCreatedAt !== null &&
              info.createdAt !== undefined &&
              !sameManifestIncarnation(row.manifestCreatedAt, info.createdAt))
          )
            return yield* refuse(
              "incarnation_mismatch",
              "The lifecycle record belongs to an earlier incarnation. Re-import the recreated space.",
            );
          const acquired = yield* lifecycle
            .acquireLease({
              projectId: row.projectId,
              expectedEpoch: row.leaseEpoch,
              ownerToken: entry.operationId,
              now,
              leaseUntil: DateTime.formatIso(
                DateTime.add(DateTime.makeUnsafe(now), { minutes: 1 }),
              ),
            })
            .pipe(Effect.mapError(asRefusal));
          if (Option.isNone(acquired))
            return yield* refuse(
              "space_transitioning",
              "Another lifecycle operation owns this space.",
            );
          lease = acquired.value;
        }
        const patch = (changes: Parameters<typeof lifecycle.updateDisposition>[0]["patch"]) =>
          lease === undefined
            ? Effect.void
            : Effect.gen(function* () {
                const updated = yield* lifecycle
                  .updateDisposition({
                    projectId: lease!.projectId,
                    leaseEpoch: lease!.leaseEpoch,
                    ownerToken: entry.operationId,
                    now: yield* nowIso,
                    patch: changes,
                  })
                  .pipe(Effect.mapError(asRefusal));
                if (!updated)
                  return yield* refuse("space_transitioning", "The lifecycle lease was lost.");
              });
        const body = Effect.gen(function* () {
          yield* revalidate;
          if (isLifecycle || operation.kind === "memoryDetach") {
            if (isLifecycle)
              yield* patch({
                disposition:
                  operation.kind === "archiveSpace"
                    ? "archiving"
                    : operation.kind === "restoreSpace"
                      ? "restoring"
                      : "destroying",
                archiveBasename: info.archiveBasename ?? null,
              });
            if (isLifecycle && lease !== undefined)
              lease = {
                ...lease,
                disposition:
                  operation.kind === "archiveSpace"
                    ? "archiving"
                    : operation.kind === "restoreSpace"
                      ? "restoring"
                      : "destroying",
              };
            if (operation.kind === "destroySpace" && info.state === "archived")
              return yield* refuse(
                "archived_project",
                "Restore the archive before explicitly destroying it.",
              );
            const shell = yield* snapshotQuery.getShellSnapshot().pipe(Effect.mapError(asRefusal));
            const ownThreads = shell.threads.filter(
              (thread) => Option.isSome(project) && thread.projectId === project.value.id,
            );
            for (const thread of ownThreads) {
              if (thread.session?.activeTurnId != null) {
                const command = yield* normalizeDispatchCommand({
                  type: "thread.turn.interrupt",
                  commandId: CommandId.make(`server:stave:interrupt:${NodeCrypto.randomUUID()}`),
                  threadId: thread.id,
                  createdAt: yield* nowIso,
                }).pipe(Effect.provide(normalizerContext), Effect.mapError(asRefusal));
                yield* engine.dispatch(command).pipe(Effect.mapError(asRefusal));
              }
            }
            const sessions = yield* providers.listSessions();
            for (const session of sessions) {
              if (
                !ownThreads.some((thread) => thread.id === session.threadId) &&
                session.cwd !== undefined &&
                (yield* Effect.findFirst(mutationRoots, (root) =>
                  isPathUnder(root, session.cwd!),
                ).pipe(Effect.map(Option.isSome))) &&
                session.activeTurnId !== undefined &&
                session.activeTurnId !== null
              ) {
                const command = yield* normalizeDispatchCommand({
                  type: "thread.turn.interrupt",
                  commandId: CommandId.make(`server:stave:interrupt:${NodeCrypto.randomUUID()}`),
                  threadId: session.threadId,
                  createdAt: yield* nowIso,
                }).pipe(Effect.provide(normalizerContext), Effect.mapError(asRefusal));
                yield* engine.dispatch(command).pipe(Effect.mapError(asRefusal));
              }
            }
            if (
              providers.stopSessionsUnder === undefined ||
              terminals.closeSessionsUnder === undefined
            )
              return yield* refuse("unknown", "Session quiescence is unavailable.");
            for (const session of sessions) {
              if (
                session.cwd === undefined &&
                ownThreads.some((thread) => thread.id === session.threadId)
              )
                yield* providers
                  .stopSession({ threadId: session.threadId })
                  .pipe(Effect.mapError(asRefusal));
            }
            for (const root of mutationRoots) {
              yield* providers.stopSessionsUnder(root).pipe(Effect.mapError(asRefusal));
              yield* terminals.closeSessionsUnder(root).pipe(Effect.mapError(asRefusal));
            }
          }
          yield* revalidate;
          let outcome: OperationOutcome;
          switch (operation.kind) {
            case "addRepo": {
              const input = { ...operation, id };
              const result = yield* invoke(
                entry,
                "space add",
                buildStaveArgv.spaceAdd(input),
                (stream) => cli.spaceAdd(input, stream),
                notesUnlessPlan,
              );
              if (isStaveDryRunPlan(result)) return yield* unexpectedPlan("space add");
              outcome = { kind: operation.kind, result };
              break;
            }
            case "removeRepo": {
              const input = { ...operation, id };
              const result = yield* invoke(
                entry,
                "space remove",
                buildStaveArgv.spaceRemove(input),
                (stream) => cli.spaceRemove(input, stream),
                notesUnlessPlan,
              );
              if (isStaveDryRunPlan(result)) return yield* unexpectedPlan("space remove");
              outcome = { kind: operation.kind, result };
              break;
            }
            case "retarget": {
              const input = { ...operation, id };
              const result = yield* invoke(
                entry,
                "space retarget",
                buildStaveArgv.spaceRetarget(input),
                (stream) => cli.spaceRetarget(input, stream),
                notesUnlessPlan,
              );
              if (isStaveDryRunPlan(result)) return yield* unexpectedPlan("space retarget");
              outcome = { kind: operation.kind, result };
              break;
            }
            case "syncSpace": {
              const input = { ...operation, id };
              const result = yield* invoke(
                entry,
                "space sync",
                buildStaveArgv.spaceSync(input),
                (stream) => cli.spaceSync(input, stream),
                notesUnlessPlan,
              );
              yield* cli.spaceStatus(id);
              outcome = { kind: operation.kind, result };
              break;
            }
            case "archiveSpace": {
              const input = { ...operation, id };
              const result = yield* invoke(
                entry,
                "space archive",
                buildStaveArgv.spaceArchive(input),
                (stream) => cli.spaceArchive(input, stream),
                notesUnlessPlan,
              );
              if (isStaveDryRunPlan(result)) return yield* unexpectedPlan("space archive");
              const archivedRoot = yield* workspacePaths
                .normalizeWorkspaceRoot(result.archivedPath)
                .pipe(Effect.mapError(asRefusal));
              if (lease !== undefined) {
                if (Option.isSome(project))
                  yield* engine
                    .dispatch(
                      {
                        type: "project.meta.update",
                        commandId: CommandId.make(
                          `server:stave:archive:${NodeCrypto.randomUUID()}`,
                        ),
                        projectId: lease.projectId,
                        workspaceRoot: archivedRoot,
                      },
                      { staveReconciliation: true },
                    )
                    .pipe(Effect.mapError(asRefusal));
                yield* patch({
                  workspaceRoot: archivedRoot,
                  archiveBasename: path.basename(archivedRoot),
                });
                lease = {
                  ...lease,
                  workspaceRoot: archivedRoot,
                  archiveBasename: path.basename(archivedRoot),
                };
                yield* afterMutation(archivedRoot);
              }
              outcome = { kind: operation.kind, result };
              break;
            }
            case "restoreSpace": {
              if (operation.from !== info.archiveBasename)
                return yield* refuse(
                  "incarnation_mismatch",
                  "The selected archive no longer matches this project.",
                );
              const input = { ...operation, id };
              const result = yield* invoke(
                entry,
                "space restore",
                buildStaveArgv.spaceRestore(input),
                (stream) => cli.spaceRestore(input, stream),
                notesUnlessPlan,
              );
              if (isStaveDryRunPlan(result)) return yield* unexpectedPlan("space restore");
              outcome = { kind: operation.kind, result };
              break;
            }
            case "destroySpace": {
              const memberships = yield* membership(id, info.createdAt!);
              if (memberships.length > 0 && operation.sagaRemoveConfirmed !== true)
                return yield* refuse(
                  "saga_member",
                  "Deleting this space also removes its saga membership and dependent ordering edges. Confirm that combined action.",
                  {
                    sagaId: memberships[0]?.sagaId,
                    dependentEdges: memberships.flatMap((member) =>
                      member.removedEdges.flatMap((edge) =>
                        edge.after
                          .filter((after) => after === id)
                          .map((after) => ({ memberId: edge.memberId, after })),
                      ),
                    ),
                    memberships,
                  },
                );
              removedEdges = memberships;
              if (memberships.length > 0)
                yield* patch({ refusalMessage: stableStringify({ removedEdges: memberships }) });
              for (const member of memberships) {
                const input = { sagaId: member.sagaId, spaceId: id };
                yield* invoke(
                  entry,
                  "saga remove",
                  buildStaveArgv.sagaRemove(input),
                  (stream) => cli.sagaRemove(input, stream),
                  notesUnlessPlan,
                ).pipe(Effect.ensuring(afterMutation(member.sagaRoot)));
              }
              const input = { ...operation, id };
              const result = yield* invoke(
                entry,
                "space destroy",
                buildStaveArgv.spaceDestroy(input),
                (stream) => cli.spaceDestroy(input, stream),
                notesUnlessPlan,
              );
              if (isStaveDryRunPlan(result)) return yield* unexpectedPlan("space destroy");
              yield* patch({ disposition: "destroyed" });
              if (Option.isSome(project)) yield* deleteProject(project.value.id);
              outcome = { kind: operation.kind, result };
              break;
            }
            case "memoryAttach": {
              let result: StaveMemoryAttachResult | undefined;
              for (const spec of operation.specs) {
                const separator = spec.spec.indexOf(":");
                const provider = separator >= 0 ? spec.spec.slice(0, separator) : undefined;
                const value = separator >= 0 ? spec.spec.slice(separator + 1) : spec.spec;
                const input = {
                  id,
                  provider,
                  use: value === "." ? undefined : value,
                  edit: [],
                  link: [],
                  opt: [],
                };
                const attached = yield* invoke(
                  entry,
                  "memory attach",
                  buildStaveArgv.memoryAttach(input),
                  (stream) => cli.memoryAttach(input, stream),
                  notesUnlessPlan,
                );
                if (isStaveDryRunPlan(attached)) return yield* unexpectedPlan("memory attach");
                result =
                  result === undefined
                    ? attached
                    : {
                        ...attached,
                        attachments: [...result.attachments, ...attached.attachments],
                        notes: [...result.notes, ...attached.notes],
                      };
              }
              if (result === undefined)
                return yield* refuse("invalid_arguments", "Select at least one memory store.");
              outcome = { kind: operation.kind, result };
              break;
            }
            case "memoryDetach": {
              const input = { ...operation, id };
              const result = yield* invoke(
                entry,
                "memory detach",
                buildStaveArgv.memoryDetach(input),
                (stream) => cli.memoryDetach(input, stream),
                notesUnlessPlan,
              );
              if (isStaveDryRunPlan(result)) return yield* unexpectedPlan("memory detach");
              outcome = { kind: operation.kind, result };
              break;
            }
          }
          if (lease !== undefined && operation.kind !== "destroySpace") {
            yield* patch(yield* reconcileRow(lease));
          }
          return outcome;
        });
        const renewLease = Effect.forever(
          Effect.gen(function* () {
            yield* Effect.sleep(Duration.seconds(20));
            if (lease === undefined) return;
            const now = yield* nowIso;
            const renewed = yield* lifecycle
              .renewLease({
                projectId: lease.projectId,
                leaseEpoch: lease.leaseEpoch,
                ownerToken: entry.operationId,
                now,
                leaseUntil: DateTime.formatIso(
                  DateTime.add(DateTime.makeUnsafe(now), { minutes: 1 }),
                ),
              })
              .pipe(Effect.mapError(asRefusal));
            if (!renewed)
              return yield* refuse(
                "space_transitioning",
                "The lifecycle lease was lost; the operation was stopped.",
              );
          }),
        );
        const recoverableBody = body.pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              if (Cause.hasInterruptsOnly(cause)) return yield* Effect.failCause(cause);
              const error = toOperationError(cause);
              if (lease !== undefined) {
                const reconciled = yield* reconcileRow(lease).pipe(Effect.option);
                if (Option.isSome(reconciled)) yield* patch(reconciled.value);
                yield* patch({
                  ...(Option.isSome(reconciled) && reconciled.value.disposition === "destroyed"
                    ? {}
                    : { disposition: "refused" as const }),
                  refusalCode: error.code,
                  refusalMessage: stableStringify({ message: error.message, removedEdges }),
                });
              }
              if (removedEdges !== null)
                return yield* refuse(error.code, error.message, { ...error.details, removedEdges });
              return yield* Effect.failCause(cause);
            }),
          ),
        );
        return yield* (
          lease === undefined ? recoverableBody : Effect.raceFirst(recoverableBody, renewLease)
        ).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* afterMutation(operation.workspaceRoot);
              if (lease !== undefined)
                yield* lifecycle
                  .releaseLease({
                    projectId: lease.projectId,
                    leaseEpoch: lease.leaseEpoch,
                    ownerToken: entry.operationId,
                    now: yield* nowIso,
                  })
                  .pipe(Effect.ignore);
            }),
          ),
        );
      }),
    );

  const withRecoveryLocks = <A, E, R>(row: LifecycleRow, body: Effect.Effect<A, E, R>) =>
    row.disposition === "restoring" && row.spaceId !== null
      ? loadRoots.pipe(
          Effect.flatMap(({ agentWorkDir }) =>
            withRoots([row.workspaceRoot, path.join(agentWorkDir, row.spaceId!)], body),
          ),
        )
      : withSpaceLock(row.workspaceRoot, body);

  const reconcileIncomplete = Effect.gen(function* () {
    const rows = yield* lifecycle.listIncomplete().pipe(Effect.mapError(asRefusal));
    for (const row of rows) {
      const reconcile = withRecoveryLocks(
        row,
        Effect.gen(function* () {
          if (row.ownerToken !== null && row.leaseUntil !== null) {
            const remaining = Date.parse(row.leaseUntil) - (yield* Clock.currentTimeMillis);
            if (remaining > 0) return;
          }
          const now = yield* nowIso;
          const ownerToken = `startup:${NodeCrypto.randomUUID()}`;
          const acquired = yield* lifecycle
            .acquireLease({
              projectId: row.projectId,
              expectedEpoch: row.leaseEpoch,
              ownerToken,
              now,
              leaseUntil: DateTime.formatIso(
                DateTime.add(DateTime.makeUnsafe(now), { minutes: 1 }),
              ),
            })
            .pipe(Effect.mapError(asRefusal));
          if (Option.isNone(acquired)) return;
          const current = acquired.value;
          const recover = Effect.gen(function* () {
            const reconciled = yield* reconcileRow(current).pipe(
              Effect.catch((error) =>
                Effect.succeed({
                  disposition: "refused" as const,
                  refusalCode: error.code,
                  refusalMessage: error.message,
                }),
              ),
            );
            const patched = yield* lifecycle
              .updateDisposition({
                projectId: row.projectId,
                leaseEpoch: current.leaseEpoch,
                ownerToken,
                now: yield* nowIso,
                patch: reconciled,
              })
              .pipe(Effect.mapError(asRefusal));
            if (!patched)
              return yield* refuse("space_transitioning", "Startup reconciliation lost its lease.");
          });
          const renewal = Effect.forever(
            Effect.gen(function* () {
              yield* Effect.sleep(Duration.seconds(20));
              const now = yield* nowIso;
              const renewed = yield* lifecycle
                .renewLease({
                  projectId: row.projectId,
                  leaseEpoch: current.leaseEpoch,
                  ownerToken,
                  now,
                  leaseUntil: DateTime.formatIso(
                    DateTime.add(DateTime.makeUnsafe(now), { minutes: 1 }),
                  ),
                })
                .pipe(Effect.mapError(asRefusal));
              if (!renewed)
                return yield* refuse(
                  "space_transitioning",
                  "Startup reconciliation lost its lease.",
                );
            }),
          );
          yield* Effect.raceFirst(recover, renewal).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                yield* lifecycle
                  .releaseLease({
                    projectId: row.projectId,
                    leaseEpoch: current.leaseEpoch,
                    ownerToken,
                    now: yield* nowIso,
                  })
                  .pipe(Effect.ignore);
              }),
            ),
          );
        }),
      );
      yield* (
        row.disposition === "destroyed" ? reconcile : execution.withExecution(reconcile)
      ).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Stave recovery will retry this row", {
            projectId: row.projectId,
            message: error.message,
          }),
        ),
      );
    }
  });

  // ── dispatch ────────────────────────────────────────────────

  // Saga participant discovery is repeated after acquiring the complete lock set.
  // A roster edit racing the first read therefore refuses before any mutation.
  type SagaOperation = Extract<StaveOperation, { sagaRoot: string }>;
  const withRoots = <A, E, R>(roots: ReadonlyArray<string>, body: Effect.Effect<A, E, R>) =>
    Effect.forEach(roots, canonicalPath).pipe(
      Effect.flatMap((canonical) =>
        [...new Set(canonical)].sort().reduceRight((next, root) => withSpaceLock(root, next), body),
      ),
    );

  const sagaCreateInput = (operation: StaveCreateSagaOperation, dryRun: boolean) =>
    Effect.gen(function* () {
      let spec: string | undefined;
      if (operation.specText !== undefined) {
        spec = yield* fileSystem.makeTempFileScoped({ prefix: "stave-saga-spec-", suffix: ".md" });
        yield* fileSystem.writeFileString(spec, operation.specText);
      }
      return {
        id: operation.sagaId,
        spec,
        dryRun,
        references: operation.references.map((ref) =>
          ref.ref === undefined ? ref.repo : `${ref.repo}:${ref.ref}`,
        ),
        memory: operation.memory.map((memory) => memory.spec),
      };
    }).pipe(Effect.mapError(asRefusal));

  const runCreateSaga = (entry: RegistryEntry, operation: StaveCreateSagaOperation) =>
    Effect.gen(function* () {
      const { agentWorkDir } = yield* loadRoots;
      const root = path.join(agentWorkDir, operation.sagaId);
      return yield* withSpaceLock(
        root,
        Effect.gen(function* () {
          const siblings = yield* fileSystem
            .readDirectory(agentWorkDir)
            .pipe(Effect.mapError(asRefusal));
          if (siblings.includes(operation.sagaId))
            return yield* refuse("space_exists", "The saga root already exists.");
          if ((yield* canonicalPath(root)) !== path.resolve(root))
            return yield* refuse(
              "invalid_arguments",
              "Symlink-aliased saga roots cannot be created.",
            );
          const shell = yield* snapshotQuery.getShellSnapshot().pipe(Effect.mapError(asRefusal));
          for (const project of shell.projects) {
            if ((yield* canonicalPath(project.workspaceRoot)) === root)
              return yield* refuse("space_exists", "A project already uses the saga root.");
          }
          const created = yield* Effect.scoped(
            Effect.gen(function* () {
              const input = yield* sagaCreateInput(operation, false);
              return yield* invoke(
                entry,
                "saga create",
                buildStaveArgv.sagaCreate(input),
                (stream) => cli.sagaCreate(input, stream),
                notesUnlessPlan,
              ).pipe(Effect.catch((error) => uncertainCreation(operation.sagaId, root, error)));
            }),
          );
          if (isStaveDryRunPlan(created)) return yield* unexpectedPlan("saga create");
          entry.partialSpace = {
            spaceId: created.sagaId,
            spacePath: created.spacePath,
            manifestCreatedAt: created.manifest.createdAt,
          };
          const verified = yield* cli.spaceStatus(operation.sagaId);
          if (
            created.sagaId !== operation.sagaId ||
            verified.spaceId !== operation.sagaId ||
            path.resolve(created.spacePath) !== root ||
            path.resolve(verified.spacePath) !== root ||
            verified.manifest.kind !== "saga" ||
            !sameManifestIncarnation(created.manifest.createdAt, verified.manifest.createdAt)
          )
            return yield* refuse(
              "incarnation_mismatch",
              "The created saga manifest changed before verification.",
            );
          yield* workspaceReader.invalidate(root);
          const project = yield* phase(
            entry,
            "project.create",
            undefined,
            createProject(root, operation.title ?? operation.sagaId),
          );
          yield* invalidateReads;
          return {
            kind: "createSaga",
            result: { ...created, ...project },
          } satisfies OperationOutcome;
        }),
      );
    });

  const discoverSaga = (operation: SagaOperation) =>
    Effect.gen(function* () {
      const info = yield* checkSpace({
        kind: "syncSpace",
        workspaceRoot: operation.sagaRoot,
        expectedManifestCreatedAt: operation.expectedManifestCreatedAt,
        referencesOnly: false,
      });
      if (!info.isSaga) return yield* refuse("invalid_arguments", "This project is not a saga.");
      if (info.state !== "live")
        return yield* refuse("archived_project", "Restore the saga before editing it.");
      const status = yield* cli.spaceStatus(info.spaceId);
      if (
        status.manifest.saga === undefined ||
        status.manifest.id !== info.spaceId ||
        info.createdAt === undefined ||
        !sameManifestIncarnation(status.manifest.createdAt, info.createdAt)
      )
        return yield* refuse(
          "incarnation_mismatch",
          "The saga manifest changed during pre-flight.",
        );
      const { agentWorkDir } = yield* loadRoots;
      const participants = [{ root: operation.sagaRoot, info }];
      if (operation.kind === "sagaAdd" || operation.kind === "sagaRemove") {
        const member = yield* checkSpace({
          kind: "syncSpace",
          workspaceRoot: operation.memberRoot,
          expectedManifestCreatedAt: operation.expectedMemberCreatedAt,
          referencesOnly: false,
        });
        if (member.isSaga || (operation.kind === "sagaAdd" && member.state !== "live"))
          return yield* refuse("invalid_arguments", "Choose a live non-saga member space.");
        const enrolled = status.manifest.saga?.members.find((row) => row.id === member.spaceId);
        if (operation.kind === "sagaRemove" && enrolled === undefined)
          return yield* refuse("invalid_arguments", "This space is not a member of this saga.");
        if (
          enrolled !== undefined &&
          (enrolled.createdAt === undefined ||
            member.createdAt === undefined ||
            !sameManifestIncarnation(enrolled.createdAt, member.createdAt))
        )
          return yield* refuse(
            "incarnation_mismatch",
            "The roster refers to a different member incarnation.",
          );
        participants.push({ root: operation.memberRoot, info: member });
      } else {
        // Use manifests, not rounded list timestamps, to select archived members.
        const archived = yield* cli.spaceList({ archived: true });
        for (const member of status.manifest.saga?.members ?? []) {
          if (member.createdAt === undefined)
            return yield* refuse(
              "incarnation_mismatch",
              "A legacy saga member has no incarnation stamp.",
            );
          const liveRoot = path.join(agentWorkDir, member.id);
          yield* workspaceReader.invalidate(liveRoot);
          const live = yield* workspaceReader.load(liveRoot);
          const matches: Array<{ root: string; info: typeof info }> = [];
          if (Option.isSome(live)) {
            if (
              live.value.spaceId !== member.id ||
              live.value.createdAt === undefined ||
              !sameManifestIncarnation(member.createdAt, live.value.createdAt)
            )
              return yield* refuse(
                "incarnation_mismatch",
                `Member '${member.id}' has been replaced.`,
              );
            matches.push({ root: liveRoot, info: live.value });
          } else if (yield* fileSystem.exists(liveRoot).pipe(Effect.mapError(asRefusal))) {
            return yield* refuse("unreadable", `Cannot read member '${member.id}'.`);
          }
          for (const archive of archived) {
            if (archive.error !== undefined)
              return yield* refuse("unreadable", "An archive manifest is unreadable.");
            const candidate = yield* freshInfo(archive.path);
            if (
              candidate.spaceId === member.id &&
              candidate.createdAt !== undefined &&
              sameManifestIncarnation(member.createdAt, candidate.createdAt)
            )
              matches.push({ root: archive.path, info: candidate });
          }
          if (matches.length > 1)
            return yield* refuse(
              "ambiguous_archive",
              `Member '${member.id}' has duplicate incarnations.`,
            );
          const match = matches[0];
          if (match !== undefined) {
            yield* checkSpace({
              kind: "syncSpace",
              workspaceRoot: match.root,
              expectedManifestCreatedAt: member.createdAt,
              referencesOnly: false,
            });
            if (match.info.isSaga)
              return yield* refuse("invalid_arguments", "Nested sagas cannot be members.");
            participants.push(match);
          } else {
            if ((yield* canonicalPath(liveRoot)) !== path.resolve(liveRoot))
              return yield* refuse(
                "invalid_arguments",
                "A missing member root is symlink-aliased.",
              );
            participants.push({
              root: liveRoot,
              info: {
                spaceId: member.id,
                createdAt: member.createdAt,
                isSaga: false,
                repos: [],
                memories: [],
                state: "live",
              },
            });
          }
        }
      }
      return { info, participants, roster: status.manifest.saga?.members ?? [] };
    });

  const sagaReview = (
    operation: Extract<SagaOperation, { kind: "sagaArchive" | "sagaDestroy" }>,
    saga: Effect.Success<ReturnType<typeof discoverSaga>>,
  ) =>
    Effect.gen(function* () {
      const shell = yield* snapshotQuery.getShellSnapshot().pipe(Effect.mapError(asRefusal));
      const participants = (yield* Effect.forEach(saga.participants, (member) =>
        Effect.gen(function* () {
          const project = shell.projects.find((project) => project.workspaceRoot === member.root);
          const threads =
            project === undefined
              ? []
              : yield* snapshotQuery
                  .listThreadLifecycleAnchorsByProjectId(project.id)
                  .pipe(Effect.mapError(asRefusal));
          return {
            spaceId: member.info.spaceId,
            createdAt: member.info.createdAt!,
            workspaceRoot: member.root,
            state: member.info.state ?? "live",
            ...(project === undefined
              ? {}
              : { projectId: project.id, projectTitle: project.title }),
            threadIds: threads
              .filter((thread) => thread.deletedAt === null)
              .map((thread) => thread.threadId)
              .sort(),
          };
        }),
      )).sort((left, right) => left.workspaceRoot.localeCompare(right.workspaceRoot));
      const scope = {
        sagaRoot: operation.sagaRoot,
        sagaCreatedAt: saga.info.createdAt!,
        target: operation.kind === "sagaArchive" ? ("archive" as const) : ("destroy" as const),
        force: operation.force,
        memory: operation.memory,
        participants,
      };
      const fingerprint = (excludeCoordinator: boolean) =>
        NodeCrypto.createHash("sha256")
          .update(
            stableStringify({
              ...scope,
              participants: participants.map(
                ({ projectTitle: _title, projectId, threadIds, ...participant }) => ({
                  ...participant,
                  ...(excludeCoordinator && participant.workspaceRoot === operation.sagaRoot
                    ? {}
                    : { projectId, threadIds }),
                }),
              ),
              roster: saga.roster
                .map((member) => ({ ...member, after: [...member.after].sort() }))
                .sort((a, b) => a.id.localeCompare(b.id)),
            }),
          )
          .digest("hex");
      return {
        ...scope,
        fingerprint: fingerprint(false),
        projectDeletionFingerprint: fingerprint(true),
      } satisfies StaveSagaReview;
    });

  const withSaga = <A>(
    operation: SagaOperation,
    body: (
      saga: Effect.Success<ReturnType<typeof discoverSaga>>,
    ) => Effect.Effect<A, StaveError | StaveRefusalError>,
  ) =>
    Effect.gen(function* () {
      const before = yield* discoverSaga(operation);
      const roots = yield* Effect.forEach(before.participants, (member) =>
        canonicalPath(member.root),
      );
      return yield* withRoots(
        roots,
        Effect.gen(function* () {
          const fresh = yield* discoverSaga(operation);
          const signature = (saga: typeof before) =>
            stableStringify({
              roster: saga.roster,
              roots: saga.participants.map((member) => [member.root, member.info.createdAt]).sort(),
            });
          if (signature(before) !== signature(fresh))
            return yield* refuse(
              "incarnation_mismatch",
              "The saga roster changed. Review it again before retrying.",
            );
          if (operation.kind === "sagaArchive" || operation.kind === "sagaDestroy") {
            const shell = yield* snapshotQuery.getShellSnapshot().pipe(Effect.mapError(asRefusal));
            for (const member of fresh.participants)
              for (const project of shell.projects) {
                if (
                  project.workspaceRoot !== member.root &&
                  (yield* isPathUnder(member.root, project.workspaceRoot))
                )
                  return yield* refuse(
                    "nested_project",
                    `Project '${project.title}' is nested inside saga participant '${member.info.spaceId}'.`,
                  );
              }
          }
          return yield* body(fresh);
        }),
      );
    });

  const runSagaOperation = (
    entry: RegistryEntry,
    operation: SagaOperation,
    allowMemberTeardown = true,
    durableTarget?: LifecycleRow,
    revalidate: Effect.Effect<void, StaveError | StaveRefusalError> = Effect.void,
    revalidateParticipant?: (
      projectId: ProjectId,
    ) => Effect.Effect<void, StaveError | StaveRefusalError>,
  ): Effect.Effect<OperationOutcome, StaveError | StaveRefusalError> =>
    withSaga(operation, (saga) =>
      Effect.gen(function* () {
        if (!allowMemberTeardown && saga.roster.length > 0)
          return yield* refuse(
            "invalid_arguments",
            "This partial saga now has members. Import it and review the full saga teardown before removing it.",
          );
        const reviewed =
          operation.kind === "sagaArchive" || operation.kind === "sagaDestroy"
            ? yield* sagaReview(operation, saga)
            : undefined;
        if (
          reviewed !== undefined &&
          allowMemberTeardown &&
          revalidateParticipant === undefined &&
          ("expectedSagaReview" in operation ? operation.expectedSagaReview : undefined) !==
            reviewed.fingerprint &&
          !(
            durableTarget?.deleteIntentSequence != null &&
            ("expectedSagaReview" in operation ? operation.expectedSagaReview : undefined) ===
              reviewed.projectDeletionFingerprint
          )
        )
          return yield* refuse(
            "incarnation_mismatch",
            "The saga members or affected projects changed, or cascade confirmation is missing. Review the complete saga teardown again.",
          );
        const id = saga.info.spaceId;
        const mutate = Effect.gen(function* () {
          switch (operation.kind) {
            case "sagaAdd": {
              const member = saga.participants[1]!;
              const input = {
                sagaId: id,
                spaceId: member.info.spaceId,
                after: operation.after,
                clearAfter: operation.clearAfter,
              };
              const result = yield* invoke(
                entry,
                "saga add",
                buildStaveArgv.sagaAdd(input),
                (stream) => cli.sagaAdd(input, stream),
                notesUnlessPlan,
              );
              if (isStaveDryRunPlan(result)) return yield* unexpectedPlan("saga add");
              return { kind: operation.kind, result } satisfies OperationOutcome;
            }
            case "sagaRemove": {
              const input = { sagaId: id, spaceId: saga.participants[1]!.info.spaceId };
              const result = yield* invoke(
                entry,
                "saga remove",
                buildStaveArgv.sagaRemove(input),
                (stream) => cli.sagaRemove(input, stream),
                notesUnlessPlan,
              );
              if (isStaveDryRunPlan(result)) return yield* unexpectedPlan("saga remove");
              return { kind: operation.kind, result } satisfies OperationOutcome;
            }
            case "sagaSync": {
              const input = { id };
              const result = yield* invoke(
                entry,
                "saga sync",
                buildStaveArgv.sagaSync(input),
                (stream) => cli.sagaSync(input, stream),
              );
              if (isStaveDryRunPlan(result)) return yield* unexpectedPlan("saga sync");
              return { kind: operation.kind, result } satisfies OperationOutcome;
            }
            case "sagaArchive": {
              const input = { id, force: operation.force, memory: operation.memory };
              const result = yield* invoke(
                entry,
                "saga archive",
                buildStaveArgv.sagaArchive(input),
                (stream) => cli.sagaArchive(input, stream),
                notesUnlessPlan,
              );
              if (isStaveDryRunPlan(result)) return yield* unexpectedPlan("saga archive");
              return { kind: operation.kind, result } satisfies OperationOutcome;
            }
            case "sagaDestroy": {
              const input = { id, force: operation.force, memory: operation.memory };
              const result = yield* invoke(
                entry,
                "saga destroy",
                buildStaveArgv.sagaDestroy(input),
                (stream) => cli.sagaDestroy(input, stream),
                notesUnlessPlan,
              );
              if (isStaveDryRunPlan(result)) return yield* unexpectedPlan("saga destroy");
              return { kind: operation.kind, result } satisfies OperationOutcome;
            }
          }
        });
        if (operation.kind !== "sagaArchive" && operation.kind !== "sagaDestroy")
          return yield* mutate.pipe(
            Effect.ensuring(
              Effect.forEach(saga.participants, (member) => afterMutation(member.root), {
                discard: true,
              }),
            ),
          );
        const leases: Array<LifecycleRow> = [];
        const patch = (
          row: LifecycleRow,
          changes: Parameters<typeof lifecycle.updateDisposition>[0]["patch"],
        ) =>
          Effect.gen(function* () {
            const updated = yield* lifecycle
              .updateDisposition({
                projectId: row.projectId,
                leaseEpoch: row.leaseEpoch,
                ownerToken: entry.operationId,
                now: yield* nowIso,
                patch: changes,
              })
              .pipe(Effect.mapError(asRefusal));
            if (!updated)
              return yield* refuse("space_transitioning", "A saga participant lease was lost.");
          });
        const renew = Effect.forever(
          Effect.gen(function* () {
            yield* Effect.sleep(Duration.seconds(20));
            for (const row of leases) {
              const now = yield* nowIso;
              const ok = yield* lifecycle
                .renewLease({
                  projectId: row.projectId,
                  leaseEpoch: row.leaseEpoch,
                  ownerToken: entry.operationId,
                  now,
                  leaseUntil: DateTime.formatIso(
                    DateTime.add(DateTime.makeUnsafe(now), { minutes: 1 }),
                  ),
                })
                .pipe(Effect.mapError(asRefusal));
              if (!ok)
                return yield* refuse(
                  "space_transitioning",
                  "A saga participant lease was lost; teardown stopped.",
                );
            }
          }),
        );
        const body = Effect.gen(function* () {
          for (const member of [...saga.participants].sort((a, b) =>
            a.root.localeCompare(b.root),
          )) {
            const project = yield* snapshotQuery
              .getActiveProjectByWorkspaceRoot(member.root)
              .pipe(Effect.mapError(asRefusal));
            const prior = Option.isNone(project)
              ? yield* lifecycle.getByWorkspaceRoot(member.root).pipe(Effect.mapError(asRefusal))
              : Option.none<LifecycleRow>();
            const deletedRow =
              durableTarget?.workspaceRoot === member.root
                ? durableTarget
                : Option.getOrUndefined(prior);
            if (Option.isNone(project) && deletedRow === undefined) continue;
            if (
              deletedRow !== undefined &&
              Option.isSome(project) &&
              project.value.id !== deletedRow.projectId
            )
              return yield* refuse(
                "incarnation_mismatch",
                "Another project now owns the saga root.",
              );
            const now = yield* nowIso;
            const row = yield* lifecycle
              .ensure({
                projectId: deletedRow?.projectId ?? Option.getOrThrow(project).id,
                workspaceRoot: member.root,
                spaceId: member.info.spaceId,
                manifestCreatedAt: member.info.createdAt ?? null,
                now,
              })
              .pipe(Effect.mapError(asRefusal));
            if (
              row.spaceId !== member.info.spaceId ||
              row.manifestCreatedAt === null ||
              member.info.createdAt === undefined ||
              !sameManifestIncarnation(row.manifestCreatedAt, member.info.createdAt)
            )
              return yield* refuse(
                "incarnation_mismatch",
                "A participant lifecycle row belongs to an earlier incarnation.",
              );
            const acquired = yield* lifecycle
              .acquireLease({
                projectId: row.projectId,
                expectedEpoch: row.leaseEpoch,
                ownerToken: entry.operationId,
                now,
                leaseUntil: DateTime.formatIso(
                  DateTime.add(DateTime.makeUnsafe(now), { minutes: 1 }),
                ),
              })
              .pipe(Effect.mapError(asRefusal));
            if (Option.isNone(acquired))
              return yield* refuse(
                "space_transitioning",
                "Another operation owns a saga participant.",
              );
            leases.push(acquired.value);
          }
          yield* revalidate;
          if (revalidateParticipant)
            for (const row of leases) yield* revalidateParticipant(row.projectId);
          // All rows are durable and fenced before the first session is stopped.
          for (const row of leases)
            yield* patch(row, {
              disposition: operation.kind === "sagaArchive" ? "archiving" : "destroying",
              refusalCode: null,
              refusalMessage: null,
            });
          const shell = yield* snapshotQuery.getShellSnapshot().pipe(Effect.mapError(asRefusal));
          const sessions = yield* providers.listSessions();
          if (
            providers.stopSessionsUnder === undefined ||
            terminals.closeSessionsUnder === undefined
          )
            return yield* refuse("unknown", "Session quiescence is unavailable.");
          const ownedThreads = shell.threads.filter((thread) =>
            leases.some((row) => row.projectId === thread.projectId),
          );
          const interruptIds = new Set(
            ownedThreads
              .filter((thread) => thread.session?.activeTurnId != null)
              .map((thread) => thread.id),
          );
          for (const session of sessions) {
            if (session.cwd !== undefined && session.activeTurnId != null) {
              for (const member of saga.participants)
                if (yield* isPathUnder(member.root, session.cwd))
                  interruptIds.add(session.threadId);
            }
          }
          for (const threadId of interruptIds) {
            const command = yield* normalizeDispatchCommand({
              type: "thread.turn.interrupt",
              commandId: CommandId.make(`server:stave:interrupt:${NodeCrypto.randomUUID()}`),
              threadId,
              createdAt: yield* nowIso,
            }).pipe(Effect.provide(normalizerContext), Effect.mapError(asRefusal));
            yield* engine.dispatch(command).pipe(Effect.mapError(asRefusal));
          }
          for (const session of sessions)
            if (
              session.cwd === undefined &&
              ownedThreads.some((thread) => thread.id === session.threadId)
            )
              yield* providers
                .stopSession({ threadId: session.threadId })
                .pipe(Effect.mapError(asRefusal));
          for (const member of saga.participants) {
            yield* providers.stopSessionsUnder(member.root).pipe(Effect.mapError(asRefusal));
            yield* terminals.closeSessionsUnder(member.root).pipe(Effect.mapError(asRefusal));
          }
          const final = yield* discoverSaga(operation);
          if (
            stableStringify(final.roster) !== stableStringify(saga.roster) ||
            stableStringify(
              final.participants.map((member) => [member.root, member.info.createdAt]),
            ) !==
              stableStringify(
                saga.participants.map((member) => [member.root, member.info.createdAt]),
              )
          )
            return yield* refuse(
              "incarnation_mismatch",
              "The saga changed while sessions were stopping.",
            );
          const finalShell = yield* snapshotQuery
            .getShellSnapshot()
            .pipe(Effect.mapError(asRefusal));
          for (const member of final.participants)
            for (const project of finalShell.projects) {
              if (
                project.workspaceRoot !== member.root &&
                (yield* isPathUnder(member.root, project.workspaceRoot))
              )
                return yield* refuse(
                  "nested_project",
                  `Project '${project.title}' is nested inside saga participant '${member.info.spaceId}'.`,
                );
            }
          if (
            reviewed !== undefined &&
            (operation.kind === "sagaArchive" || operation.kind === "sagaDestroy") &&
            (yield* sagaReview(operation, final)).fingerprint !== reviewed.fingerprint
          )
            return yield* refuse(
              "incarnation_mismatch",
              "The saga teardown scope changed while sessions were stopping. Review it again.",
            );
          yield* revalidate;
          if (revalidateParticipant)
            for (const row of leases) yield* revalidateParticipant(row.projectId);
          return yield* mutate;
        });
        const recovered = Effect.gen(function* () {
          const result = yield* Effect.exit(body);
          if (Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause))
            return yield* Effect.failCause(result.cause);
          const failures: Array<{ projectId: string; message: string }> = [];
          for (const row of leases) {
            const reconcile = yield* Effect.exit(
              Effect.gen(function* () {
                const changes = yield* reconcileRow(row);
                yield* patch(row, changes);
                if (Exit.isFailure(result)) {
                  const error = toOperationError(result.cause);
                  yield* patch(row, {
                    refusalCode: error.code,
                    refusalMessage: stableStringify({
                      message: error.message,
                      details: error.details,
                    }),
                    ...(changes.disposition === "live" ? { disposition: "refused" as const } : {}),
                  });
                }
              }),
            );
            if (Exit.isFailure(reconcile)) {
              if (Cause.hasInterruptsOnly(reconcile.cause))
                return yield* Effect.failCause(reconcile.cause);
              const error = toOperationError(reconcile.cause);
              failures.push({ projectId: row.projectId, message: error.message });
              yield* patch(row, {
                disposition: "refused",
                refusalCode: error.code,
                refusalMessage: error.message,
              }).pipe(Effect.ignore);
            }
          }
          if (Exit.isFailure(result)) {
            const error = toOperationError(result.cause);
            return yield* refuse(error.code, error.message, {
              ...error.details,
              reconciliationFailures: failures,
            });
          }
          if (failures.length > 0)
            return yield* refuse(
              "unreadable",
              "Saga teardown finished but some projects need reconciliation.",
              { reconciliationFailures: failures, result: result.value },
            );
          return result.value;
        });
        return yield* Effect.raceFirst(recovered, renew).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              for (const member of saga.participants)
                yield* afterMutation(member.root).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("stave: saga refresh failed", { root: member.root, cause }),
                  ),
                );
              for (const row of leases)
                yield* lifecycle
                  .releaseLease({
                    projectId: row.projectId,
                    leaseEpoch: row.leaseEpoch,
                    ownerToken: entry.operationId,
                    now: yield* nowIso,
                  })
                  .pipe(Effect.ignore);
            }),
          ),
        );
      }),
    );

  const actionRow = (operation: StaveLifecycleActionOperation) =>
    Effect.gen(function* () {
      const found = yield* lifecycle
        .getByProjectId(operation.projectId)
        .pipe(Effect.mapError(asRefusal));
      if (Option.isNone(found) || found.value.workspaceRoot !== operation.workspaceRoot)
        return yield* refuse(
          "invalid_arguments",
          "This cleanup record changed. Refresh before retrying.",
        );
      const active = yield* snapshotQuery
        .getProjectShellById(operation.projectId)
        .pipe(Effect.mapError(asRefusal));
      if (Option.isSome(active) && active.value.workspaceRoot !== found.value.workspaceRoot)
        return yield* refuse(
          "incarnation_mismatch",
          "The project workspace changed. Review its current space instead.",
        );
      return found.value;
    });
  const actionDiskOperation = (operation: StaveLifecycleActionOperation, row: LifecycleRow) =>
    Effect.gen(function* () {
      if (
        operation.expectedManifestCreatedAt === undefined ||
        row.manifestCreatedAt === null ||
        !sameManifestIncarnation(operation.expectedManifestCreatedAt, row.manifestCreatedAt)
      )
        return yield* refuse(
          "incarnation_mismatch",
          "A disk cleanup needs the recorded space incarnation.",
        );
      const target = operation.action === "archiveNow" ? "archive" : operation.target;
      if (target === undefined)
        return yield* refuse("invalid_arguments", "Choose the cleanup action before reviewing it.");
      if (target === "archive" && operation.memory === "destroy")
        return yield* refuse("invalid_arguments", "Archiving cannot destroy memory.");
      const info = yield* freshInfo(operation.workspaceRoot);
      if (info.spaceId !== row.spaceId)
        return yield* refuse(
          "incarnation_mismatch",
          "The recorded space id no longer matches this root.",
        );
      const memory = operation.memory;
      const scope = {
        expectedManifestCreatedAt: operation.expectedManifestCreatedAt,
        force: operation.force,
      };
      return info.isSaga
        ? target === "archive"
          ? {
              kind: "sagaArchive" as const,
              sagaRoot: operation.workspaceRoot,
              expectedSagaReview: operation.expectedSagaReview,
              ...scope,
              memory: operation.memory as "keep" | "contribute",
            }
          : {
              kind: "sagaDestroy" as const,
              sagaRoot: operation.workspaceRoot,
              expectedSagaReview: operation.expectedSagaReview,
              ...scope,
              memory,
            }
        : target === "archive"
          ? {
              kind: "archiveSpace" as const,
              workspaceRoot: operation.workspaceRoot,
              ...scope,
              memory: operation.memory as "keep" | "contribute",
            }
          : {
              kind: "destroySpace" as const,
              workspaceRoot: operation.workspaceRoot,
              ...scope,
              memory,
              sagaRemoveConfirmed: operation.sagaRemoveConfirmed ?? row.sagaRemoveConfirmed,
            };
    });
  const runLifecycleAction = (
    entry: RegistryEntry,
    operation: StaveLifecycleActionOperation,
    revalidate: Effect.Effect<void, StaveError | StaveRefusalError> = Effect.void,
    revalidateParticipant?: (
      projectId: ProjectId,
    ) => Effect.Effect<void, StaveError | StaveRefusalError>,
  ): Effect.Effect<OperationOutcome, StaveError | StaveRefusalError> =>
    Effect.gen(function* () {
      const row = yield* actionRow(operation);
      if (operation.action === "keep" || operation.action === "dismiss") {
        yield* withSpaceLock(
          row.workspaceRoot,
          Effect.gen(function* () {
            const current = yield* actionRow(operation);
            const now = yield* nowIso;
            const lease = yield* lifecycle
              .acquireLease({
                projectId: row.projectId,
                expectedEpoch: current.leaseEpoch,
                ownerToken: entry.operationId,
                now,
                leaseUntil: DateTime.formatIso(
                  DateTime.add(DateTime.makeUnsafe(now), { minutes: 1 }),
                ),
              })
              .pipe(Effect.mapError(asRefusal));
            if (Option.isNone(lease))
              return yield* refuse("space_transitioning", "Another cleanup owns this space.");
            const guard = {
              projectId: row.projectId,
              leaseEpoch: lease.value.leaseEpoch,
              ownerToken: entry.operationId,
            };
            yield* Effect.gen(function* () {
              const changed = yield* lifecycle
                .updateDisposition({
                  ...guard,
                  now,
                  patch: {
                    disposition: "kept",
                    deleteIntentSequence: null,
                    refusalCode: null,
                    refusalMessage: null,
                    archiveDeadlineAt: null,
                  },
                })
                .pipe(Effect.mapError(asRefusal));
              if (!changed)
                return yield* refuse("space_transitioning", "The cleanup lease was lost.");
              yield* afterMutation(row.workspaceRoot);
            }).pipe(Effect.ensuring(lifecycle.releaseLease({ ...guard, now }).pipe(Effect.ignore)));
          }),
        );
      } else {
        const disk = yield* actionDiskOperation(operation, row);
        const validate = Effect.gen(function* () {
          const current = yield* actionRow(operation);
          if (
            current.spaceId !== row.spaceId ||
            current.manifestCreatedAt !== row.manifestCreatedAt
          )
            return yield* refuse("incarnation_mismatch", "The cleanup incarnation changed.");
          const deleted = yield* lifecycle
            .isProjectDeleted(row.projectId)
            .pipe(Effect.mapError(asRefusal));
          if (operation.action === "archiveNow" && deleted)
            return yield* refuse(
              "invalid_arguments",
              "This project was deleted. Review its pending cleanup.",
            );
          yield* revalidate;
        });
        if (disk.kind === "sagaArchive" || disk.kind === "sagaDestroy")
          yield* runSagaOperation(entry, disk, true, row, validate, revalidateParticipant);
        else yield* runSpaceOperation(entry, disk, row, validate);
      }
      const finalRow = yield* lifecycle
        .getByProjectId(row.projectId)
        .pipe(Effect.mapError(asRefusal));
      return {
        kind: "lifecycleAction",
        result: { projectId: row.projectId, disposition: Option.getOrThrow(finalRow).disposition },
      };
    });

  const executeLifecycle: StaveOperationsShape["executeLifecycle"] = (
    operation,
    revalidate,
    revalidateParticipant,
  ) =>
    Effect.gen(function* () {
      const entry: RegistryEntry = {
        operationId: `server:stave:lifecycle:${NodeCrypto.randomUUID()}`,
        kind: "lifecycleAction",
        fingerprint: fingerprintOperation(operation),
        state: "running",
        events: [],
        bytes: 0,
        nextSequence: 1,
        terminalAtMs: null,
        lastAccessMs: yield* Clock.currentTimeMillis,
        partialSpace: null,
        partialCleanupEdges: null,
        pubsub: yield* PubSub.unbounded<StaveProgressEvent>(),
      };
      yield* runLifecycleAction(entry, operation, revalidate, revalidateParticipant).pipe(
        Effect.onExit((exit) => recordOutcome(operation, "automatic", exit)),
        Effect.ensuring(
          Effect.gen(function* () {
            registryBytes -= entry.bytes;
            yield* PubSub.shutdown(entry.pubsub);
          }),
        ),
      );
    });

  const runOperationBody = (
    entry: RegistryEntry,
    operation: StaveOperation,
  ): Effect.Effect<OperationOutcome, StaveError | StaveRefusalError> => {
    switch (operation.kind) {
      case "lifecycleAction":
        return runLifecycleAction(entry, operation);
      case "createSpace":
        return runCreateSpace(entry, operation);
      case "removePartialSpace":
        return runRemovePartialSpace(entry, operation);
      case "setup":
        return runSetup(entry, operation);
      case "registerRepo":
        return runRegisterRepo(entry, operation);
      // Space operations share lifecycle guards.
      case "addRepo":
      case "removeRepo":
      case "syncSpace":
      case "retarget":
      case "archiveSpace":
      case "destroySpace":
      case "restoreSpace":
      case "memoryAttach":
      case "memoryDetach":
        return runSpaceOperation(entry, operation);
      case "createSaga":
        return runCreateSaga(entry, operation);
      case "sagaAdd":
      case "sagaRemove":
      case "sagaSync":
      case "sagaArchive":
      case "sagaDestroy":
        return runSagaOperation(entry, operation);
    }
  };

  const finish = (
    entry: RegistryEntry,
    exit: Exit.Exit<OperationOutcome, StaveError | StaveRefusalError>,
  ) =>
    Effect.gen(function* () {
      const terminalAtMs = yield* Clock.currentTimeMillis;
      // The state flips inside the same uninterruptible step that buffers the
      // terminal event, so an attacher never sees "finished" without it.
      if (Exit.isSuccess(exit)) {
        yield* emit(entry, (base) => {
          entry.state = "finished";
          entry.terminalAtMs = terminalAtMs;
          return { ...base, kind: "finished", result: exit.value };
        });
        return;
      }
      const error = toOperationError(exit.cause);
      const partial = entry.partialSpace;
      const details =
        partial === null ? error.details : { ...error.details, partialSpace: partial };
      yield* emit(entry, (base) => {
        entry.state = "failed";
        entry.terminalAtMs = terminalAtMs;
        return {
          ...base,
          kind: "failed",
          error: {
            ...error,
            details:
              entry.partialCleanupEdges === null
                ? details
                : { ...details, removedEdges: entry.partialCleanupEdges },
          },
        };
      });
    });

  const start = (entry: RegistryEntry, operation: StaveOperation) =>
    Effect.forkIn(
      withExecution(operation, runOperationBody(entry, operation)).pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          recordOutcome(operation, "interactive", exit).pipe(Effect.andThen(finish(entry, exit))),
        ),
      ),
      serviceScope,
    );

  const run = (input: StaveRunOperationInput) =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* reapExpired;
        const fingerprint = fingerprintOperation(input.operation);
        const existing = entries.get(input.operationId);
        if (existing !== undefined) {
          if (existing.fingerprint !== fingerprint) {
            return yield* new StaveOperationRejectedError({
              operationId: input.operationId,
              code: "invalid_arguments",
              message: `Operation '${input.operationId}' is already ${existing.state} with a different payload.`,
            });
          }
          return attach(existing, input.afterSequence);
        }
        if (expired.has(input.operationId)) {
          return yield* new StaveOperationRejectedError({
            operationId: input.operationId,
            code: "operation_expired",
            message: `Operation '${input.operationId}' finished more than ${Duration.format(Duration.millis(retentionMs))} ago; start a new one.`,
          });
        }
        const now = yield* Clock.currentTimeMillis;
        const entry: RegistryEntry = {
          operationId: input.operationId,
          kind: input.operation.kind,
          fingerprint,
          state: "running",
          events: [],
          bytes: 0,
          nextSequence: 1,
          terminalAtMs: null,
          lastAccessMs: now,
          partialSpace: null,
          partialCleanupEdges: null,
          pubsub: yield* PubSub.unbounded<StaveProgressEvent>(),
        };
        entries.set(entry.operationId, entry);
        // Attach first so the very first event is seen live, then start.
        const stream = attach(entry, input.afterSequence);
        yield* start(entry, input.operation);
        return stream;
      }),
    );

  const observe = (input: StaveObserveOperationInput) =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* reapExpired;
        const existing = entries.get(input.operationId);
        if (existing !== undefined) {
          return attach(existing, input.afterSequence);
        }
        return yield* new StaveOperationRejectedError({
          operationId: input.operationId,
          code: expired.has(input.operationId) ? "operation_expired" : "invalid_arguments",
          message: expired.has(input.operationId)
            ? `Operation '${input.operationId}' is no longer retained.`
            : `Unknown operation '${input.operationId}'.`,
        });
      }),
    );

  const dryRun = (operation: StaveOperation): Effect.Effect<StaveDryRunPlan, StaveError> => {
    const notDryRunnable = new StaveError({
      code: "invalid_arguments",
      message: `Operation '${operation.kind}' has no dry run.`,
      details: null,
      exitCode: null,
      stderrTail: null,
      verb: STAVE_OPERATION_VERB[operation.kind],
    });
    const expectPlan = <A>(verb: StaveVerb, outcome: A | StaveDryRunPlan) =>
      isStaveDryRunPlan(outcome)
        ? Effect.succeed(outcome)
        : Effect.fail(
            new StaveError({
              code: "unreadable",
              message: `stave ${verb} --dry-run did not answer with a plan`,
              details: null,
              exitCode: 0,
              stderrTail: null,
              verb,
            }),
          );
    switch (operation.kind) {
      case "lifecycleAction":
        return Effect.gen(function* () {
          const row = yield* actionRow(operation);
          if (operation.action === "keep" || operation.action === "dismiss")
            return {
              dryRun: true as const,
              plan: ["Keep the space and memory on disk; stop this cleanup or archive schedule."],
            };
          const disk = yield* actionDiskOperation(operation, row);
          return yield* dryRun(disk);
        }).pipe(
          Effect.mapError((error) =>
            error._tag === "StaveError"
              ? error
              : new StaveError({
                  code: error.code,
                  message: error.message,
                  details: error.details,
                  exitCode: null,
                  stderrTail: null,
                  verb: "space destroy",
                }),
          ),
        );

      case "removePartialSpace":
        return loadRoots.pipe(
          Effect.mapError(
            (error) =>
              new StaveError({
                code: error.code,
                message: error.message,
                details: error.details,
                exitCode: null,
                stderrTail: null,
                verb: "space destroy",
              }),
          ),
          Effect.flatMap(({ agentWorkDir }) =>
            Effect.gen(function* () {
              const root = path.join(agentWorkDir, operation.spaceId);
              yield* workspaceReader.invalidate(root);
              const info = yield* workspaceReader.load(root);
              if (Option.isSome(info) && info.value.isSaga) {
                const status = yield* cli.spaceStatus(operation.spaceId);
                if ((status.manifest.saga?.members.length ?? 0) > 0)
                  return yield* new StaveError({
                    code: "invalid_arguments",
                    message:
                      "This partial saga now has members. Import it and review the full saga teardown before removing it.",
                    details: null,
                    exitCode: null,
                    stderrTail: null,
                    verb: "saga destroy",
                  });
                return yield* dryRun({
                  kind: "sagaDestroy",
                  sagaRoot: root,
                  expectedManifestCreatedAt: operation.expectedManifestCreatedAt,
                  force: operation.force === true,
                  memory: "destroy",
                });
              }
              return yield* dryRun({
                kind: "destroySpace",
                workspaceRoot: root,
                expectedManifestCreatedAt: operation.expectedManifestCreatedAt,
                sagaRemoveConfirmed: operation.sagaRemoveConfirmed,
                force: operation.force === true,
                memory: "destroy",
              });
            }),
          ),
        );
      case "createSpace":
        return Effect.scoped(
          spaceCreateInput(operation, true).pipe(
            Effect.mapError(
              (refusal) =>
                new StaveError({
                  code: refusal.code,
                  message: refusal.message,
                  details: refusal.details,
                  exitCode: null,
                  stderrTail: null,
                  verb: "space create",
                }),
            ),
            Effect.flatMap((input) => cli.spaceCreate(input)),
            Effect.flatMap((outcome) => expectPlan("space create", outcome)),
          ),
        );
      case "createSaga":
        return Effect.scoped(
          sagaCreateInput(operation, true).pipe(
            Effect.flatMap((input) => cli.sagaCreate(input)),
            Effect.flatMap((value) => expectPlan("saga create", value)),
            Effect.mapError((error) =>
              error._tag === "StaveError"
                ? error
                : new StaveError({
                    code: error.code,
                    message: error.message,
                    details: error.details,
                    exitCode: null,
                    stderrTail: null,
                    verb: "saga create",
                  }),
            ),
          ),
        );
      case "sagaAdd":
      case "sagaRemove":
      case "sagaSync":
      case "sagaArchive":
      case "sagaDestroy":
        return withSaga(operation, (saga) =>
          Effect.gen(function* () {
            switch (operation.kind) {
              case "sagaAdd":
                return yield* cli
                  .sagaAdd({
                    sagaId: saga.info.spaceId,
                    spaceId: saga.participants[1]!.info.spaceId,
                    after: operation.after,
                    clearAfter: operation.clearAfter,
                    dryRun: true,
                  })
                  .pipe(Effect.flatMap((value) => expectPlan("saga add", value)));
              case "sagaRemove":
                return yield* cli
                  .sagaRemove({
                    sagaId: saga.info.spaceId,
                    spaceId: saga.participants[1]!.info.spaceId,
                    dryRun: true,
                  })
                  .pipe(Effect.flatMap((value) => expectPlan("saga remove", value)));
              case "sagaSync":
                return yield* cli
                  .sagaSync({ id: saga.info.spaceId, dryRun: true })
                  .pipe(Effect.flatMap((value) => expectPlan("saga sync", value)));
              case "sagaArchive":
                return yield* cli
                  .sagaArchive({
                    id: saga.info.spaceId,
                    memory: operation.memory,
                    force: operation.force,
                    dryRun: true,
                  })
                  .pipe(
                    Effect.flatMap((value) => expectPlan("saga archive", value)),
                    Effect.flatMap((plan) =>
                      sagaReview(operation, saga).pipe(
                        Effect.map((review) => ({ ...plan, sagaReview: review })),
                      ),
                    ),
                  );
              case "sagaDestroy":
                return yield* cli
                  .sagaDestroy({
                    id: saga.info.spaceId,
                    memory: operation.memory,
                    force: operation.force,
                    dryRun: true,
                  })
                  .pipe(
                    Effect.flatMap((value) => expectPlan("saga destroy", value)),
                    Effect.flatMap((plan) =>
                      sagaReview(operation, saga).pipe(
                        Effect.map((review) => ({ ...plan, sagaReview: review })),
                      ),
                    ),
                  );
            }
          }),
        ).pipe(
          Effect.mapError((error) =>
            error._tag === "StaveError"
              ? error
              : new StaveError({
                  code: error.code,
                  message: error.message,
                  details: error.details,
                  exitCode: null,
                  stderrTail: null,
                  verb: STAVE_OPERATION_VERB[operation.kind],
                }),
          ),
        );
      case "registerRepo":
        return cli
          .reposAdd({
            name: operation.name,
            url: operation.url,
            adopt: operation.adopt,
            dryRun: true,
          })
          .pipe(Effect.flatMap((outcome) => expectPlan("repos add", outcome)));
      case "addRepo":
      case "removeRepo":
      case "retarget":
      case "archiveSpace":
      case "restoreSpace":
      case "destroySpace":
      case "memoryAttach":
      case "memoryDetach":
        return withSpaceLock(
          operation.workspaceRoot,
          Effect.gen(function* () {
            const info = yield* checkSpace(operation).pipe(
              Effect.mapError(
                (error) =>
                  new StaveError({
                    code: error.code,
                    message: error.message,
                    details: error.details,
                    exitCode: null,
                    stderrTail: null,
                    verb: STAVE_OPERATION_VERB[operation.kind],
                  }),
              ),
            );
            if (
              info.isSaga &&
              (operation.kind === "archiveSpace" || operation.kind === "destroySpace")
            )
              return yield* new StaveError({
                code: "saga_space",
                message: "Use Archive saga or Destroy saga to review all member spaces.",
                details: null,
                exitCode: null,
                stderrTail: null,
                verb: STAVE_OPERATION_VERB[operation.kind],
              });
            switch (operation.kind) {
              case "addRepo":
                return yield* cli
                  .spaceAdd({ ...operation, id: info.spaceId, dryRun: true })
                  .pipe(Effect.flatMap((value) => expectPlan("space add", value)));
              case "removeRepo":
                return yield* cli
                  .spaceRemove({ ...operation, id: info.spaceId, dryRun: true })
                  .pipe(Effect.flatMap((value) => expectPlan("space remove", value)));
              case "retarget":
                return yield* cli
                  .spaceRetarget({ ...operation, id: info.spaceId, dryRun: true })
                  .pipe(Effect.flatMap((value) => expectPlan("space retarget", value)));
              case "archiveSpace":
                return yield* cli
                  .spaceArchive({ ...operation, id: info.spaceId, dryRun: true })
                  .pipe(Effect.flatMap((value) => expectPlan("space archive", value)));
              case "restoreSpace":
                return yield* cli
                  .spaceRestore({ ...operation, id: info.spaceId, dryRun: true })
                  .pipe(Effect.flatMap((value) => expectPlan("space restore", value)));
              case "destroySpace": {
                if (operation.sagaRemoveConfirmed === true) {
                  const memberships = yield* membership(info.spaceId, info.createdAt!).pipe(
                    Effect.mapError(
                      (error) =>
                        new StaveError({
                          code: error.code,
                          message: error.message,
                          details: error.details,
                          exitCode: null,
                          stderrTail: null,
                          verb: "space destroy",
                        }),
                    ),
                  );
                  if (memberships.length > 0) {
                    const plan: Array<string> = [];
                    for (const member of memberships) {
                      const removal = yield* cli
                        .sagaRemove({ sagaId: member.sagaId, spaceId: info.spaceId, dryRun: true })
                        .pipe(Effect.flatMap((value) => expectPlan("saga remove", value)));
                      plan.push(...removal.plan);
                    }
                    plan.push(
                      `Then attempt ${operation.force ? "forced" : "guarded"} destruction of space '${info.spaceId}' with memory=${operation.memory}.`,
                      "Destroy guards are checked after saga removal. A refusal can leave the space removed from its saga; retained ordering edges are available for manual repair.",
                    );
                    return { dryRun: true as const, plan };
                  }
                }
                return yield* cli
                  .spaceDestroy({ ...operation, id: info.spaceId, dryRun: true })
                  .pipe(Effect.flatMap((value) => expectPlan("space destroy", value)));
              }
              case "memoryDetach":
                return yield* cli
                  .memoryDetach({ ...operation, id: info.spaceId, dryRun: true })
                  .pipe(Effect.flatMap((value) => expectPlan("memory detach", value)));
              case "memoryAttach": {
                const plan: Array<string> = [];
                for (const spec of operation.specs) {
                  const separator = spec.spec.indexOf(":");
                  const value = separator >= 0 ? spec.spec.slice(separator + 1) : spec.spec;
                  const result = yield* cli
                    .memoryAttach({
                      id: info.spaceId,
                      provider: separator >= 0 ? spec.spec.slice(0, separator) : undefined,
                      use: value === "." ? undefined : value,
                      edit: [],
                      link: [],
                      opt: [],
                      dryRun: true,
                    })
                    .pipe(Effect.flatMap((value) => expectPlan("memory attach", value)));
                  plan.push(...result.plan);
                }
                return { dryRun: true as const, plan };
              }
            }
          }),
        );
      case "syncSpace":
        return Effect.succeed({
          dryRun: true,
          plan: [
            operation.referencesOnly
              ? "Sync reference repositories in this space."
              : "Sync repositories in this space.",
          ],
        });
      default:
        return Effect.fail(notDryRunnable);
    }
  };

  const summary = (operationId: string) =>
    Effect.sync(() => {
      const entry = entries.get(operationId);
      return entry === undefined
        ? Option.none<StaveOperationSummary>()
        : Option.some<StaveOperationSummary>({
            operationId,
            kind: entry.kind,
            state: entry.state,
            earliestSequence: earliestSequence(entry),
            nextSequence: entry.nextSequence,
            bufferedEvents: entry.events.length,
            manifestCreatedAt: entry.partialSpace?.manifestCreatedAt ?? null,
          });
    });

  return StaveOperations.of({
    run,
    observe,
    dryRun: (operation) => withExecution(operation, dryRun(operation)),
    withSpaceLock,
    summary,
    reconcileIncomplete,
    executeLifecycle: (operation, revalidate, revalidateParticipant) =>
      withExecution(operation, executeLifecycle(operation, revalidate, revalidateParticipant)),
  });
});

// The gated lifecycle worker owns startup and retry reconciliation.
// Constructing the operation registry never mutates spaces or project metadata.
export const layer = Layer.effect(StaveOperations, make());

export const layerWith = (limits: StaveOperationsLimits) =>
  Layer.effect(StaveOperations, make(limits));

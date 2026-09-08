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
import * as Semaphore from "effect/Semaphore";
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
import { StaveConfigReader } from "./StaveConfigReader.ts";
import { StaveError, StaveErrorCode, StaveErrorDetails } from "./StaveError.ts";
import { isStaveDryRunPlan, type StaveDryRunPlan } from "./staveJson.ts";
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
  const configReader = yield* StaveConfigReader;
  const workspaceReader = yield* StaveWorkspaceReader;
  const processRunner = yield* ProcessRunner;
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
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

  const locks = new Map<string, Semaphore.Semaphore>();
  const withSpaceLock = <A, E, R>(root: string, effect: Effect.Effect<A, E, R>) => {
    const key = path.resolve(root);
    let semaphore = locks.get(key);
    if (semaphore === undefined) {
      semaphore = Semaphore.makeUnsafe(1);
      locks.set(key, semaphore);
    }
    return semaphore.withPermits(1)(effect);
  };

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
      const { sequence } = yield* engine.dispatch(command);
      return { projectId, sequence };
    }).pipe(
      Effect.mapError((cause) =>
        refuse("unknown", `The space was created but the project could not be: ${cause.message}`, {
          spacePath,
        }),
      ),
    );

  const runCreateSpace = (entry: RegistryEntry, operation: StaveCreateSpaceOperation) =>
    Effect.gen(function* () {
      const { snapshot, agentWorkDir } = yield* loadRoots;
      const candidate = path.join(agentWorkDir, operation.spaceId);
      const bareRepoPathOf = (repo: string) =>
        snapshot.repos.find((entry) => entry.name === repo)?.bareRepoPath;
      return yield* withSpaceLock(
        candidate,
        Effect.gen(function* () {
          yield* phase(
            entry,
            "pre-flight",
            undefined,
            preflightCreateSpace(entry, operation, agentWorkDir, candidate, bareRepoPathOf),
          );

          const mutation = yield* Effect.scoped(
            Effect.gen(function* () {
              const input = yield* spaceCreateInput(operation, false);
              const created = yield* invoke(
                entry,
                "space create",
                buildStaveArgv.spaceCreate(input),
                (stream) => cli.spaceCreate(input, stream),
                notesUnlessPlan,
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
          return {
            kind: "createSpace",
            result: { ...mutation, projectId, sequence },
          } satisfies OperationOutcome;
        }),
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
      return yield* withSpaceLock(
        path.join(agentWorkDir, operation.spaceId),
        Effect.gen(function* () {
          const status = yield* phase(
            entry,
            "pre-flight",
            commandLineOf("space status", buildStaveArgv.spaceStatus(operation.spaceId)),
            cli.spaceStatus(operation.spaceId),
          );
          if (status.manifest.createdAt !== operation.expectedManifestCreatedAt) {
            return yield* refuse(
              "incarnation_mismatch",
              `The space at '${status.spacePath}' is not the one the failed create produced (${status.manifest.createdAt} vs ${operation.expectedManifestCreatedAt}).`,
              { expected: operation.expectedManifestCreatedAt, actual: status.manifest.createdAt },
            );
          }
          const input = { id: operation.spaceId, force: true, memory: "destroy" as const };
          const destroyed = yield* invoke(
            entry,
            "space destroy",
            buildStaveArgv.spaceDestroy(input),
            (stream) => cli.spaceDestroy(input, stream),
            notesUnlessPlan,
          );
          if (isStaveDryRunPlan(destroyed)) {
            return yield* unexpectedPlan("space destroy");
          }
          yield* afterMutation(status.spacePath);
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

  // ── dispatch ────────────────────────────────────────────────

  const notImplemented = (kind: StaveOperationKind) =>
    refuse("invalid_arguments", `Operation '${kind}' is not implemented yet.`);

  const runOperationBody = (
    entry: RegistryEntry,
    operation: StaveOperation,
  ): Effect.Effect<OperationOutcome, StaveError | StaveRefusalError> => {
    switch (operation.kind) {
      case "createSpace":
        return runCreateSpace(entry, operation);
      case "removePartialSpace":
        return runRemovePartialSpace(entry, operation);
      case "setup":
        return runSetup(entry, operation);
      case "registerRepo":
        return runRegisterRepo(entry, operation);
      // Phases 4-5 fill these in; listing every kind keeps the switch exhaustive.
      case "addRepo":
      case "removeRepo":
      case "syncSpace":
      case "retarget":
      case "archiveSpace":
      case "destroySpace":
      case "restoreSpace":
      case "memoryAttach":
      case "memoryDetach":
      case "createSaga":
      case "sagaAdd":
      case "sagaRemove":
      case "sagaSync":
      case "sagaArchive":
      case "sagaDestroy":
        return notImplemented(operation.kind);
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
        return { ...base, kind: "failed", error: { ...error, details } };
      });
    });

  const start = (entry: RegistryEntry, operation: StaveOperation) =>
    Effect.forkIn(
      runOperationBody(entry, operation).pipe(
        Effect.exit,
        Effect.flatMap((exit) => finish(entry, exit)),
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
      case "registerRepo":
        return cli
          .reposAdd({
            name: operation.name,
            url: operation.url,
            adopt: operation.adopt,
            dryRun: true,
          })
          .pipe(Effect.flatMap((outcome) => expectPlan("repos add", outcome)));
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

  return StaveOperations.of({ run, observe, dryRun, withSpaceLock, summary });
});

export const layer = Layer.effect(StaveOperations, make());

export const layerWith = (limits: StaveOperationsLimits) =>
  Layer.effect(StaveOperations, make(limits));

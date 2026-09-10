import type * as Scope from "effect/Scope";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as ServerSettings from "../serverSettings.ts";
import * as StaveBinary from "./StaveBinary.ts";
import { layer as cliLive } from "./StaveCli.ts";
import * as StaveRuntimeFence from "./StaveRuntimeFence.ts";
import * as StaveExecution from "./StaveExecution.ts";
import { AnalyticsService } from "../telemetry/AnalyticsService.ts";
import {
  type StaveLifecycleRow,
  type StaveLifecycleRepositoryShape,
  StaveLifecycleRepository,
} from "../persistence/Services/StaveLifecycleRepository.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import * as StaveSpaceLock from "./StaveSpaceLock.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type OrchestrationCommand,
  type OrchestrationProject,
  type OrchestrationProjectShell,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ThreadId,
  type StaveCreateSpaceOperation,
  type StaveProjectInfo,
  type StaveOperation,
  type StaveProgressEvent,
  type StaveRunOperationInput,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProcessRunner, type ProcessRunInput, type ProcessRunOutput } from "../processRunner.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as StaveAdmission from "./StaveAdmission.ts";
import { StaveCli, type StaveCliShape, type StaveSpaceCreateInput } from "./StaveCli.ts";
import * as StaveConfigReader from "./StaveConfigReader.ts";
import { StaveError } from "./StaveError.ts";
import type {
  StaveDryRunPlan,
  StaveReposAddResult,
  StaveSetupResult,
  StaveSpaceDestroyResult,
  StaveSpaceMutationResult,
  StaveSpaceStatus,
} from "./staveJson.ts";
import {
  layerWith,
  layer as productionOperationsLayer,
  StaveOperations,
  StaveRefusalError,
  type StaveOperationsLimits,
  type StaveOperationsShape,
  sameManifestIncarnation,
} from "./StaveOperations.ts";
import { STAVE_ARCHIVE_DIRECTORY_NAME, StaveWorkspaceReader } from "./StaveWorkspaceReader.ts";

// ── Fixtures ──────────────────────────────────────────────────

const SPACE_ID = "demo";
const CREATED_AT = "2026-09-01T00:00:00Z";
const NOW = "2026-09-07T00:00:00.000Z";
const CONFIG_PATH = "/cfg/stave/config.yaml";
const PLAN: StaveDryRunPlan = { dryRun: true, plan: ["would create space demo"] };
const ENGINE_SEQUENCE = 42;
const CREATE_NOTES = [
  "Windows: symlink unavailable; copied reference verbatim. C:\\work\\notes",
  "wrote .stave.yaml",
];

const manifest = (id: string, createdAt: string = CREATED_AT) => ({
  id,
  createdAt,
  repos: [],
  memories: [],
});

const mutationResult = (
  id: string,
  spacePath: string,
  notes: ReadonlyArray<string> = [],
): StaveSpaceMutationResult => ({ spaceId: id, spacePath, manifest: manifest(id), notes });

const statusResult = (
  id: string,
  spacePath: string,
  createdAt: string = CREATED_AT,
): StaveSpaceStatus => ({
  spaceId: id,
  spacePath,
  manifest: manifest(id, createdAt),
  repos: [],
  memories: [],
});

const destroyResult = (id: string, spacePath: string): StaveSpaceDestroyResult => ({
  spaceId: id,
  spacePath,
  destroyed: true,
  memory: "keep",
  notes: [],
});

const reposAddResult = (name: string, url: string): StaveReposAddResult => ({
  name,
  url,
  bareRepoPath: `/bare/${name}.git`,
  adopted: false,
  notes: [],
});

const setupResult: StaveSetupResult = {
  configPath: CONFIG_PATH,
  root: "/stave",
  bareReposDir: "/stave/bare",
  agentWorkDir: "/stave/agent-work",
  created: ["/stave"],
  existed: [],
};

const createSpaceOperation = (
  overrides: Partial<StaveCreateSpaceOperation> = {},
): StaveCreateSpaceOperation => ({
  kind: "createSpace",
  spaceId: SPACE_ID,
  edits: [{ repo: "api", base: "main" }],
  references: [],
  memory: [],
  after: [],
  common: false,
  includeWeak: false,
  noLearn: false,
  ...overrides,
});

const projectShell = (id: string, workspaceRoot: string): OrchestrationProjectShell => ({
  id: ProjectId.make(id),
  title: `Project ${id}`,
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: NOW,
  updatedAt: NOW,
});

const project = (id: string, workspaceRoot: string): OrchestrationProject => ({
  ...projectShell(id, workspaceRoot),
  deletedAt: null,
});

const processOutput = (stdout: string): ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

// ── Harness ───────────────────────────────────────────────────

interface Roots {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  /** Directory standing in for Stave's `agentWorkDir`. */
  readonly agentWorkDir: string;
}

type CliFakes = Pick<
  StaveCliShape,
  "spaceCreate" | "spaceStatus" | "spaceDestroy" | "reposAdd" | "setup"
>;

interface CliCall {
  readonly method: keyof CliFakes;
  readonly input: unknown;
}

interface HarnessOptions {
  readonly productionLayer?: boolean;
  readonly settingsEnabled?: boolean;
  readonly serverEnabled?: boolean;
  readonly threadAnchors?: ProjectionSnapshotQuery["Service"]["listThreadLifecycleAnchorsByProjectId"];
  readonly executionLayer?: Layer.Layer<StaveExecution.StaveExecution>;
  readonly cliLayer?: Layer.Layer<StaveCli>;
  readonly configReaderLayer?: Layer.Layer<StaveConfigReader.StaveConfigReader>;
  /** Replaces the scenario's temp directory (the alias test points at a symlinked root). */
  readonly agentWorkDir?: string;
  readonly configExists?: boolean;
  readonly limits?: StaveOperationsLimits;
  readonly cli?: Partial<CliFakes>;
  readonly cliExtra?: Partial<StaveCliShape>;
  readonly readerLoad?: StaveWorkspaceReader["Service"]["load"];
  readonly lifecycle?: Partial<StaveLifecycleRepositoryShape>;
  readonly quiesced?: Array<string>;
  readonly onQuiesce?: Effect.Effect<void>;
  /** Stdout the fake `git` answers with; defaults to nothing. */
  readonly processStdout?: (input: ProcessRunInput) => string;
  readonly shellProjects?: ReadonlyArray<OrchestrationProjectShell>;
  /** What `getActiveProjectByWorkspaceRoot` answers for every root. */
  readonly activeProject?: OrchestrationProject;
  /** Called with the running count on every config load (ordering probe for lock tests). */
  readonly onConfigLoad?: (count: number) => Effect.Effect<void>;
}

interface Harness extends Roots {
  readonly analytics: Array<{
    event: string;
    properties: Readonly<Record<string, unknown>> | undefined;
  }>;
  readonly layer: Layer.Layer<StaveOperations>;
  readonly cliCalls: Ref.Ref<ReadonlyArray<CliCall>>;
  readonly dispatched: Ref.Ref<ReadonlyArray<OrchestrationCommand>>;
  readonly invalidated: Ref.Ref<ReadonlyArray<string>>;
}

/** The on-disk effect of a real `stave space create`: the space directory appears. */
const createSpaceOnDisk =
  (roots: Roots) =>
  (
    input: StaveSpaceCreateInput,
  ): Effect.Effect<StaveSpaceMutationResult | StaveDryRunPlan, StaveError> =>
    Effect.gen(function* () {
      if (input.dryRun === true) {
        return PLAN;
      }
      const spacePath = roots.path.join(roots.agentWorkDir, input.id);
      yield* roots.fs.makeDirectory(spacePath).pipe(Effect.orDie);
      return mutationResult(input.id, spacePath, CREATE_NOTES);
    });

/** A create that parks inside `stave space create` until `gate` opens; `reached` reports arrival. */
const gatedCreate =
  (
    roots: Roots,
    gates: { readonly reached: Deferred.Deferred<void>; readonly gate: Deferred.Deferred<void> },
  ): CliFakes["spaceCreate"] =>
  (input) =>
    Deferred.succeed(gates.reached, undefined).pipe(
      Effect.flatMap(() => Deferred.await(gates.gate)),
      Effect.flatMap(() => createSpaceOnDisk(roots)(input)),
    );

const makeGates = Effect.gen(function* () {
  const reached = yield* Deferred.make<void>();
  const gate = yield* Deferred.make<void>();
  return { reached, gate };
});

const makeHarness = (roots: Roots, options: HarnessOptions) =>
  Effect.gen(function* () {
    const analytics: Array<{
      event: string;
      properties: Readonly<Record<string, unknown>> | undefined;
    }> = [];
    const cliCalls = yield* Ref.make<ReadonlyArray<CliCall>>([]);
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const invalidated = yield* Ref.make<ReadonlyArray<string>>([]);
    const configLoads = yield* Ref.make(0);
    const { fs, path, agentWorkDir } = roots;

    /** Logs `(method, first argument)` before delegating to the fake. */
    const record =
      <Args extends ReadonlyArray<unknown>, A, E>(
        method: keyof CliFakes,
        fake: (...args: Args) => Effect.Effect<A, E>,
      ) =>
      (...args: Args) =>
        Ref.update(cliCalls, (calls) => [...calls, { method, input: args[0] }]).pipe(
          Effect.flatMap(() => fake(...args)),
        );

    const defaults: CliFakes = {
      spaceCreate: createSpaceOnDisk(roots),
      spaceStatus: (id) => Effect.succeed(statusResult(id, path.join(agentWorkDir, id))),
      spaceDestroy: (input) =>
        Effect.succeed(destroyResult(input.id, path.join(agentWorkDir, input.id))),
      reposAdd: (input) =>
        Effect.succeed(input.dryRun === true ? PLAN : reposAddResult(input.name, input.url)),
      setup: () => Effect.succeed(setupResult),
    };
    const fakes: CliFakes = { ...defaults, ...options.cli };

    const root = path.dirname(agentWorkDir);
    const snapshot: StaveConfigReader.StaveConfigSnapshot =
      options.configExists === false
        ? { configPath: CONFIG_PATH, exists: false, repos: [], source: "fs-fallback" }
        : {
            configPath: CONFIG_PATH,
            exists: true,
            root,
            bareReposDir: path.join(root, "bare"),
            agentWorkDir,
            repos: [
              {
                name: "api",
                url: "https://example.com/api.git",
                bareRepoPath: path.join(root, "bare", "api.git"),
              },
            ],
            source: "fs-fallback",
          };
    const configReader = Layer.succeed(
      StaveConfigReader.StaveConfigReader,
      StaveConfigReader.StaveConfigReader.of({
        load: Ref.updateAndGet(configLoads, (count) => count + 1).pipe(
          Effect.flatMap((count) => options.onConfigLoad?.(count) ?? Effect.void),
          Effect.as(snapshot),
        ),
        invalidate: Effect.void,
      }),
    );

    const layer = (
      options.productionLayer ? productionOperationsLayer : layerWith(options.limits ?? {})
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          options.executionLayer ?? StaveExecution.layerNoop,
          StaveRuntimeFence.layerNoop,
          Layer.succeed(
            AnalyticsService,
            AnalyticsService.of({
              record: (event, properties) =>
                Effect.sync(() => {
                  analytics.push({ event, properties });
                }),
              flush: Effect.void,
            }),
          ),
          options.cliLayer ??
            Layer.mock(StaveCli)({
              sagaList: Effect.succeed([]),
              spaceCreate: record("spaceCreate", fakes.spaceCreate),
              spaceStatus: record("spaceStatus", fakes.spaceStatus),
              spaceDestroy: record("spaceDestroy", fakes.spaceDestroy),
              reposAdd: record("reposAdd", fakes.reposAdd),
              setup: record("setup", fakes.setup),
              ...options.cliExtra,
            }),
          options.configReaderLayer ?? configReader,
          Layer.mock(StaveLifecycleRepository)({
            getByWorkspaceRoot: () => Effect.succeed(Option.none()),
            ...options.lifecycle,
          }),
          Layer.mock(ProviderService)({
            listSessions: () => Effect.succeed([]),
            stopSessionsUnder: () =>
              Effect.sync(() => {
                options.quiesced?.push("providers");
              }).pipe(Effect.andThen(options.onQuiesce ?? Effect.void)),
          }),
          Layer.mock(TerminalManager)({
            closeSessionsUnder: () =>
              Effect.sync(() => {
                options.quiesced?.push("terminals");
              }),
          }),
          StaveSpaceLock.layer,
          Layer.mock(StaveWorkspaceReader)({
            load: options.readerLoad ?? (() => Effect.succeed(Option.none())),
            invalidate: (workspaceRoot) =>
              Ref.update(invalidated, (roots) => [...roots, workspaceRoot]),
          }),
          Layer.mock(ProcessRunner)({
            run: (input) => Effect.succeed(processOutput(options.processStdout?.(input) ?? "")),
          }),
          Layer.mock(OrchestrationEngineService)({
            dispatch: (command) =>
              Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                Effect.as({ sequence: ENGINE_SEQUENCE }),
              ),
          }),
          Layer.mock(ProjectionSnapshotQuery)({
            listThreadLifecycleAnchorsByProjectId:
              options.threadAnchors ?? (() => Effect.succeed([])),
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 0,
                projects: options.shellProjects ?? [],
                threads: [],
                updatedAt: NOW,
              }),
            getProjectShellById: (id) =>
              Effect.succeed(
                Option.fromNullishOr(
                  options.activeProject ??
                    options.shellProjects?.find((project) => project.id === id),
                ),
              ),
            getActiveProjectByWorkspaceRoot: (root) =>
              Effect.succeed(
                Option.fromNullishOr(
                  options.activeProject ??
                    options.shellProjects?.find((project) => project.workspaceRoot === root),
                ).pipe(Option.map((project) => ({ ...project, deletedAt: null }))),
              ),
          }),
          WorkspacePaths.layer,
          Layer.effect(
            ServerConfig.ServerConfig,
            Effect.gen(function* () {
              const current = yield* ServerConfig.ServerConfig;
              return { ...current, staveEnabled: options.serverEnabled ?? current.staveEnabled };
            }),
          ).pipe(
            Layer.provide(
              ServerConfig.layerTest(process.cwd(), { prefix: "t3-stave-operations-" }),
            ),
          ),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              stave: { ...DEFAULT_SERVER_SETTINGS.stave, enabled: options.settingsEnabled ?? true },
            }),
          }),
          StaveAdmission.layerNoop,
        ),
      ),
      Layer.provide(NodeServices.layer),
      Layer.orDie,
    );

    const harness: Harness = {
      fs,
      path,
      agentWorkDir,
      layer,
      analytics,
      cliCalls,
      dispatched,
      invalidated,
    };
    return harness;
  });

/**
 * One test: a scoped temp `agentWorkDir`, a harness built from `options`
 * (static, or derived from the roots when the test prepares disk or gates
 * first), and `body` run against that single StaveOperations instance. The
 * resolved options are handed back so a body can reach the gates it built.
 */
const scenario = <Options extends HarnessOptions, A, E>(
  options: Options | ((roots: Roots) => Effect.Effect<Options, never, Scope.Scope>),
  body: (harness: Harness, options: Options) => Effect.Effect<A, E, StaveOperations>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "stave-operations-" });
    const roots: Roots = { fs, path, agentWorkDir: yield* fs.realPath(tempDir) };
    const resolved = typeof options === "function" ? yield* options(roots) : options;
    const harness = yield* makeHarness(
      { ...roots, agentWorkDir: resolved.agentWorkDir ?? roots.agentWorkDir },
      resolved,
    );
    return yield* body(harness, resolved).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

// ── Event helpers ─────────────────────────────────────────────

type EventOf<Kind extends StaveProgressEvent["kind"]> = Extract<StaveProgressEvent, { kind: Kind }>;

const ofKind =
  <Kind extends StaveProgressEvent["kind"]>(kind: Kind) =>
  (event: StaveProgressEvent): event is EventOf<Kind> =>
    event.kind === kind;

/** `kind:phase` per event, the shape most ordering assertions compare. */
const outline = (events: ReadonlyArray<StaveProgressEvent>) =>
  events.map((event) => ("phase" in event ? `${event.kind}:${event.phase}` : event.kind));

const sequences = (events: ReadonlyArray<StaveProgressEvent>) =>
  events.map((event) => event.sequence);

const countingFrom = (start: number, length: number) =>
  Array.from({ length }, (_, index) => start + index);

const phaseStarted = (events: ReadonlyArray<StaveProgressEvent>, phase: string) => {
  const found = events.filter(ofKind("phase_started")).find((event) => event.phase === phase);
  if (found === undefined) {
    throw new Error(`no phase_started for '${phase}' in ${outline(events).join(", ")}`);
  }
  return found;
};

const preflightNote = (events: ReadonlyArray<StaveProgressEvent>) =>
  events.filter(ofKind("output")).find((event) => event.phase === "pre-flight");

const terminal = (events: ReadonlyArray<StaveProgressEvent>) => {
  const last = events.at(-1);
  if (last === undefined || (last.kind !== "finished" && last.kind !== "failed")) {
    throw new Error(`stream did not end with a terminal event: ${outline(events).join(", ")}`);
  }
  return last;
};

const finishedResult = (events: ReadonlyArray<StaveProgressEvent>) => {
  const last = terminal(events);
  if (last.kind !== "finished") {
    throw new Error(`expected finished, got failed: ${JSON.stringify(last.error)}`);
  }
  return last.result;
};

const failedError = (events: ReadonlyArray<StaveProgressEvent>) => {
  const last = terminal(events);
  if (last.kind !== "failed") {
    throw new Error(`expected failed, got finished: ${last.result.kind}`);
  }
  return last.error;
};

const collect = (ops: StaveOperationsShape, input: StaveRunOperationInput) =>
  Stream.runCollect(ops.run(input));

const runToEnd = (ops: StaveOperationsShape, operationId: string, operation: StaveOperation) =>
  Effect.gen(function* () {
    if (
      (operation.kind === "sagaArchive" || operation.kind === "sagaDestroy") &&
      operation.expectedSagaReview === undefined
    ) {
      const plan = yield* ops.dryRun(operation).pipe(Effect.option);
      if (Option.isSome(plan) && plan.value.sagaReview !== undefined)
        operation = { ...operation, expectedSagaReview: plan.value.sagaReview.fingerprint };
    }
    return yield* collect(ops, { operationId, operation });
  });

const summaryOf = (ops: StaveOperationsShape, operationId: string) =>
  ops.summary(operationId).pipe(
    Effect.map((summary) => {
      if (Option.isNone(summary)) {
        throw new Error(`no summary for '${operationId}'`);
      }
      return summary.value;
    }),
  );

const methodsCalled = (calls: ReadonlyArray<CliCall>) => calls.map((call) => call.method);

// ── Tests ─────────────────────────────────────────────────────

describe("StaveOperations createSpace", () => {
  it.effect("runs pre-flight, space create, verify and project.create in order and finishes", () =>
    scenario({}, (harness) =>
      Effect.gen(function* () {
        const ops = yield* StaveOperations;
        const spacePath = harness.path.join(harness.agentWorkDir, SPACE_ID);

        const events = yield* runToEnd(ops, "op-1", createSpaceOperation({ title: "Demo space" }));

        expect(outline(events)).toEqual([
          "phase_started:pre-flight",
          "phase_finished:pre-flight",
          "phase_started:space create",
          "output:space create",
          "output:space create",
          "phase_finished:space create",
          "phase_started:verify",
          "phase_finished:verify",
          "phase_started:project.create",
          "phase_finished:project.create",
          "finished",
        ]);
        expect(sequences(events)).toEqual(countingFrom(1, events.length));

        const create = phaseStarted(events, "space create");
        expect(create.commandLine?.startsWith("stave space create --json")).toBe(true);
        expect(create.commandLine).toContain("--edit=api:main");
        expect(create.commandLine?.endsWith(` ${SPACE_ID}`)).toBe(true);
        expect(phaseStarted(events, "verify").commandLine).toBe(
          `stave space status --json ${SPACE_ID}`,
        );
        expect(phaseStarted(events, "project.create").commandLine).toBeUndefined();

        const notes = events.filter(ofKind("output"));
        expect(notes.map((note) => note.stream)).toEqual(["notes", "notes"]);
        expect(notes.map((note) => note.text)).toEqual(CREATE_NOTES);

        const result = finishedResult(events);
        expect(result.kind).toBe("createSpace");
        if (result.kind !== "createSpace") {
          return;
        }
        expect(result.result.spacePath).toBe(spacePath);
        expect(result.result.projectId.length).toBeGreaterThan(0);
        expect(result.result.sequence).toBe(ENGINE_SEQUENCE);

        const dispatched = yield* Ref.get(harness.dispatched);
        expect(dispatched).toHaveLength(1);
        const command = dispatched[0];
        expect(command?.type).toBe("project.create");
        if (command?.type !== "project.create") {
          return;
        }
        expect(command.title).toBe("Demo space");
        expect(command.workspaceRoot).toBe(spacePath);
        expect(command.createWorkspaceRootIfMissing).toBe(false);
        expect(command.projectId).toBe(result.result.projectId);
        expect(command.commandId.startsWith(`server:stave:create:${SPACE_ID}:`)).toBe(true);

        expect(yield* Ref.get(harness.invalidated)).toEqual([spacePath]);
        expect(methodsCalled(yield* Ref.get(harness.cliCalls))).toEqual([
          "spaceCreate",
          "spaceStatus",
        ]);
        expect((yield* summaryOf(ops, "op-1")).state).toBe("finished");
      }),
    ),
  );

  it.effect("titles the project after the space id when no title is given", () =>
    scenario({}, (harness) =>
      Effect.gen(function* () {
        const ops = yield* StaveOperations;
        const events = yield* runToEnd(ops, "op-untitled", createSpaceOperation());
        expect(finishedResult(events).kind).toBe("createSpace");
        const command = (yield* Ref.get(harness.dispatched))[0];
        expect(command?.type === "project.create" ? command.title : null).toBe(SPACE_ID);
      }),
    ),
  );

  it.effect("writes specText to a temp file passed as --spec and removes it afterwards", () =>
    scenario(
      (roots) =>
        Effect.gen(function* () {
          const seen = yield* Ref.make<{ readonly spec: string; readonly content: string } | null>(
            null,
          );
          return {
            seen,
            cli: {
              spaceCreate: (input) =>
                Effect.gen(function* () {
                  const spec = input.spec ?? "";
                  const content = yield* roots.fs.readFileString(spec).pipe(Effect.orDie);
                  yield* Ref.set(seen, { spec, content });
                  return yield* createSpaceOnDisk(roots)(input);
                }),
            },
          } satisfies HarnessOptions & { readonly seen: unknown };
        }),
      (harness, { seen }) =>
        Effect.gen(function* () {
          const ops = yield* StaveOperations;
          const specText = "# Demo\n\nBuild the thing.\n";
          const events = yield* runToEnd(ops, "op-spec", createSpaceOperation({ specText }));
          expect(finishedResult(events).kind).toBe("createSpace");

          const observed = yield* Ref.get(seen);
          expect(observed?.content).toBe(specText);
          expect(observed?.spec.endsWith(".md")).toBe(true);
          if (observed === null) {
            return;
          }
          expect(phaseStarted(events, "space create").commandLine).toContain(
            `--spec=${observed.spec}`,
          );
          expect(yield* harness.fs.exists(observed.spec)).toBe(false);
        }),
    ),
  );
});

describe("StaveOperations attach and registry", () => {
  it.effect("attaches to a running operation, replays after the cursor, then follows live", () =>
    scenario(
      (roots) =>
        makeGates.pipe(
          Effect.map((gates) => ({ gates, cli: { spaceCreate: gatedCreate(roots, gates) } })),
        ),
      (_, { gates }) =>
        Effect.gen(function* () {
          const ops = yield* StaveOperations;
          const operation = createSpaceOperation();

          const first = yield* Effect.forkChild(runToEnd(ops, "op-attach", operation));
          yield* Deferred.await(gates.reached);

          // Sequence 3 (space create started) is replayed at once, so the
          // second collector is provably attached while the op still runs.
          const secondSeen: Array<StaveProgressEvent> = [];
          const secondFirstEvent = yield* Deferred.make<void>();
          const second = yield* Effect.forkChild(
            ops.observe({ operationId: "op-attach", afterSequence: 2 }).pipe(
              Stream.runForEach((event) =>
                Effect.sync(() => {
                  secondSeen.push(event);
                }).pipe(Effect.flatMap(() => Deferred.succeed(secondFirstEvent, undefined))),
              ),
            ),
          );
          yield* Deferred.await(secondFirstEvent);
          expect(sequences(secondSeen)).toEqual([3]);
          expect((yield* summaryOf(ops, "op-attach")).state).toBe("running");

          yield* Deferred.succeed(gates.gate, undefined);
          const firstEvents = yield* Fiber.join(first);
          yield* Fiber.join(second);

          expect(sequences(firstEvents)).toEqual(countingFrom(1, firstEvents.length));
          expect(secondSeen).toEqual(firstEvents.slice(2));
          expect(terminal(secondSeen)).toEqual(terminal(firstEvents));

          // After the terminal event a fresh attach is a pure replay.
          const third = yield* runToEnd(ops, "op-attach", operation);
          expect(third).toEqual(firstEvents);
          expect((yield* summaryOf(ops, "op-attach")).state).toBe("finished");
        }),
    ),
  );

  it.effect("refuses a different payload under a known id and an unknown id on observe", () =>
    scenario({}, () =>
      Effect.gen(function* () {
        const ops = yield* StaveOperations;
        const events = yield* runToEnd(ops, "op-fp", createSpaceOperation());
        expect(finishedResult(events).kind).toBe("createSpace");

        const rejected = yield* Effect.flip(
          runToEnd(ops, "op-fp", createSpaceOperation({ title: "Different" })),
        );
        expect(rejected.code).toBe("invalid_arguments");
        expect(rejected.operationId).toBe("op-fp");

        const unknown = yield* Effect.flip(Stream.runCollect(ops.observe({ operationId: "nope" })));
        expect(unknown.code).toBe("invalid_arguments");
      }),
    ),
  );

  it.effect("sends a reset before the retained tail once the ring buffer evicted the front", () =>
    scenario({ limits: { eventLimit: 3 } }, () =>
      Effect.gen(function* () {
        const ops = yield* StaveOperations;
        const live = yield* runToEnd(ops, "op-ring", createSpaceOperation());
        expect(live.length).toBeGreaterThan(3);
        expect(terminal(live).kind).toBe("finished");

        const summary = yield* summaryOf(ops, "op-ring");
        expect(summary.bufferedEvents).toBe(3);
        expect(summary.earliestSequence).toBe(live.length - 2);
        expect(summary.nextSequence).toBe(live.length + 1);

        const observed = yield* Stream.runCollect(ops.observe({ operationId: "op-ring" }));
        const reset = observed[0];
        expect(reset?.kind).toBe("reset");
        if (reset?.kind !== "reset") {
          return;
        }
        expect(reset.earliestSequence).toBe(summary.earliestSequence);
        expect(reset.sequence).toBe(summary.earliestSequence - 1);
        expect(observed.slice(1)).toEqual(live.slice(-3));
        expect(terminal(observed).kind).toBe("finished");
      }),
    ),
  );

  it.effect("expires a finished operation after the retention window", () =>
    scenario({ limits: { retention: "1 hour" } }, () =>
      Effect.gen(function* () {
        const ops = yield* StaveOperations;
        const operation = createSpaceOperation();
        expect(finishedResult(yield* runToEnd(ops, "op-old", operation)).kind).toBe("createSpace");

        yield* TestClock.adjust("2 hours");

        const rerun = yield* Effect.flip(runToEnd(ops, "op-old", operation));
        expect(rerun.code).toBe("operation_expired");
        const observed = yield* Effect.flip(
          Stream.runCollect(ops.observe({ operationId: "op-old" })),
        );
        expect(observed.code).toBe("operation_expired");
        expect(Option.isNone(yield* ops.summary("op-old"))).toBe(true);
      }),
    ),
  );
});

describe("StaveOperations space lock", () => {
  it.effect(
    "serialises two creates of one space; the second fails pre-flight once the first lands",
    () =>
      scenario(
        (roots) =>
          Effect.gen(function* () {
            const gates = yield* makeGates;
            const secondLoaded = yield* Deferred.make<void>();
            return {
              gates,
              secondLoaded,
              cli: { spaceCreate: gatedCreate(roots, gates) },
              onConfigLoad: (count: number) =>
                count === 2
                  ? Deferred.succeed(secondLoaded, undefined).pipe(Effect.asVoid)
                  : Effect.void,
            };
          }),
        (harness, { gates, secondLoaded }) =>
          Effect.gen(function* () {
            const ops = yield* StaveOperations;

            const first = yield* Effect.forkChild(
              runToEnd(ops, "op-lock-1", createSpaceOperation({ title: "First" })),
            );
            yield* Deferred.await(gates.reached);

            const second = yield* Effect.forkChild(
              runToEnd(ops, "op-lock-2", createSpaceOperation({ title: "Second" })),
            );
            yield* Deferred.await(secondLoaded);
            // Pre-flight runs inside the lock, so the waiter has emitted nothing.
            const waiting = yield* summaryOf(ops, "op-lock-2");
            expect(waiting.state).toBe("running");
            expect(waiting.nextSequence).toBe(1);
            expect((yield* summaryOf(ops, "op-lock-1")).nextSequence).toBe(4);

            yield* Deferred.succeed(gates.gate, undefined);
            const firstEvents = yield* Fiber.join(first);
            const secondEvents = yield* Fiber.join(second);

            expect(finishedResult(firstEvents).kind).toBe("createSpace");
            expect(outline(secondEvents)).toEqual([
              "phase_started:pre-flight",
              "phase_finished:pre-flight",
              "failed",
            ]);
            expect(failedError(secondEvents).code).toBe("space_exists");
            const creates = (yield* Ref.get(harness.cliCalls)).filter(
              (call) => call.method === "spaceCreate",
            );
            expect(creates).toHaveLength(1);
          }),
      ),
  );

  it.effect("withSpaceLock serialises the same root and leaves other roots free", () =>
    scenario({}, (harness) =>
      Effect.gen(function* () {
        const ops = yield* StaveOperations;
        const root = harness.path.join(harness.agentWorkDir, "locked");
        const otherRoot = harness.path.join(harness.agentWorkDir, "free");
        const order: Array<string> = [];
        const holding = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();

        const holder = yield* Effect.forkChild(
          ops.withSpaceLock(
            root,
            Effect.gen(function* () {
              order.push("a-start");
              yield* Deferred.succeed(holding, undefined);
              yield* Deferred.await(gate);
              order.push("a-end");
            }),
          ),
        );
        yield* Deferred.await(holding);

        const waiter = yield* Effect.forkChild(
          ops.withSpaceLock(
            // The same directory spelled differently still shares the lock.
            `${root}${harness.path.sep}`,
            Effect.sync(() => {
              order.push("b");
            }),
          ),
        );
        yield* ops.withSpaceLock(
          otherRoot,
          Effect.sync(() => {
            order.push("c");
          }),
        );
        expect(order).toEqual(["a-start", "c"]);

        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(holder);
        yield* Fiber.join(waiter);
        expect(order).toEqual(["a-start", "c", "a-end", "b"]);
      }),
    ),
  );
});

describe("StaveOperations pre-flight", () => {
  for (const kind of ["createSpace", "createSaga"] as const) {
    for (const collision of ["case-alias", "dangling-link"] as const) {
      it.effect(
        `${kind} refuses a filesystem-resolved ${collision} candidate before CLI mutation`,
        () =>
          scenario(
            (roots) =>
              Effect.gen(function* () {
                const candidate = roots.path.join(roots.agentWorkDir, SPACE_ID);
                const differentlyCased = roots.path.join(roots.agentWorkDir, "DeMo");
                if (collision === "dangling-link") {
                  yield* roots.fs.symlink(roots.path.join(roots.agentWorkDir, "absent"), candidate);
                } else {
                  yield* roots.fs.makeDirectory(differentlyCased);
                  // On case-sensitive volumes this exercises the ordinary collision path;
                  // on case-insensitive volumes only the differently spelled entry exists.
                  if (!(yield* roots.fs.exists(candidate)))
                    yield* roots.fs.rename(differentlyCased, candidate);
                }
                const sagaCalls = yield* Ref.make(0);
                return {
                  candidate,
                  sagaCalls,
                  cliExtra: {
                    sagaCreate: () =>
                      Ref.update(sagaCalls, (count) => count + 1).pipe(Effect.as(PLAN)),
                  },
                };
              }).pipe(Effect.orDie),
            (harness, options) =>
              Effect.gen(function* () {
                const ops = yield* StaveOperations;
                const operation: StaveOperation =
                  kind === "createSpace"
                    ? createSpaceOperation()
                    : { kind, sagaId: SPACE_ID, references: [], memory: [] };
                expect(
                  failedError(yield* runToEnd(ops, `${kind}-${collision}`, operation)).code,
                ).toBe("space_exists");
                expect(yield* Ref.get(options.sagaCalls)).toBe(0);
                expect(yield* Ref.get(harness.cliCalls)).toEqual([]);
                expect(yield* Ref.get(harness.dispatched)).toEqual([]);
                if (collision === "dangling-link")
                  expect(yield* harness.fs.readLink(options.candidate)).toContain("absent");
                else expect(yield* harness.fs.readDirectory(options.candidate)).toEqual([]);
              }),
          ),
      );
    }
  }

  it.effect("refuses when something already sits at the candidate path", () =>
    scenario(
      (roots) =>
        roots.fs
          .makeDirectory(roots.path.join(roots.agentWorkDir, SPACE_ID))
          .pipe(Effect.orDie, Effect.as<HarnessOptions>({})),
      (harness) =>
        Effect.gen(function* () {
          const ops = yield* StaveOperations;
          const events = yield* runToEnd(ops, "op-exists", createSpaceOperation());
          expect(outline(events)).toEqual([
            "phase_started:pre-flight",
            "phase_finished:pre-flight",
            "failed",
          ]);
          const error = failedError(events);
          expect(error.code).toBe("space_exists");
          expect(error.verb).toBeUndefined();
          expect(yield* Ref.get(harness.cliCalls)).toEqual([]);
        }),
    ),
  );

  it.effect("refuses when a project already uses the directory through a symlinked root", () =>
    scenario(
      (roots) =>
        Effect.gen(function* () {
          const real = roots.path.join(roots.agentWorkDir, "A");
          const alias = roots.path.join(roots.agentWorkDir, "B");
          yield* roots.fs.makeDirectory(real).pipe(Effect.orDie);
          yield* roots.fs.symlink(real, alias).pipe(Effect.orDie);
          return {
            agentWorkDir: real,
            shellProjects: [projectShell("aliased", roots.path.join(alias, SPACE_ID))],
          };
        }),
      (harness) =>
        Effect.gen(function* () {
          const ops = yield* StaveOperations;
          const candidate = harness.path.join(harness.agentWorkDir, SPACE_ID);
          expect(yield* harness.fs.exists(candidate)).toBe(false);
          const events = yield* runToEnd(ops, "op-alias", createSpaceOperation());
          const error = failedError(events);
          expect(error.code).toBe("space_exists");
          expect(error.details).toMatchObject({ projectId: "aliased" });
          expect(yield* Ref.get(harness.cliCalls)).toEqual([]);
        }),
    ),
  );

  it.effect("warns about leftover branches from an earlier space and still creates", () =>
    scenario(
      {
        processStdout: (input) =>
          input.command === "git" && input.args.includes("branch") ? "  stave/demo/api\n" : "",
      },
      () =>
        Effect.gen(function* () {
          const ops = yield* StaveOperations;
          const events = yield* runToEnd(ops, "op-branches", createSpaceOperation());
          const warning = preflightNote(events);
          expect(warning?.stream).toBe("notes");
          expect(warning?.text).toContain("stave/demo/api");
          expect(warning?.text).toContain("'api'");
          expect(finishedResult(events).kind).toBe("createSpace");
        }),
    ),
  );

  it.effect("warns when several archived spaces already match the id", () =>
    scenario(
      (roots) =>
        Effect.gen(function* () {
          const archive = roots.path.join(roots.agentWorkDir, STAVE_ARCHIVE_DIRECTORY_NAME);
          for (const entry of [
            `${SPACE_ID}-20260101000000`,
            `${SPACE_ID}-20260102000000`,
            // A near miss must not count.
            `${SPACE_ID}-old`,
          ]) {
            yield* roots.fs
              .makeDirectory(roots.path.join(archive, entry), { recursive: true })
              .pipe(Effect.orDie);
          }
          return {};
        }),
      () =>
        Effect.gen(function* () {
          const ops = yield* StaveOperations;
          const events = yield* runToEnd(ops, "op-archives", createSpaceOperation());
          const warning = preflightNote(events);
          expect(warning?.stream).toBe("notes");
          expect(warning?.text).toContain("2 archived spaces");
          expect(warning?.text).toContain(`${SPACE_ID}-20260101000000`);
          expect(warning?.text).not.toContain(`${SPACE_ID}-old`);
          expect(finishedResult(events).kind).toBe("createSpace");
        }),
    ),
  );

  it.effect("refuses every space operation when Stave is not set up", () =>
    scenario({ configExists: false }, (harness) =>
      Effect.gen(function* () {
        const ops = yield* StaveOperations;
        const events = yield* runToEnd(ops, "op-unset", createSpaceOperation());
        expect(outline(events)).toEqual(["failed"]);
        const error = failedError(events);
        expect(error.code).toBe("not_setup");
        expect(error.details).toMatchObject({ configPath: CONFIG_PATH });
        expect(yield* Ref.get(harness.cliCalls)).toEqual([]);
      }),
    ),
  );
});

describe("StaveOperations partial spaces", () => {
  it.effect("leaves a partial space behind when verify fails and reports its manifest stamp", () =>
    scenario(
      {
        cli: {
          spaceStatus: () =>
            Effect.fail(
              new StaveError({
                code: "space_not_found",
                message: "space 'demo' not found",
                details: null,
                exitCode: 1,
                stderrTail: null,
                verb: "space status",
              }),
            ),
        },
      },
      (harness) =>
        Effect.gen(function* () {
          const ops = yield* StaveOperations;
          const spacePath = harness.path.join(harness.agentWorkDir, SPACE_ID);
          const events = yield* runToEnd(ops, "op-partial", createSpaceOperation());

          expect(outline(events).slice(-3)).toEqual([
            "phase_started:verify",
            "phase_finished:verify",
            "failed",
          ]);
          const error = failedError(events);
          expect(error.code).toBe("space_not_found");
          expect(error.verb).toBe("space status");
          expect(error.details?.partialSpace).toEqual({
            spaceId: SPACE_ID,
            spacePath,
            manifestCreatedAt: CREATED_AT,
          });

          expect(methodsCalled(yield* Ref.get(harness.cliCalls))).toEqual([
            "spaceCreate",
            "spaceStatus",
          ]);
          expect(yield* Ref.get(harness.dispatched)).toEqual([]);
          expect(yield* harness.fs.exists(spacePath)).toBe(true);
          const summary = yield* summaryOf(ops, "op-partial");
          expect(summary.state).toBe("failed");
          expect(summary.manifestCreatedAt).toBe(CREATED_AT);
        }),
    ),
  );

  it.effect("removePartialSpace refuses a space whose manifest stamp differs", () =>
    scenario({}, (harness) =>
      Effect.gen(function* () {
        const ops = yield* StaveOperations;
        const events = yield* runToEnd(ops, "op-remove-mismatch", {
          kind: "removePartialSpace",
          spaceId: SPACE_ID,
          expectedManifestCreatedAt: "2020-01-01T00:00:00Z",
        });
        expect(outline(events)).toEqual([
          "phase_started:pre-flight",
          "phase_finished:pre-flight",
          "failed",
        ]);
        const error = failedError(events);
        expect(error.code).toBe("incarnation_mismatch");
        expect(error.details).toMatchObject({
          expected: "2020-01-01T00:00:00Z",
          actual: CREATED_AT,
        });
        expect(methodsCalled(yield* Ref.get(harness.cliCalls))).toEqual(["spaceStatus"]);
        expect(yield* Ref.get(harness.invalidated)).toEqual([
          harness.path.join(harness.agentWorkDir, SPACE_ID),
        ]);
      }),
    ),
  );

  it.effect(
    "removePartialSpace destroys a matching bare partial without automatically forcing",
    () =>
      scenario({}, (harness) =>
        Effect.gen(function* () {
          const ops = yield* StaveOperations;
          const spacePath = harness.path.join(harness.agentWorkDir, SPACE_ID);
          const events = yield* runToEnd(ops, "op-remove", {
            kind: "removePartialSpace",
            spaceId: SPACE_ID,
            expectedManifestCreatedAt: CREATED_AT,
          });

          expect(outline(events)).toEqual([
            "phase_started:pre-flight",
            "phase_finished:pre-flight",
            "phase_started:space destroy",
            "phase_finished:space destroy",
            "finished",
          ]);
          expect(phaseStarted(events, "pre-flight").commandLine).toBe(
            `stave space status --json ${SPACE_ID}`,
          );
          const destroy = phaseStarted(events, "space destroy").commandLine;
          expect(destroy?.startsWith("stave space destroy --json")).toBe(true);
          expect(destroy).not.toContain("--force");
          expect(destroy).toContain("--memory=destroy");
          expect(finishedResult(events).kind).toBe("removePartialSpace");

          const calls = yield* Ref.get(harness.cliCalls);
          expect(methodsCalled(calls)).toEqual(["spaceStatus", "spaceDestroy"]);
          expect(calls[1]?.input).toEqual({ id: SPACE_ID, force: false, memory: "destroy" });
          expect(new Set(yield* Ref.get(harness.invalidated))).toEqual(new Set([spacePath]));

          expect(yield* Ref.get(harness.dispatched)).toEqual([]);
        }),
      ),
  );

  it.effect("removePartialSpace skips the refresh when no project sits on the root", () =>
    scenario({}, (harness) =>
      Effect.gen(function* () {
        const ops = yield* StaveOperations;
        const events = yield* runToEnd(ops, "op-remove-bare", {
          kind: "removePartialSpace",
          spaceId: SPACE_ID,
          expectedManifestCreatedAt: CREATED_AT,
        });
        expect(finishedResult(events).kind).toBe("removePartialSpace");
        expect(new Set(yield* Ref.get(harness.invalidated))).toEqual(
          new Set([harness.path.join(harness.agentWorkDir, SPACE_ID)]),
        );
        expect(yield* Ref.get(harness.dispatched)).toEqual([]);
      }),
    ),
  );
});

describe("StaveOperations registerRepo and setup", () => {
  it.effect(
    "registerRepo redacts the url in the shown command line but hands Stave the original",
    () =>
      scenario({}, (harness) =>
        Effect.gen(function* () {
          const ops = yield* StaveOperations;
          const url = "https://user:token@host/x.git";
          const events = yield* runToEnd(ops, "op-repo", {
            kind: "registerRepo",
            name: "x",
            url,
            adopt: false,
          });

          expect(outline(events)).toEqual([
            "phase_started:repos add",
            "phase_finished:repos add",
            "finished",
          ]);
          const commandLine = phaseStarted(events, "repos add").commandLine;
          expect(commandLine).toBe("stave repos add --json x https://***@host/x.git");
          expect(commandLine).not.toContain("token");
          const result = finishedResult(events);
          expect(result.kind).toBe("registerRepo");
          expect(result.result).toEqual(reposAddResult("x", url));

          const calls = yield* Ref.get(harness.cliCalls);
          expect(calls).toEqual([{ method: "reposAdd", input: { name: "x", url, adopt: false } }]);
        }),
      ),
  );

  it.effect("setup runs the single setup phase and finishes with the setup result", () =>
    scenario({}, (harness) =>
      Effect.gen(function* () {
        const ops = yield* StaveOperations;
        const events = yield* runToEnd(ops, "op-setup", { kind: "setup", force: true });
        expect(outline(events)).toEqual([
          "phase_started:setup",
          "phase_finished:setup",
          "finished",
        ]);
        expect(phaseStarted(events, "setup").commandLine).toBe("stave setup --json --force");
        const result = finishedResult(events);
        expect(result.kind).toBe("setup");
        expect(result.result).toEqual(setupResult);
        expect(yield* Ref.get(harness.cliCalls)).toEqual([
          { method: "setup", input: { force: true } },
        ]);
      }),
    ),
  );
});

describe("StaveOperations dryRun", () => {
  it.effect("asks Stave for a plan with --dry-run for createSpace and registerRepo", () =>
    scenario({}, (harness) =>
      Effect.gen(function* () {
        const ops = yield* StaveOperations;
        const created = yield* ops.dryRun(createSpaceOperation({ specText: "spec" }));
        expect(created).toEqual(PLAN);
        const registered = yield* ops.dryRun({
          kind: "registerRepo",
          name: "x",
          url: "https://host/x.git",
          adopt: true,
        });
        expect(registered).toEqual(PLAN);

        const calls = yield* Ref.get(harness.cliCalls);
        expect(methodsCalled(calls)).toEqual(["spaceCreate", "reposAdd"]);
        expect(calls[0]?.input).toMatchObject({ id: SPACE_ID, dryRun: true });
        expect(calls[1]?.input).toEqual({
          name: "x",
          url: "https://host/x.git",
          adopt: true,
          dryRun: true,
        });
        const candidate = harness.path.join(harness.agentWorkDir, SPACE_ID);
        expect(yield* harness.fs.exists(candidate)).toBe(false);
        expect(Option.isNone(yield* ops.summary("op-dry"))).toBe(true);
      }),
    ),
  );

  it.effect("refuses kinds without a dry run and answers that are not plans", () =>
    scenario(
      (roots) =>
        Effect.succeed({
          cli: {
            spaceCreate: (input: StaveSpaceCreateInput) =>
              Effect.succeed(
                mutationResult(input.id, roots.path.join(roots.agentWorkDir, input.id)),
              ),
          },
        }),
      () =>
        Effect.gen(function* () {
          const ops = yield* StaveOperations;
          const noDryRun = yield* Effect.flip(ops.dryRun({ kind: "setup", force: false }));
          expect(noDryRun).toBeInstanceOf(StaveError);
          expect(noDryRun.code).toBe("invalid_arguments");
          expect(noDryRun.verb).toBe("setup");

          const notAPlan = yield* Effect.flip(ops.dryRun(createSpaceOperation()));
          expect(notAPlan.code).toBe("unreadable");
          expect(notAPlan.verb).toBe("space create");
        }),
    ),
  );
});

describe("StaveOperations unreadable saga", () => {
  it.effect("refuses an unreadable saga without touching Stave", () =>
    scenario({}, (harness) =>
      Effect.gen(function* () {
        const ops = yield* StaveOperations;
        const events = yield* runToEnd(ops, "op-add", {
          kind: "sagaSync",
          sagaRoot: "/spaces/demo",
        });
        expect(outline(events)).toEqual(["failed"]);
        const error = failedError(events);
        expect(error.code).toBe("unreadable");
        expect(error.message).toContain("Cannot read");
        expect(yield* Ref.get(harness.cliCalls)).toEqual([]);
        expect((yield* summaryOf(ops, "op-add")).state).toBe("failed");
      }),
    ),
  );
});

const infoFor = (state: "live" | "archived" = "live"): StaveProjectInfo => ({
  spaceId: SPACE_ID,
  createdAt: CREATED_AT,
  isSaga: false,
  repos: [],
  memories: [],
  state,
  ...(state === "archived" ? { archiveBasename: SPACE_ID } : {}),
});
const lifecycleFixture = (root: string, disposition: StaveLifecycleRow["disposition"] = "live") => {
  let row: StaveLifecycleRow = {
    projectId: ProjectId.make("p"),
    workspaceRoot: root,
    spaceId: SPACE_ID,
    manifestCreatedAt: CREATED_AT,
    disposition,
    deleteIntentSequence: null,
    sagaRemoveConfirmed: false,
    sagaTeardown: null,
    refusalCode: null,
    refusalMessage: null,
    anchorAt: null,
    scheduledAt: null,
    archiveDeadlineAt: null,
    archiveBasename: null,
    leaseEpoch: 0,
    ownerToken: null,
    leaseUntil: null,
    updatedAt: NOW,
    refreshedAt: null,
  };
  const history: Array<string> = [];
  const service: Partial<StaveLifecycleRepositoryShape> = {
    ensure: () => Effect.succeed(row),
    getByProjectId: () => Effect.sync(() => Option.some(row)),
    getByWorkspaceRoot: () => Effect.sync(() => Option.some(row)),
    isProjectDeleted: () => Effect.succeed(true),
    resetScheduleEpisode: (input) =>
      Effect.sync(() => {
        row = {
          ...row,
          anchorAt: input.anchorAt,
          scheduledAt: input.scheduledAt,
          archiveDeadlineAt: input.archiveDeadlineAt,
          disposition: input.disposition,
        };
        return true;
      }),
    listIncomplete: () =>
      Effect.sync(() =>
        ["archiving", "restoring", "destroying", "destroyed"].includes(row.disposition)
          ? [row]
          : [],
      ),
    acquireLease: (input) =>
      Effect.sync(() => {
        row = {
          ...row,
          leaseEpoch: row.leaseEpoch + 1,
          ownerToken: input.ownerToken,
          leaseUntil: input.leaseUntil,
        };
        history.push("lease");
        return Option.some(row);
      }),
    updateDisposition: (input) =>
      Effect.sync(() => {
        row = { ...row, ...input.patch };
        if (input.patch.disposition) history.push(input.patch.disposition);
        return true;
      }),
    releaseLease: () =>
      Effect.sync(() => {
        row = { ...row, ownerToken: null, leaseUntil: null };
        history.push("release");
        return true;
      }),
  };
  return { service, history, row: () => row };
};
const listRow = (root: string) => ({
  id: SPACE_ID,
  logicalId: SPACE_ID,
  path: root,
  isSaga: false,
  repos: [],
  archived: false,
  manifestVersion: 1,
  memories: [],
});

for (const transient of ["configuration", "inventory"] as const) {
  it.effect(`retries moved-space recovery after correcting a transient ${transient} refusal`, () =>
    scenario(
      (roots) =>
        Effect.gen(function* () {
          const root = roots.path.join(roots.agentWorkDir, SPACE_ID);
          const archived = roots.path.join(roots.agentWorkDir, ".archive", SPACE_ID);
          yield* roots.fs.makeDirectory(archived, { recursive: true });
          const fixture = lifecycleFixture(root, "archiving");
          const corrected = yield* Ref.make(false);
          return {
            root,
            archived,
            fixture,
            corrected,
            activeProject: project("p", root),
            lifecycle: fixture.service,
            readerLoad: (candidate: string) =>
              Effect.succeed(
                candidate === archived ? Option.some(infoFor("archived")) : Option.none(),
              ),
            configReaderLayer: Layer.succeed(
              StaveConfigReader.StaveConfigReader,
              StaveConfigReader.StaveConfigReader.of({
                load: Ref.get(corrected).pipe(
                  Effect.map((fixed) => ({
                    configPath: CONFIG_PATH,
                    exists: true,
                    agentWorkDir:
                      transient === "configuration" && !fixed
                        ? roots.path.join(roots.agentWorkDir, "other-installation")
                        : roots.agentWorkDir,
                    repos: [],
                    source: "fs-fallback" as const,
                  })),
                ),
                invalidate: Effect.void,
              }),
            ),
            cliExtra: {
              spaceList: (input) =>
                Ref.get(corrected).pipe(
                  Effect.map((fixed) =>
                    transient === "inventory" && !fixed
                      ? [{ ...listRow(archived), error: "temporarily unreadable inventory" }]
                      : input?.archived
                        ? [listRow(archived)]
                        : [],
                  ),
                ),
            } satisfies Partial<StaveCliShape>,
          };
        }).pipe(Effect.orDie),
      (harness, options) =>
        Effect.gen(function* () {
          const ops = yield* StaveOperations;
          yield* ops.reconcileIncomplete;
          expect(options.fixture.row().disposition).toBe("archiving");
          expect(options.fixture.row().refusalCode).toBe(
            transient === "configuration" ? "invalid_arguments" : "unreadable",
          );
          expect(yield* Ref.get(harness.dispatched)).toEqual([]);
          yield* Ref.set(options.corrected, true);
          yield* ops.reconcileIncomplete;
          expect(options.fixture.row().disposition).toBe("archived");
          expect(options.fixture.row().workspaceRoot).toBe(options.archived);
          expect(
            (yield* Ref.get(harness.dispatched)).filter(
              (command) => command.type === "project.meta.update",
            ),
          ).toMatchObject([{ projectId: "p", workspaceRoot: options.archived }]);
          expect(options.fixture.history.filter((value) => value === "lease")).toHaveLength(2);
        }),
    ),
  );
}

for (const disposition of ["destroying", "destroyed"] as const) {
  it.effect(
    `${disposition} recovery retains a surviving manifestless directory and its project`,
    () =>
      scenario(
        (roots) =>
          Effect.gen(function* () {
            const root = roots.path.join(roots.agentWorkDir, SPACE_ID);
            yield* roots.fs.makeDirectory(root);
            yield* roots.fs.writeFileString(roots.path.join(root, "work.txt"), "preserve my work");
            const fixture = lifecycleFixture(root, disposition);
            return {
              root,
              fixture,
              activeProject: project("p", root),
              lifecycle: fixture.service,
              cliExtra: { spaceList: () => Effect.succeed([]) },
            };
          }).pipe(Effect.orDie),
        (harness, options) =>
          Effect.gen(function* () {
            yield* (yield* StaveOperations).reconcileIncomplete;
            expect(options.fixture.row().disposition).toBe(disposition);
            expect(options.fixture.row().refusalCode).toBe("unreadable");
            expect(yield* Ref.get(harness.dispatched)).toEqual([]);
            expect(
              yield* harness.fs.readFileString(harness.path.join(options.root, "work.txt")),
            ).toBe("preserve my work");
          }),
      ),
  );
}

it.effect("terminal recovery refuses a recreated incarnation at the same project root", () =>
  scenario(
    (roots) =>
      Effect.gen(function* () {
        const root = roots.path.join(roots.agentWorkDir, SPACE_ID);
        yield* roots.fs.makeDirectory(root);
        const fixture = lifecycleFixture(root, "destroyed");
        return {
          root,
          fixture,
          activeProject: project("p", root),
          lifecycle: fixture.service,
          readerLoad: () =>
            Effect.succeed(Option.some({ ...infoFor(), createdAt: "2026-09-02T00:00:00Z" })),
        };
      }).pipe(Effect.orDie),
    (harness, options) =>
      Effect.gen(function* () {
        yield* (yield* StaveOperations).reconcileIncomplete;
        expect(options.fixture.row().disposition).toBe("destroyed");
        expect(options.fixture.row().refusalCode).toBe("incarnation_mismatch");
        expect(yield* Ref.get(harness.dispatched)).toEqual([]);
        expect(yield* Ref.get(harness.cliCalls)).toEqual([]);
        expect(yield* harness.fs.exists(options.root)).toBe(true);
      }),
  ),
);

describe("StaveOperations lifecycle and edits", () => {
  it("compares full precision manifest instants", () => {
    expect(
      sameManifestIncarnation("2026-09-01T00:00:00.000000001Z", "2026-09-01T00:00:00.000000002Z"),
    ).toBe(false);
    expect(sameManifestIncarnation(CREATED_AT, "2026-08-31T16:00:00.000-08:00")).toBe(true);
  });
  it.effect("runs space edits and refreshes the owning project", () =>
    scenario(
      (roots) =>
        Effect.gen(function* () {
          const root = roots.path.join(roots.agentWorkDir, SPACE_ID);
          yield* roots.fs.makeDirectory(root).pipe(Effect.orDie);
          const seen: Array<string> = [];
          const result = mutationResult(SPACE_ID, root);
          return {
            root,
            seen,
            activeProject: project("p", root),
            readerLoad: () => Effect.succeed(Option.some(infoFor())),
            cliExtra: {
              spaceAdd: () =>
                Effect.sync(() => {
                  seen.push("add");
                  return result;
                }),
              spaceRemove: () =>
                Effect.sync(() => {
                  seen.push("remove");
                  return result;
                }),
              spaceRetarget: () =>
                Effect.sync(() => {
                  seen.push("retarget");
                  return result;
                }),
              spaceSync: () =>
                Effect.sync(() => {
                  seen.push("sync");
                  return {
                    spaceId: SPACE_ID,
                    spacePath: root,
                    manifest: manifest(SPACE_ID),
                    repos: [],
                    notes: [],
                  };
                }),
              memoryAttach: () =>
                Effect.sync(() => {
                  seen.push("attach");
                  return { ...result, attachments: [] };
                }),
              memoryDetach: () =>
                Effect.sync(() => {
                  seen.push("detach");
                  return { ...result, detached: [] };
                }),
            },
          };
        }),
      (harness, options) =>
        Effect.gen(function* () {
          const ops = yield* StaveOperations;
          const common = { workspaceRoot: options.root, expectedManifestCreatedAt: CREATED_AT };
          const operations: Array<StaveOperation> = [
            {
              ...common,
              kind: "addRepo",
              repo: "api",
              mode: "edit",
              noFetch: false,
              linkMemory: true,
            },
            { ...common, kind: "removeRepo", repo: "api", mode: "reference", force: false },
            { ...common, kind: "retarget", repo: "api", base: "main" },
            { ...common, kind: "syncSpace", referencesOnly: true },
            { ...common, kind: "memoryAttach", specs: [{ spec: "marmot:den" }] },
            { ...common, kind: "memoryDetach", fate: "keep" },
          ];
          for (const operation of operations)
            expect(finishedResult(yield* runToEnd(ops, operation.kind, operation)).kind).toBe(
              operation.kind,
            );
          expect(options.seen).toEqual(["add", "remove", "retarget", "sync", "attach", "detach"]);
          expect(
            (yield* Ref.get(harness.dispatched)).filter(
              (command) => command.type === "project.refresh",
            ),
          ).toHaveLength(6);
        }),
    ),
  );
  it.effect("refuses missing incarnation before invoking a destructive command", () =>
    scenario(
      (roots) =>
        Effect.gen(function* () {
          const root = roots.path.join(roots.agentWorkDir, SPACE_ID);
          yield* roots.fs.makeDirectory(root).pipe(Effect.orDie);
          return { root, readerLoad: () => Effect.succeed(Option.some(infoFor())) };
        }),
      (harness, options) =>
        Effect.gen(function* () {
          const ops = yield* StaveOperations;
          const events = yield* runToEnd(ops, "destroy", {
            kind: "destroySpace",
            workspaceRoot: options.root,
            force: true,
            memory: "destroy",
          });
          expect(failedError(events).code).toBe("incarnation_mismatch");
          expect(yield* Ref.get(harness.cliCalls)).toEqual([]);
        }),
    ),
  );
  it.effect(
    "keeps captured config and binary through quiescence, destructive CLI and failure reconciliation",
    () =>
      scenario(
        (roots) =>
          Effect.gen(function* () {
            const root = roots.path.join(roots.agentWorkDir, SPACE_ID);
            const rootB = roots.path.join(roots.agentWorkDir, "other", SPACE_ID);
            yield* roots.fs.makeDirectory(root, { recursive: true }).pipe(Effect.orDie);
            yield* roots.fs.makeDirectory(rootB, { recursive: true }).pipe(Effect.orDie);
            const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
            yield* roots.fs
              .writeFileString(
                roots.path.join(root, ".stave.yaml"),
                yield* encode(manifest(SPACE_ID)),
              )
              .pipe(Effect.orDie);
            yield* roots.fs
              .writeFileString(
                roots.path.join(rootB, ".stave.yaml"),
                yield* encode(manifest(SPACE_ID, "2026-09-02T00:00:00Z")),
              )
              .pipe(Effect.orDie);
            const configA = roots.path.join(roots.agentWorkDir, "config-a.yaml");
            const configB = roots.path.join(roots.agentWorkDir, "config-b.yaml");
            const config = (work: string) => ({
              root: roots.agentWorkDir,
              agentWorkDir: work,
              bareReposDir: roots.path.join(roots.agentWorkDir, "bare"),
              repos: {},
            });
            const bytesA = yield* encode(config(roots.agentWorkDir));
            const bytesB = yield* encode(config(roots.path.dirname(rootB)));
            yield* roots.fs.writeFileString(configA, bytesA).pipe(Effect.orDie);
            yield* roots.fs.writeFileString(configB, bytesB).pipe(Effect.orDie);
            const settingsContext = yield* Layer.build(
              ServerSettings.layerTest({ stave: { configPath: configA, binaryPath: "/binary-a" } }),
            );
            const settings = Context.get(settingsContext, ServerSettings.ServerSettingsService);
            const settingsLayer = Layer.succeed(ServerSettings.ServerSettingsService, settings);
            const binaryLayer = StaveBinary.layerFixed({
              path: "/binary-a",
              source: "settings",
              version: "0.4.0",
              commit: null,
            });
            const calls: Array<{
              command: string;
              configPath: string;
              verb: string;
              bytes: string;
            }> = [];
            const runner = Layer.mock(ProcessRunner)({
              run: (input) =>
                Effect.gen(function* () {
                  const args = input.args ?? [];
                  const configPath = args[args.indexOf("--config") + 1]!;
                  const bytes = yield* roots.fs.readFileString(configPath).pipe(Effect.orDie);
                  const verb = args
                    .filter(
                      (arg, index) => arg !== "--config" && index !== args.indexOf("--config") + 1,
                    )
                    .slice(0, 2)
                    .join(" ");
                  calls.push({ command: input.command, configPath, verb, bytes });
                  if (verb === "config show")
                    return {
                      ...processOutput(
                        '{"error":{"code":"unknown","message":"use disk fallback"}}',
                      ),
                      code: ChildProcessSpawner.ExitCode(1),
                    };
                  if (verb === "space status")
                    return processOutput(
                      yield* encode(
                        statusResult(
                          SPACE_ID,
                          bytes === bytesA ? root : rootB,
                          bytes === bytesA ? CREATED_AT : "2026-09-02T00:00:00Z",
                        ),
                      ),
                    );
                  if (verb === "space destroy") {
                    yield* roots.fs
                      .remove(bytes === bytesA ? root : rootB, { recursive: true })
                      .pipe(Effect.orDie);
                    return {
                      ...processOutput(
                        '{"error":{"code":"unknown","message":"response lost after disk mutation"}}',
                      ),
                      code: ChildProcessSpawner.ExitCode(1),
                    };
                  }
                  if (verb === "saga list" || verb === "space list") return processOutput("[]");
                  return yield* Effect.die(`Unexpected Stave command: ${verb}`);
                }).pipe(Effect.orDie),
            });
            const cliLayer = cliLive.pipe(
              Layer.provide(Layer.mergeAll(binaryLayer, settingsLayer, runner)),
            );
            const configReaderLayer = StaveConfigReader.layer.pipe(
              Layer.provide(Layer.mergeAll(binaryLayer, settingsLayer, cliLayer)),
              Layer.provide(NodeServices.layer),
            );
            const executionLayer = StaveExecution.layer.pipe(
              Layer.provide(Layer.mergeAll(binaryLayer, settingsLayer)),
              Layer.provide(NodeServices.layer),
            );
            const fixture = lifecycleFixture(root);
            return {
              root,
              rootB,
              calls,
              bytesA,
              configA,
              configB,
              fixture,
              cliLayer,
              configReaderLayer,
              executionLayer,
              lifecycle: fixture.service,
              activeProject: project("p", root),
              readerLoad: () => Effect.succeed(Option.some(infoFor())),
              onQuiesce: settings
                .updateSettings({ stave: { configPath: configB, binaryPath: "/binary-b" } })
                .pipe(
                  Effect.andThen(roots.fs.writeFileString(configA, bytesB)),
                  Effect.asVoid,
                  Effect.orDie,
                ),
            };
          }).pipe(Effect.orDie),
        (harness, options) =>
          Effect.gen(function* () {
            const ops = yield* StaveOperations;
            const events = yield* runToEnd(ops, "captured-destroy", {
              kind: "destroySpace",
              workspaceRoot: options.root,
              expectedManifestCreatedAt: CREATED_AT,
              force: true,
              memory: "keep",
            });
            expect(failedError(events).message).toContain("response lost");
            expect(options.fixture.row().disposition).toBe("destroyed");
            expect(yield* harness.fs.exists(options.root)).toBe(false);
            expect(yield* harness.fs.exists(options.rootB)).toBe(true);
            expect(options.calls.some((call) => call.verb === "space list")).toBe(true);
            expect(
              options.calls.every(
                (call) => call.command === "/binary-a" && call.bytes === options.bytesA,
              ),
            ).toBe(true);
            const paths = new Set(options.calls.map((call) => call.configPath));
            expect(paths.size).toBe(1);
            const captured = options.calls[0]!.configPath;
            expect(captured).not.toBe(options.configA);
            expect(captured).not.toBe(options.configB);
            expect(yield* harness.fs.exists(captured)).toBe(false);
          }),
      ),
  );
  it.effect("journals and quiesces before destroy then marks terminal before deleting", () =>
    scenario(
      (roots) =>
        Effect.gen(function* () {
          const root = roots.path.join(roots.agentWorkDir, SPACE_ID);
          yield* roots.fs.makeDirectory(root).pipe(Effect.orDie);
          const fixture = lifecycleFixture(root);
          const quiesced: Array<string> = [];
          return {
            root,
            fixture,
            quiesced,
            lifecycle: fixture.service,
            activeProject: project("p", root),
            readerLoad: () => Effect.succeed(Option.some(infoFor())),
            cliExtra: {
              sagaList: Effect.succeed([]),
              spaceDestroy: () =>
                Effect.sync(() => {
                  expect(fixture.row().disposition).toBe("destroying");
                  expect(quiesced).toEqual(["providers", "terminals"]);
                  return destroyResult(SPACE_ID, root);
                }),
            },
          };
        }),
      (harness, options) =>
        Effect.gen(function* () {
          const ops = yield* StaveOperations;
          expect(
            finishedResult(
              yield* runToEnd(ops, "destroy", {
                kind: "destroySpace",
                workspaceRoot: options.root,
                expectedManifestCreatedAt: CREATED_AT,
                force: false,
                memory: "keep",
              }),
            ).kind,
          ).toBe("destroySpace");
          expect(options.fixture.history).toEqual(["lease", "destroying", "destroyed", "release"]);
          expect(harness.analytics).toEqual([
            {
              event: "stave.space.destroyed",
              properties: { operationKind: "destroySpace", trigger: "interactive", count: 1 },
            },
          ]);
          expect(
            (yield* Ref.get(harness.dispatched)).some(
              (command) => command.type === "project.delete" && command.force,
            ),
          ).toBe(true);
        }),
    ),
  );
  it.effect("startup reconciles a crashed archive by manifest incarnation", () =>
    scenario(
      (roots) =>
        Effect.gen(function* () {
          const root = roots.path.join(roots.agentWorkDir, SPACE_ID);
          const archived = roots.path.join(roots.agentWorkDir, ".archive", SPACE_ID);
          yield* roots.fs.makeDirectory(archived, { recursive: true }).pipe(Effect.orDie);
          const fixture = lifecycleFixture(root, "archiving");
          return {
            root,
            archived,
            fixture,
            lifecycle: fixture.service,
            activeProject: project("p", root),
            readerLoad: (candidate: string) =>
              Effect.succeed(
                candidate === archived ? Option.some(infoFor("archived")) : Option.none(),
              ),
            cliExtra: {
              spaceList: (input?: { archived?: boolean | undefined }) =>
                Effect.succeed(input?.archived ? [listRow(archived)] : []),
            },
          };
        }),
      (harness, options) =>
        Effect.gen(function* () {
          const ops = yield* StaveOperations;
          yield* ops.reconcileIncomplete;
          expect(options.fixture.row().disposition).toBe("archived");
          expect(options.fixture.row().workspaceRoot).toBe(options.archived);
          expect(
            (yield* Ref.get(harness.dispatched)).some(
              (command) =>
                command.type === "project.meta.update" &&
                command.workspaceRoot === options.archived,
            ),
          ).toBe(true);
        }),
    ),
  );
  it.effect("startup preserves a surviving row from another selected configuration", () =>
    scenario(
      (roots) =>
        Effect.gen(function* () {
          const root = roots.path.join(roots.agentWorkDir, "installation-a", SPACE_ID);
          yield* roots.fs.makeDirectory(root, { recursive: true }).pipe(Effect.orDie);
          const fixture = lifecycleFixture(root, "destroying");
          const inventoryCalls: string[] = [];
          return {
            root,
            fixture,
            inventoryCalls,
            lifecycle: fixture.service,
            activeProject: project("p", root),
            readerLoad: () => Effect.succeed(Option.some(infoFor())),
            cliExtra: {
              spaceList: () =>
                Effect.sync(() => {
                  inventoryCalls.push("list");
                  return [];
                }),
            },
          };
        }),
      (harness, options) =>
        Effect.gen(function* () {
          yield* (yield* StaveOperations).reconcileIncomplete;
          expect(options.fixture.row().disposition).toBe("destroying");
          expect(options.fixture.row().refusalMessage).toContain("another Stave configuration");
          expect(options.fixture.row().workspaceRoot).toBe(options.root);
          expect(yield* harness.fs.exists(options.root)).toBe(true);
          expect(options.inventoryCalls).toEqual([]);
          expect(yield* Ref.get(harness.dispatched)).toEqual([]);
        }),
    ),
  );
  it.effect(
    "startup completes already destroyed metadata without an available execution configuration",
    () =>
      scenario(
        (roots) =>
          Effect.sync(() => {
            const root = roots.path.join(roots.agentWorkDir, SPACE_ID);
            const fixture = lifecycleFixture(root, "destroyed");
            const captures: string[] = [];
            const executionLayer = Layer.succeed(
              StaveExecution.StaveExecution,
              StaveExecution.StaveExecution.of({
                withExecution: () =>
                  Effect.sync(() => {
                    captures.push("capture");
                  }).pipe(
                    Effect.andThen(
                      new StaveError({
                        code: "binary_missing",
                        message: "binary unavailable",
                        details: null,
                        exitCode: null,
                        stderrTail: null,
                        verb: "execution",
                      }),
                    ),
                  ),
              }),
            );
            return {
              root,
              fixture,
              captures,
              executionLayer,
              lifecycle: fixture.service,
              activeProject: project("p", root),
              configExists: false,
            };
          }),
        (harness, options) =>
          Effect.gen(function* () {
            yield* (yield* StaveOperations).reconcileIncomplete;
            expect(options.captures).toEqual([]);
            expect(options.fixture.row().disposition).toBe("destroyed");
            expect(
              (yield* Ref.get(harness.dispatched)).filter(
                (command) => command.type === "project.delete",
              ),
            ).toHaveLength(1);
            expect(yield* Ref.get(harness.cliCalls)).toEqual([]);
          }),
      ),
  );
  it.effect("startup refuses unreadable list rows without deleting the project", () =>
    scenario(
      (roots) =>
        Effect.sync(() => {
          const root = roots.path.join(roots.agentWorkDir, SPACE_ID);
          const fixture = lifecycleFixture(root, "destroying");
          return {
            root,
            fixture,
            lifecycle: fixture.service,
            activeProject: project("p", root),
            cliExtra: {
              spaceList: () => Effect.succeed([{ ...listRow(root), error: "corrupt manifest" }]),
            },
          };
        }),
      (harness, options) =>
        Effect.gen(function* () {
          const ops = yield* StaveOperations;
          yield* ops.reconcileIncomplete;
          expect(options.fixture.row().disposition).toBe("destroying");
          expect(options.fixture.row().refusalCode).toBe("unreadable");
          expect(
            (yield* Ref.get(harness.dispatched)).some(
              (command) => command.type === "project.delete",
            ),
          ).toBe(false);
        }),
    ),
  );
});

it.effect("renews the lifecycle lease while Stave is running", () =>
  scenario(
    (roots) =>
      Effect.gen(function* () {
        const root = roots.path.join(roots.agentWorkDir, SPACE_ID);
        yield* roots.fs.makeDirectory(root).pipe(Effect.orDie);
        const fixture = lifecycleFixture(root);
        const started = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const renewed = yield* Deferred.make<void>();
        return {
          root,
          fixture,
          started,
          finish,
          renewed,
          activeProject: project("p", root),
          readerLoad: () => Effect.succeed(Option.some(infoFor())),
          lifecycle: {
            ...fixture.service,
            renewLease: () => Deferred.succeed(renewed, undefined).pipe(Effect.as(true)),
          },
          cliExtra: {
            sagaList: Effect.succeed([]),
            spaceDestroy: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(finish)),
                Effect.as(destroyResult(SPACE_ID, root)),
              ),
          },
        };
      }),
    (_harness, options) =>
      Effect.gen(function* () {
        const ops = yield* StaveOperations;
        const running = yield* runToEnd(ops, "lease-renewal", {
          kind: "destroySpace",
          workspaceRoot: options.root,
          expectedManifestCreatedAt: CREATED_AT,
          force: false,
          memory: "keep",
        }).pipe(Effect.forkChild);
        yield* Deferred.await(options.started);
        yield* TestClock.adjust("20 seconds");
        yield* Deferred.await(options.renewed);
        yield* Deferred.succeed(options.finish, undefined);
        expect(finishedResult(yield* Fiber.join(running)).kind).toBe("destroySpace");
      }),
  ),
);

it.effect("fails closed when a saga roster is unreadable", () =>
  scenario(
    (roots) =>
      Effect.gen(function* () {
        const root = roots.path.join(roots.agentWorkDir, SPACE_ID);
        yield* roots.fs.makeDirectory(root).pipe(Effect.orDie);
        const fixture = lifecycleFixture(root);
        return {
          root,
          fixture,
          activeProject: project("p", root),
          readerLoad: () => Effect.succeed(Option.some(infoFor())),
          lifecycle: fixture.service,
          cliExtra: {
            sagaList: Effect.succeed([
              {
                id: "saga",
                path: roots.path.join(roots.agentWorkDir, "saga"),
                logicalId: "saga",
                isSaga: true,
                members: [],
                error: "bad manifest",
              },
            ]),
            spaceList: (input) => Effect.succeed(input?.archived ? [] : [listRow(root)]),
          },
        };
      }),
    (harness, options) =>
      Effect.gen(function* () {
        const ops = yield* StaveOperations;
        const events = yield* runToEnd(ops, "unknown-membership", {
          kind: "destroySpace",
          workspaceRoot: options.root,
          expectedManifestCreatedAt: CREATED_AT,
          sagaRemoveConfirmed: true,
          force: true,
          memory: "destroy",
        });
        expect(failedError(events).code).toBe("membership_unknown");
        expect(
          (yield* Ref.get(harness.cliCalls)).some((call) => call.method === "spaceDestroy"),
        ).toBe(false);
        expect(options.fixture.row().disposition).toBe("refused");
      }),
  ),
);

it.effect(
  "retargets a successful archive before an unrelated unreadable listing refuses reconciliation",
  () =>
    scenario(
      (roots) =>
        Effect.gen(function* () {
          const root = roots.path.join(roots.agentWorkDir, SPACE_ID);
          const archived = roots.path.join(roots.agentWorkDir, ".archive", SPACE_ID);
          yield* roots.fs.makeDirectory(root).pipe(Effect.orDie);
          yield* roots.fs.makeDirectory(archived, { recursive: true }).pipe(Effect.orDie);
          const fixture = lifecycleFixture(root);
          return {
            root,
            archived,
            fixture,
            activeProject: project("p", root),
            readerLoad: (candidate: string) =>
              Effect.succeed(Option.some(infoFor(candidate === archived ? "archived" : "live"))),
            lifecycle: fixture.service,
            cliExtra: {
              spaceArchive: () =>
                Effect.succeed({
                  spaceId: SPACE_ID,
                  archivedPath: archived,
                  memory: "keep" as const,
                  notes: [],
                }),
              spaceList: () =>
                Effect.succeed([{ ...listRow(root), error: "unrelated unreadable manifest" }]),
            },
          };
        }),
      (harness, options) =>
        Effect.gen(function* () {
          const ops = yield* StaveOperations;
          const events = yield* runToEnd(ops, "archive-retarget", {
            kind: "archiveSpace",
            workspaceRoot: options.root,
            expectedManifestCreatedAt: CREATED_AT,
            force: false,
            memory: "keep",
          });
          expect(failedError(events).code).toBe("unreadable");
          expect(options.fixture.row().workspaceRoot).toBe(options.archived);
          expect(
            (yield* Ref.get(harness.dispatched)).some(
              (command) =>
                command.type === "project.meta.update" &&
                command.workspaceRoot === options.archived,
            ),
          ).toBe(true);
          expect(
            (yield* Ref.get(harness.dispatched)).some(
              (command) => command.type === "project.delete",
            ),
          ).toBe(false);
        }),
    ),
);

it.effect(
  "preserves removed saga membership and edges across restarted failed cleanup retries",
  () =>
    scenario(
      (roots) =>
        Effect.gen(function* () {
          const root = roots.path.join(roots.agentWorkDir, SPACE_ID);
          const sagaRoot = roots.path.join(roots.agentWorkDir, "story");
          yield* roots.fs.makeDirectory(root);
          const fixture = lifecycleFixture(root);
          const enrolled = yield* Ref.make(true);
          const removals = yield* Ref.make(0);
          const attempts = yield* Ref.make(0);
          const sagaManifest = {
            ...manifest("story"),
            saga: {
              members: [
                { id: SPACE_ID, createdAt: CREATED_AT, after: ["predecessor"], prs: [] },
                { id: "dependent", createdAt: CREATED_AT, after: [SPACE_ID], prs: [] },
              ],
            },
          };
          return {
            root,
            sagaRoot,
            fixture,
            removals,
            attempts,
            lifecycle: fixture.service,
            activeProject: project("p", root),
            readerLoad: () => Effect.succeed(Option.some(infoFor())),
            cliExtra: {
              sagaList: Ref.get(enrolled).pipe(
                Effect.map((member) =>
                  member
                    ? [
                        {
                          id: "story",
                          logicalId: "story",
                          path: sagaRoot,
                          isSaga: true,
                          members: [SPACE_ID],
                        },
                      ]
                    : [],
                ),
              ),
              spaceStatus: () =>
                Effect.succeed({ ...statusResult("story", sagaRoot), manifest: sagaManifest }),
              spaceList: (input) => Effect.succeed(input?.archived ? [] : [listRow(root)]),
              sagaRemove: () =>
                Ref.set(enrolled, false).pipe(
                  Effect.andThen(Ref.update(removals, (count) => count + 1)),
                  Effect.as({
                    sagaId: "story",
                    spacePath: sagaRoot,
                    manifest: sagaManifest,
                    notes: [],
                  }),
                ),
              spaceDestroy: () =>
                Ref.updateAndGet(attempts, (count) => count + 1).pipe(
                  Effect.flatMap(
                    (count) =>
                      new StaveError({
                        code: "dirty_worktrees",
                        message: `dirty attempt ${count}`,
                        details: null,
                        verb: "space destroy",
                        exitCode: 1,
                        stderrTail: null,
                      }),
                  ),
                ),
            } satisfies Partial<StaveCliShape>,
          };
        }).pipe(Effect.orDie),
      (harness, options) =>
        Effect.gen(function* () {
          const operation: StaveOperation = {
            kind: "destroySpace",
            workspaceRoot: options.root,
            expectedManifestCreatedAt: CREATED_AT,
            sagaRemoveConfirmed: true,
            force: false,
            memory: "keep",
          };
          expect(
            failedError(yield* runToEnd(yield* StaveOperations, "first-removal", operation))
              .message,
          ).toBe("dirty attempt 1");
          const decodeFailure = Schema.decodeUnknownEffect(
            Schema.fromJsonString(
              Schema.Struct({
                message: Schema.String,
                removedEdges: Schema.Array(Schema.Unknown),
              }),
            ),
          );
          const first = yield* decodeFailure(options.fixture.row().refusalMessage!);
          expect(first.removedEdges).toEqual([
            {
              sagaId: "story",
              sagaRoot: options.sagaRoot,
              removedEdges: [
                { memberId: SPACE_ID, after: ["predecessor"] },
                { memberId: "dependent", after: [SPACE_ID] },
              ],
            },
          ]);
          const restarted = yield* makeHarness(harness, options);
          const retry = yield* Effect.gen(function* () {
            return yield* runToEnd(yield* StaveOperations, "retry-removal", operation);
          }).pipe(Effect.provide(restarted.layer));
          expect(failedError(retry).message).toBe("dirty attempt 2");
          expect(failedError(retry).details?.removedEdges).toEqual(first.removedEdges);
          const latest = yield* decodeFailure(options.fixture.row().refusalMessage!);
          expect(latest.message).toBe("dirty attempt 2");
          expect(latest.removedEdges).toEqual(first.removedEdges);
          expect(yield* Ref.get(options.removals)).toBe(1);
          expect(yield* Ref.get(options.attempts)).toBe(2);
          expect(options.fixture.row().disposition).toBe("refused");
        }),
    ),
);

it.effect("previews confirmed saga removal and guarded destroy without mutating or forcing", () =>
  scenario(
    (roots) =>
      Effect.gen(function* () {
        const root = roots.path.join(roots.agentWorkDir, SPACE_ID);
        yield* roots.fs.makeDirectory(root).pipe(Effect.orDie);
        const previewed: Array<boolean | undefined> = [];
        return {
          root,
          previewed,
          readerLoad: () => Effect.succeed(Option.some(infoFor())),
          cliExtra: {
            sagaList: Effect.succeed([
              {
                id: "saga",
                path: roots.path.join(roots.agentWorkDir, "saga"),
                logicalId: "saga",
                isSaga: true,
                members: [SPACE_ID],
              },
            ]),
            spaceStatus: () =>
              Effect.succeed({
                ...statusResult("saga", roots.path.join(roots.agentWorkDir, "saga")),
                manifest: {
                  ...manifest("saga"),
                  saga: { members: [{ id: SPACE_ID, createdAt: CREATED_AT, after: [], prs: [] }] },
                },
              }),
            sagaRemove: (input: { dryRun?: boolean | undefined }) =>
              Effect.sync(() => {
                previewed.push(input.dryRun);
                return { dryRun: true as const, plan: ["Remove demo from saga"] };
              }),
          },
        };
      }),
    (harness, options) =>
      Effect.gen(function* () {
        const ops = yield* StaveOperations;
        const result = yield* ops.dryRun({
          kind: "destroySpace",
          workspaceRoot: options.root,
          expectedManifestCreatedAt: CREATED_AT,
          sagaRemoveConfirmed: true,
          force: false,
          memory: "keep",
        });
        expect(options.previewed).toEqual([true]);
        expect(result.plan.join(" ")).toContain("guarded destruction");
        expect(result.plan.join(" ")).toContain("manual repair");
        expect(
          (yield* Ref.get(harness.cliCalls)).some((call) => call.method === "spaceDestroy"),
        ).toBe(false);
        expect(yield* Ref.get(harness.dispatched)).toEqual([]);
      }),
  ),
);

it.effect("uses durable lifecycle cleanup when a partial already has a project", () =>
  scenario(
    (roots) =>
      Effect.gen(function* () {
        const root = roots.path.join(roots.agentWorkDir, SPACE_ID);
        yield* roots.fs.makeDirectory(root).pipe(Effect.orDie);
        const fixture = lifecycleFixture(root);
        return {
          root,
          fixture,
          activeProject: project("p", root),
          readerLoad: () => Effect.succeed(Option.some(infoFor())),
          lifecycle: fixture.service,
        };
      }),
    (harness, options) =>
      Effect.gen(function* () {
        const ops = yield* StaveOperations;
        expect(
          finishedResult(
            yield* runToEnd(ops, "registered-partial", {
              kind: "removePartialSpace",
              spaceId: SPACE_ID,
              expectedManifestCreatedAt: CREATED_AT,
            }),
          ).kind,
        ).toBe("removePartialSpace");
        expect(options.fixture.row().disposition).toBe("destroyed");
        expect(
          (yield* Ref.get(harness.dispatched)).some((command) => command.type === "project.delete"),
        ).toBe(true);
        expect(
          (yield* Ref.get(harness.cliCalls)).find((call) => call.method === "spaceDestroy")?.input,
        ).toMatchObject({ force: false });
      }),
  ),
);

it.effect(
  "refuses a restore destination changed between the pre-lock and under-lock manifest reads",
  () =>
    scenario(
      (roots) =>
        Effect.gen(function* () {
          const archived = roots.path.join(roots.agentWorkDir, ".archive", SPACE_ID);
          yield* roots.fs.makeDirectory(archived, { recursive: true }).pipe(Effect.orDie);
          const fixture = lifecycleFixture(archived, "archived");
          const reads = yield* Ref.make(0);
          const restoreCalls = yield* Ref.make(0);
          const quiesced: Array<string> = [];
          return {
            archived,
            fixture,
            reads,
            restoreCalls,
            quiesced,
            activeProject: project("p", archived),
            readerLoad: () =>
              Ref.updateAndGet(reads, (count) => count + 1).pipe(
                Effect.map((count) =>
                  Option.some({
                    ...infoFor("archived"),
                    spaceId: count === 1 ? SPACE_ID : "changed-destination",
                  }),
                ),
              ),
            lifecycle: fixture.service,
            cliExtra: {
              spaceRestore: () =>
                Ref.update(restoreCalls, (count) => count + 1).pipe(
                  Effect.as(mutationResult(SPACE_ID, archived)),
                ),
            },
          };
        }),
      (harness, options) =>
        Effect.gen(function* () {
          const ops = yield* StaveOperations;
          const events = yield* runToEnd(ops, "changed-restore-destination", {
            kind: "restoreSpace",
            workspaceRoot: options.archived,
            from: SPACE_ID,
            expectedManifestCreatedAt: CREATED_AT,
          });
          expect(failedError(events).code).toBe("incarnation_mismatch");
          expect(failedError(events).message).toContain("restore destination changed");
          expect(yield* Ref.get(options.reads)).toBe(2);
          expect(yield* Ref.get(options.restoreCalls)).toBe(0);
          expect(options.fixture.row().disposition).toBe("archived");
          expect(options.fixture.row().ownerToken).toBeNull();
          expect(options.quiesced).toEqual([]);
          expect(yield* Ref.get(harness.dispatched)).toEqual([]);
        }),
    ),
);

it.effect("reconciles a restore that renamed the archive before failing", () =>
  scenario(
    (roots) =>
      Effect.gen(function* () {
        const live = roots.path.join(roots.agentWorkDir, SPACE_ID);
        const archived = roots.path.join(roots.agentWorkDir, ".archive", SPACE_ID);
        yield* roots.fs.makeDirectory(archived, { recursive: true }).pipe(Effect.orDie);
        const fixture = lifecycleFixture(archived, "archived");
        return {
          live,
          archived,
          fixture,
          activeProject: project("p", archived),
          readerLoad: (candidate: string) =>
            Effect.succeed(Option.some(infoFor(candidate === archived ? "archived" : "live"))),
          lifecycle: fixture.service,
          cliExtra: {
            spaceRestore: (input: { from?: string | undefined }) =>
              Effect.gen(function* () {
                expect(input.from).toBe(SPACE_ID);
                yield* roots.fs.rename(archived, live).pipe(Effect.orDie);
                return yield* new StaveError({
                  code: "unknown",
                  message: "worktree reconstruction failed",
                  details: null,
                  verb: "space restore",
                  exitCode: 1,
                  stderrTail: null,
                });
              }),
            spaceList: (input?: { archived?: boolean | undefined }) =>
              Effect.succeed(input?.archived ? [] : [listRow(live)]),
          },
        };
      }),
    (harness, options) =>
      Effect.gen(function* () {
        const ops = yield* StaveOperations;
        const events = yield* runToEnd(ops, "partial-restore", {
          kind: "restoreSpace",
          workspaceRoot: options.archived,
          from: SPACE_ID,
          expectedManifestCreatedAt: CREATED_AT,
        });
        expect(failedError(events).message).toBe("worktree reconstruction failed");
        expect(options.fixture.row().workspaceRoot).toBe(options.live);
        expect(options.fixture.row().disposition).toBe("refused");
        expect(
          (yield* Ref.get(harness.dispatched)).some(
            (command) =>
              command.type === "project.meta.update" && command.workspaceRoot === options.live,
          ),
        ).toBe(true);
        expect(
          (yield* Ref.get(harness.dispatched)).some((command) => command.type === "project.delete"),
        ).toBe(false);
      }),
  ),
);

for (const retained of [true, false]) {
  it.effect(
    `startup reconciliation ${retained ? "renews its lease while CLI reads run" : "stops without project mutation after lease loss"}`,
    () =>
      scenario(
        (roots) =>
          Effect.gen(function* () {
            const root = roots.path.join(roots.agentWorkDir, SPACE_ID);
            yield* roots.fs.makeDirectory(root).pipe(Effect.orDie);
            const fixture = lifecycleFixture(root, "archiving");
            const started = yield* Deferred.make<void>();
            const finish = yield* Deferred.make<void>();
            const renewed = yield* Deferred.make<void>();
            return {
              root,
              fixture,
              started,
              finish,
              renewed,
              activeProject: project("p", root),
              readerLoad: () => Effect.succeed(Option.some(infoFor())),
              lifecycle: {
                ...fixture.service,
                renewLease: () => Deferred.succeed(renewed, undefined).pipe(Effect.as(retained)),
              },
              cliExtra: {
                spaceList: (input?: { archived?: boolean | undefined }) =>
                  input?.archived
                    ? Effect.succeed([])
                    : Deferred.succeed(started, undefined).pipe(
                        Effect.andThen(Deferred.await(finish)),
                        Effect.as([listRow(root)]),
                      ),
              },
            };
          }),
        (harness, options) =>
          Effect.gen(function* () {
            const ops = yield* StaveOperations;
            const fiber = yield* ops.reconcileIncomplete.pipe(Effect.forkChild);
            yield* Deferred.await(options.started);
            yield* TestClock.adjust("20 seconds");
            yield* Deferred.await(options.renewed);
            if (retained) {
              yield* Deferred.succeed(options.finish, undefined);
              yield* Fiber.join(fiber);
              expect(options.fixture.row().disposition).toBe("live");
            } else {
              yield* Fiber.join(fiber);
              expect(options.fixture.row().disposition).toBe("archiving");
              expect(yield* Ref.get(harness.dispatched)).toEqual([]);
            }
          }),
      ),
  );
}

const sagaFixture = (roots: Roots) =>
  Effect.gen(function* () {
    const ids = ["story", "a", "b"];
    const rootsById = new Map(ids.map((id) => [id, roots.path.join(roots.agentWorkDir, id)]));
    for (const root of rootsById.values()) yield* roots.fs.makeDirectory(root).pipe(Effect.orDie);
    const infos = new Map<string, StaveProjectInfo>(
      ids.map((id) => [
        rootsById.get(id)!,
        {
          ...infoFor(),
          spaceId: id,
          isSaga: id === "story",
          ...(id === "story" ? { kind: "saga" } : {}),
        },
      ]),
    );
    let members = [
      { id: "a", createdAt: CREATED_AT, after: [] as string[] },
      { id: "b", createdAt: CREATED_AT, after: ["a"] },
    ];
    const rows = new Map<ProjectId, StaveLifecycleRow>();
    const history: string[] = [];
    const shellProjects = ids.map((id) => projectShell(id, rootsById.get(id)!));
    const service: Partial<StaveLifecycleRepositoryShape> = {
      ensure: (input) =>
        Effect.sync(() => {
          const prior = rows.get(input.projectId);
          if (prior) return prior;
          const row = {
            ...lifecycleFixture(input.workspaceRoot).row(),
            ...input,
            updatedAt: input.now,
          };
          rows.set(row.projectId, row);
          history.push(`ensure:${row.projectId}`);
          return row;
        }),
      acquireLease: (input) =>
        Effect.sync(() => {
          const row = rows.get(input.projectId)!;
          const leased = {
            ...row,
            leaseEpoch: row.leaseEpoch + 1,
            ownerToken: input.ownerToken,
            leaseUntil: input.leaseUntil,
          };
          rows.set(row.projectId, leased);
          history.push(`lease:${row.projectId}`);
          return Option.some(leased);
        }),
      updateDisposition: (input) =>
        Effect.sync(() => {
          const row = rows.get(input.projectId)!;
          if (row.ownerToken !== input.ownerToken || row.leaseEpoch !== input.leaseEpoch)
            return false;
          rows.set(row.projectId, { ...row, ...input.patch });
          if (input.patch.disposition) history.push(`${input.patch.disposition}:${row.projectId}`);
          return true;
        }),
      renewLease: (input) =>
        Effect.sync(() => {
          const row = rows.get(input.projectId)!;
          if (row.ownerToken !== input.ownerToken || row.leaseEpoch !== input.leaseEpoch)
            return false;
          rows.set(row.projectId, { ...row, leaseUntil: input.leaseUntil });
          history.push(`renew:${row.projectId}`);
          return true;
        }),
      releaseLease: (input) =>
        Effect.sync(() => {
          const row = rows.get(input.projectId)!;
          if (row.ownerToken !== input.ownerToken || row.leaseEpoch !== input.leaseEpoch)
            return false;
          rows.set(row.projectId, { ...row, ownerToken: null, leaseUntil: null });
          history.push(`release:${row.projectId}`);
          return true;
        }),
      listIncomplete: () =>
        Effect.sync(() =>
          [...rows.values()].filter((row) => ["archiving", "destroying"].includes(row.disposition)),
        ),
    };
    const sagaManifest = () => ({
      ...manifest("story"),
      kind: "saga",
      saga: { members: members.map((member) => ({ ...member, prs: [] })) },
    });
    const cliExtra: Partial<StaveCliShape> = {
      spaceStatus: (id) =>
        Effect.sync(() => ({
          ...statusResult(id, rootsById.get(id)!),
          manifest: id === "story" ? sagaManifest() : manifest(id),
        })),
      spaceList: (input) =>
        Effect.sync(() =>
          [...infos]
            .filter(([, info]) => (info.state === "archived") === (input?.archived === true))
            .map(([root, info]) => ({
              ...listRow(root),
              id: info.spaceId,
              logicalId: info.spaceId,
              isSaga: info.isSaga,
              archived: info.state === "archived",
            })),
        ),
      sagaAdd: (input) =>
        Effect.sync(() => {
          if (input.dryRun) return PLAN;
          const old = members.find((member) => member.id === input.spaceId);
          members = [
            ...members.filter((member) => member.id !== input.spaceId),
            {
              id: input.spaceId,
              createdAt: CREATED_AT,
              after: [
                ...new Set([...(input.clearAfter ? [] : (old?.after ?? [])), ...input.after]),
              ],
            },
          ];
          history.push(`add:${input.spaceId}`);
          return {
            sagaId: "story",
            spacePath: rootsById.get("story")!,
            manifest: sagaManifest(),
            notes: [],
          };
        }),
      sagaRemove: (input) =>
        Effect.sync(() => {
          if (input.dryRun) return PLAN;
          members = members
            .filter((member) => member.id !== input.spaceId)
            .map((member) => ({
              ...member,
              after: member.after.filter((id) => id !== input.spaceId),
            }));
          return {
            sagaId: "story",
            spacePath: rootsById.get("story")!,
            manifest: sagaManifest(),
            notes: [],
          };
        }),
      sagaArchive: (input) =>
        Effect.sync(() => {
          if (input.dryRun)
            return { dryRun: true as const, plan: ["archive b", "archive a", "archive story"] };
          history.push("cli");
          for (const id of ids) expect(rows.get(ProjectId.make(id))?.disposition).toBe("archiving");
          return {
            sagaId: "story",
            sagaPath: rootsById.get("story")!,
            action: "archived" as const,
            memory: "keep" as const,
            members: [],
            notes: [],
          };
        }),
    };
    return {
      rootsById,
      infos,
      rows,
      history,
      shellProjects,
      lifecycle: service,
      cliExtra,
      readerLoad: (root: string) => Effect.sync(() => Option.fromNullishOr(infos.get(root))),
      members: () => members,
      setMembers: (value: typeof members) => {
        members = value;
      },
    };
  });

describe("StaveOperations sagas", () => {
  it.effect(
    "creates a saga with a scoped spec and inserts exactly one project before returning its sequence",
    () =>
      scenario(
        (roots) =>
          Effect.sync(() => {
            const seen: string[] = [];
            return {
              seen,
              cliExtra: {
                sagaCreate: (input) =>
                  Effect.gen(function* () {
                    expect(yield* roots.fs.readFileString(input.spec!).pipe(Effect.orDie)).toBe(
                      "# Saga spec",
                    );
                    seen.push(input.spec!);
                    expect(input.references).toEqual(["api:main"]);
                    const root = roots.path.join(roots.agentWorkDir, input.id);
                    yield* roots.fs.makeDirectory(root).pipe(Effect.orDie);
                    return {
                      sagaId: input.id,
                      spacePath: root,
                      manifest: { ...manifest(input.id), kind: "saga", saga: { members: [] } },
                      notes: [],
                    };
                  }),
                spaceStatus: (id) =>
                  Effect.succeed({
                    ...statusResult(id, roots.path.join(roots.agentWorkDir, id)),
                    manifest: { ...manifest(id), kind: "saga", saga: { members: [] } },
                  }),
              } satisfies Partial<StaveCliShape>,
            };
          }),
        (harness, options) =>
          Effect.gen(function* () {
            const ops = yield* StaveOperations;
            const operation: StaveOperation = {
              kind: "createSaga",
              sagaId: "story",
              references: [{ repo: "api", ref: "main" }],
              memory: [],
              specText: "# Saga spec",
            };
            const result = finishedResult(yield* runToEnd(ops, "create-saga", operation));
            expect(result.kind).toBe("createSaga");
            if (result.kind === "createSaga") expect(result.result.sequence).toBe(ENGINE_SEQUENCE);
            yield* runToEnd(ops, "create-saga", operation);
            expect(
              (yield* Ref.get(harness.dispatched)).filter(
                (command) => command.type === "project.create",
              ),
            ).toHaveLength(1);
            expect(yield* harness.fs.exists(options.seen[0]!)).toBe(false);
          }),
      ),
  );
  it.effect(
    "upserts after edges and explicitly clears them; removal drops dependent edges and refreshes both projects",
    () =>
      scenario(sagaFixture, (harness, fixture) =>
        Effect.gen(function* () {
          const ops = yield* StaveOperations;
          const scope = {
            sagaRoot: fixture.rootsById.get("story")!,
            memberRoot: fixture.rootsById.get("b")!,
            expectedManifestCreatedAt: CREATED_AT,
            expectedMemberCreatedAt: CREATED_AT,
          };
          expect(
            finishedResult(
              yield* runToEnd(ops, "add", {
                kind: "sagaAdd",
                ...scope,
                after: [],
                clearAfter: true,
              }),
            ).kind,
          ).toBe("sagaAdd");
          expect(fixture.members().find((row) => row.id === "b")?.after).toEqual([]);
          expect(
            finishedResult(
              yield* runToEnd(ops, "upsert", {
                kind: "sagaAdd",
                ...scope,
                after: ["a"],
                clearAfter: false,
              }),
            ).kind,
          ).toBe("sagaAdd");
          expect(fixture.members().find((row) => row.id === "b")?.after).toEqual(["a"]);
          expect(
            finishedResult(
              yield* runToEnd(ops, "remove", {
                kind: "sagaRemove",
                ...scope,
                memberRoot: fixture.rootsById.get("a")!,
              }),
            ).kind,
          ).toBe("sagaRemove");
          expect(fixture.members()).toEqual([{ id: "b", after: [], createdAt: CREATED_AT }]);
          expect(
            (yield* Ref.get(harness.dispatched)).filter(
              (command) => command.type === "project.refresh",
            ),
          ).toHaveLength(6);
        }),
      ),
  );
  it.effect("refuses a delayed member edit when the current manifest was replaced", () =>
    scenario(sagaFixture, (_, fixture) =>
      Effect.gen(function* () {
        const root = fixture.rootsById.get("a")!;
        fixture.infos.set(root, { ...fixture.infos.get(root)!, createdAt: "2026-09-02T00:00:00Z" });
        const ops = yield* StaveOperations;
        const result = yield* runToEnd(ops, "stale-member", {
          kind: "sagaRemove",
          sagaRoot: fixture.rootsById.get("story")!,
          memberRoot: root,
          expectedManifestCreatedAt: CREATED_AT,
          expectedMemberCreatedAt: CREATED_AT,
        });
        expect(failedError(result).code).toBe("incarnation_mismatch");
        expect(fixture.history).toEqual([]);
      }),
    ),
  );
  it.effect(
    "returns the CLI reverse-topological dry-run without rows, quiescence, or mutation",
    () =>
      scenario(sagaFixture, (_, fixture) =>
        Effect.gen(function* () {
          const ops = yield* StaveOperations;
          const plan = yield* ops.dryRun({
            kind: "sagaArchive",
            sagaRoot: fixture.rootsById.get("story")!,
            expectedManifestCreatedAt: CREATED_AT,
            force: false,
            memory: "keep",
          });
          expect(plan.plan).toEqual(["archive b", "archive a", "archive story"]);
          expect(fixture.history).toEqual([]);
          expect(fixture.rows.size).toBe(0);
        }),
      ),
  );
  it.effect(
    "fences every member before quiescence and independently reconciles partial archive failure",
    () =>
      scenario(
        (roots) =>
          Effect.gen(function* () {
            const fixture = yield* sagaFixture(roots);
            const quiesced: string[] = [];
            return {
              ...fixture,
              quiesced,
              cliExtra: {
                ...fixture.cliExtra,
                sagaArchive: (input) =>
                  Effect.gen(function* () {
                    if (input.dryRun) return PLAN;
                    expect(input.force).toBe(false);
                    expect(fixture.history.slice(0, 6)).toEqual([
                      "ensure:a",
                      "lease:a",
                      "ensure:b",
                      "lease:b",
                      "ensure:story",
                      "lease:story",
                    ]);
                    expect(
                      [...fixture.rows.values()].every((row) => row.disposition === "archiving"),
                    ).toBe(true);
                    expect(quiesced).toHaveLength(6);
                    const root = fixture.rootsById.get("b")!;
                    const archive = roots.path.join(
                      roots.agentWorkDir,
                      ".archive",
                      "b-20260909000000",
                    );
                    yield* roots.fs.makeDirectory(roots.path.dirname(archive)).pipe(Effect.orDie);
                    yield* roots.fs.rename(root, archive).pipe(Effect.orDie);
                    fixture.infos.delete(root);
                    fixture.infos.set(archive, {
                      ...infoFor("archived"),
                      spaceId: "b",
                      archiveBasename: "b-20260909000000",
                    });
                    return yield* new StaveError({
                      code: "dirty_worktrees",
                      message: "member a is dirty",
                      details: { completed: ["b"] },
                      verb: "saga archive",
                      exitCode: 1,
                      stderrTail: null,
                    });
                  }),
              } satisfies Partial<StaveCliShape>,
            };
          }),
        (harness, fixture) =>
          Effect.gen(function* () {
            const ops = yield* StaveOperations;
            const error = failedError(
              yield* runToEnd(ops, "partial", {
                kind: "sagaArchive",
                sagaRoot: fixture.rootsById.get("story")!,
                expectedManifestCreatedAt: CREATED_AT,
                force: false,
                memory: "keep",
              }),
            );
            expect(error.code).toBe("dirty_worktrees");
            expect(error.details?.completed).toEqual(["b"]);
            expect(fixture.rows.get(ProjectId.make("b"))?.disposition).toBe("archived");
            expect(fixture.rows.get(ProjectId.make("a"))?.disposition).toBe("refused");
            expect(fixture.rows.get(ProjectId.make("story"))?.disposition).toBe("refused");
            expect([...fixture.rows.values()].every((row) => row.ownerToken === null)).toBe(true);
            expect(
              (yield* Ref.get(harness.dispatched)).some(
                (command) =>
                  command.type === "project.meta.update" &&
                  command.projectId === "b" &&
                  command.workspaceRoot?.endsWith("b-20260909000000"),
              ),
            ).toBe(true);
          }),
      ),
  );
  it.effect("refuses nested projects under a later participant before taking any lease", () =>
    scenario(
      (roots) =>
        Effect.gen(function* () {
          const fixture = yield* sagaFixture(roots);
          const nested = roots.path.join(fixture.rootsById.get("b")!, "repo");
          yield* roots.fs.makeDirectory(nested).pipe(Effect.orDie);
          return {
            ...fixture,
            shellProjects: [...fixture.shellProjects, projectShell("nested", nested)],
          };
        }),
      (_, fixture) =>
        Effect.gen(function* () {
          const ops = yield* StaveOperations;
          const events = yield* runToEnd(ops, "nested", {
            kind: "sagaArchive",
            sagaRoot: fixture.rootsById.get("story")!,
            expectedManifestCreatedAt: CREATED_AT,
            force: false,
            memory: "keep",
          });
          expect(failedError(events).code).toBe("nested_project");
          expect(fixture.history).toEqual([]);
        }),
    ),
  );
  it.effect("reconciles every sibling even when one manifest incarnation is ambiguous", () =>
    scenario(
      (roots) =>
        Effect.gen(function* () {
          const fixture = yield* sagaFixture(roots);
          return {
            ...fixture,
            cliExtra: {
              ...fixture.cliExtra,
              sagaArchive: (input) =>
                Effect.gen(function* () {
                  if (input.dryRun) return PLAN;
                  const original = fixture.rootsById.get("a")!;
                  const duplicate = roots.path.join(
                    roots.agentWorkDir,
                    ".archive",
                    "a-20260909000000",
                  );
                  fixture.infos.set(duplicate, {
                    ...fixture.infos.get(original)!,
                    state: "archived",
                    archiveBasename: "a-20260909000000",
                  });
                  const b = fixture.rootsById.get("b")!;
                  fixture.infos.delete(b);
                  yield* roots.fs.remove(b, { recursive: true }).pipe(Effect.orDie);
                  return yield* new StaveError({
                    code: "dirty_worktrees",
                    message: "partial failure",
                    details: null,
                    verb: "saga archive",
                    exitCode: 1,
                    stderrTail: null,
                  });
                }),
            } satisfies Partial<StaveCliShape>,
          };
        }),
      (harness, fixture) =>
        Effect.gen(function* () {
          const ops = yield* StaveOperations;
          const error = failedError(
            yield* runToEnd(ops, "ambiguous", {
              kind: "sagaArchive",
              sagaRoot: fixture.rootsById.get("story")!,
              expectedManifestCreatedAt: CREATED_AT,
              force: false,
              memory: "keep",
            }),
          );
          expect(error.details?.reconciliationFailures).toEqual([
            {
              projectId: "a",
              message:
                "More than one root has this space incarnation; repair the duplicate before retrying.",
            },
          ]);
          expect(fixture.rows.get(ProjectId.make("b"))?.disposition).toBe("destroyed");
          expect(fixture.rows.get(ProjectId.make("story"))?.disposition).toBe("refused");
          expect(
            (yield* Ref.get(harness.dispatched)).some(
              (command) => command.type === "project.delete" && command.projectId === "b",
            ),
          ).toBe(true);
        }),
    ),
  );
});

for (const lost of [null, "a", "b", "story"]) {
  it.effect(
    lost === null
      ? "renews every saga participant during a long teardown"
      : `interrupts teardown when participant ${lost} loses its lease`,
    () =>
      scenario(
        (roots) =>
          Effect.gen(function* () {
            const fixture = yield* sagaFixture(roots);
            const gates = yield* makeGates;
            const renewed = yield* Deferred.make<void>();
            return {
              ...fixture,
              gates,
              renewed,
              lifecycle: {
                ...fixture.lifecycle,
                renewLease: (input) =>
                  Effect.gen(function* () {
                    if (input.projectId === lost) {
                      fixture.rows.set(input.projectId, {
                        ...fixture.rows.get(input.projectId)!,
                        ownerToken: "replacement-owner",
                      });
                      yield* Deferred.succeed(renewed, undefined);
                      return false;
                    }
                    const ok = yield* fixture.lifecycle.renewLease!(input);
                    if (input.projectId === "story") yield* Deferred.succeed(renewed, undefined);
                    return ok;
                  }),
              },
              cliExtra: {
                ...fixture.cliExtra,
                sagaArchive: (input) =>
                  input.dryRun
                    ? Effect.succeed(PLAN)
                    : Deferred.succeed(gates.reached, undefined).pipe(
                        Effect.andThen(Deferred.await(gates.gate)),
                        Effect.andThen(fixture.cliExtra.sagaArchive!(input)),
                      ),
              },
            };
          }),
        (harness, fixture) =>
          Effect.gen(function* () {
            const ops = yield* StaveOperations;
            const running = yield* Effect.forkChild(
              runToEnd(ops, "long", {
                kind: "sagaArchive",
                sagaRoot: fixture.rootsById.get("story")!,
                expectedManifestCreatedAt: CREATED_AT,
                force: false,
                memory: "keep",
              }),
            );
            yield* Deferred.await(fixture.gates.reached);
            yield* TestClock.adjust("20 seconds");
            yield* Deferred.await(fixture.renewed);
            if (lost === null) {
              expect(fixture.history.filter((value) => value.startsWith("renew:"))).toEqual([
                "renew:a",
                "renew:b",
                "renew:story",
              ]);
              yield* Deferred.succeed(fixture.gates.gate, undefined);
              expect(finishedResult(yield* Fiber.join(running)).kind).toBe("sagaArchive");
            } else {
              expect(failedError(yield* Fiber.join(running)).code).toBe("space_transitioning");
              expect(fixture.history).not.toContain("cli");
              expect(
                (yield* Ref.get(harness.dispatched)).filter(
                  (command) =>
                    command.type === "project.delete" || command.type === "project.meta.update",
                ),
              ).toEqual([]);
              expect(fixture.rows.get(ProjectId.make(lost))?.ownerToken).toBe("replacement-owner");
            }
          }),
      ),
  );
}

it.effect(
  "refuses a symlink alias for a later saga member before leasing or invoking teardown",
  () =>
    scenario(
      (roots) =>
        Effect.gen(function* () {
          const fixture = yield* sagaFixture(roots);
          const b = fixture.rootsById.get("b")!;
          const target = roots.path.join(roots.agentWorkDir, "physical-b");
          yield* roots.fs.rename(b, target).pipe(Effect.orDie);
          yield* roots.fs.symlink(target, b).pipe(Effect.orDie);
          return fixture;
        }),
      (_, fixture) =>
        Effect.gen(function* () {
          const ops = yield* StaveOperations;
          const result = yield* runToEnd(ops, "alias", {
            kind: "sagaArchive",
            sagaRoot: fixture.rootsById.get("story")!,
            expectedManifestCreatedAt: CREATED_AT,
            force: false,
            memory: "keep",
          });
          expect(failedError(result).code).toBe("invalid_arguments");
          expect(fixture.history).toEqual([]);
        }),
    ),
);

it.effect("pre-journals and removes a missing roster member's existing project", () =>
  scenario(
    (roots) =>
      Effect.gen(function* () {
        const fixture = yield* sagaFixture(roots);
        const b = fixture.rootsById.get("b")!;
        fixture.infos.delete(b);
        yield* roots.fs.remove(b, { recursive: true }).pipe(Effect.orDie);
        return fixture;
      }),
    (harness, fixture) =>
      Effect.gen(function* () {
        const ops = yield* StaveOperations;
        expect(
          finishedResult(
            yield* runToEnd(ops, "missing", {
              kind: "sagaArchive",
              sagaRoot: fixture.rootsById.get("story")!,
              expectedManifestCreatedAt: CREATED_AT,
              force: false,
              memory: "keep",
            }),
          ).kind,
        ).toBe("sagaArchive");
        expect(fixture.rows.get(ProjectId.make("b"))?.disposition).toBe("destroyed");
        expect(
          (yield* Ref.get(harness.dispatched)).some(
            (command) => command.type === "project.delete" && command.projectId === "b",
          ),
        ).toBe(true);
      }),
  ),
);

it.effect(
  "startup independently reconciles pre-journaled sibling rows without a saga operation ledger",
  () =>
    scenario(
      (roots) =>
        Effect.gen(function* () {
          const fixture = yield* sagaFixture(roots);
          for (const [id, root] of fixture.rootsById) {
            const row = yield* fixture.lifecycle.ensure!({
              projectId: ProjectId.make(id),
              workspaceRoot: root,
              spaceId: id,
              manifestCreatedAt: CREATED_AT,
              now: NOW,
            }).pipe(Effect.orDie);
            fixture.rows.set(row.projectId, { ...row, disposition: "archiving" });
          }
          const b = fixture.rootsById.get("b")!;
          const archived = roots.path.join(roots.agentWorkDir, ".archive", "b-20260909000000");
          yield* roots.fs.makeDirectory(roots.path.dirname(archived)).pipe(Effect.orDie);
          yield* roots.fs.rename(b, archived).pipe(Effect.orDie);
          fixture.infos.delete(b);
          fixture.infos.set(archived, {
            ...infoFor("archived"),
            spaceId: "b",
            archiveBasename: "b-20260909000000",
          });
          return fixture;
        }),
      (harness, fixture) =>
        Effect.gen(function* () {
          const ops = yield* StaveOperations;
          yield* ops.reconcileIncomplete;
          expect(fixture.rows.get(ProjectId.make("a"))?.disposition).toBe("live");
          expect(fixture.rows.get(ProjectId.make("b"))?.disposition).toBe("archived");
          expect(fixture.rows.get(ProjectId.make("story"))?.disposition).toBe("live");
          expect(
            (yield* Ref.get(harness.dispatched)).some(
              (command) => command.type === "project.meta.update" && command.projectId === "b",
            ),
          ).toBe(true);
        }),
    ),
);

it.effect(
  "cleans an empty partial saga with guarded saga destroy and refuses undisclosed member teardown",
  () =>
    scenario(
      (roots) =>
        Effect.gen(function* () {
          const fixture = yield* sagaFixture(roots);
          fixture.setMembers([]);
          const calls: boolean[] = [];
          return {
            ...fixture,
            calls,
            shellProjects: [],
            cliExtra: {
              ...fixture.cliExtra,
              sagaDestroy: (input) =>
                Effect.sync(() => {
                  calls.push(input.force === true);
                  if (input.dryRun) return PLAN;
                  return {
                    sagaId: "story",
                    sagaPath: fixture.rootsById.get("story")!,
                    action: "destroyed" as const,
                    memory: "destroy" as const,
                    members: [],
                    notes: [],
                  };
                }),
            } satisfies Partial<StaveCliShape>,
          };
        }),
      (_, fixture) =>
        Effect.gen(function* () {
          const ops = yield* StaveOperations;
          const operation: StaveOperation = {
            kind: "removePartialSpace",
            spaceId: "story",
            expectedManifestCreatedAt: CREATED_AT,
            force: false,
          };
          expect(yield* ops.dryRun(operation)).toMatchObject(PLAN);
          expect(finishedResult(yield* runToEnd(ops, "partial-saga", operation)).kind).toBe(
            "removePartialSpace",
          );
          expect(fixture.calls).toEqual([false, false]);
          fixture.setMembers([{ id: "a", createdAt: CREATED_AT, after: [] }]);
          expect(
            failedError(yield* runToEnd(ops, "partial-saga-with-member", operation)).code,
          ).toBe("invalid_arguments");
          expect(fixture.calls).toEqual([false, false]);
        }),
    ),
);

it.effect(
  "removes an archived member using its exact archive incarnation and refreshes that project",
  () =>
    scenario(
      (roots) =>
        Effect.gen(function* () {
          const fixture = yield* sagaFixture(roots);
          const root = fixture.rootsById.get("b")!;
          const archived = roots.path.join(roots.agentWorkDir, ".archive", "b-20260909000000");
          yield* roots.fs.makeDirectory(roots.path.dirname(archived)).pipe(Effect.orDie);
          yield* roots.fs.rename(root, archived).pipe(Effect.orDie);
          fixture.infos.delete(root);
          fixture.infos.set(archived, {
            ...infoFor("archived"),
            spaceId: "b",
            archiveBasename: "b-20260909000000",
          });
          return {
            ...fixture,
            archived,
            shellProjects: fixture.shellProjects.map((project) =>
              project.id === "b" ? { ...project, workspaceRoot: archived } : project,
            ),
          };
        }),
      (harness, fixture) =>
        Effect.gen(function* () {
          const ops = yield* StaveOperations;
          const op: StaveOperation = {
            kind: "sagaRemove",
            sagaRoot: fixture.rootsById.get("story")!,
            memberRoot: fixture.archived,
            expectedManifestCreatedAt: CREATED_AT,
            expectedMemberCreatedAt: CREATED_AT,
          };
          expect(yield* ops.dryRun(op)).toEqual(PLAN);
          expect(finishedResult(yield* runToEnd(ops, "remove-archived", op)).kind).toBe(
            "sagaRemove",
          );
          expect(fixture.members().map((member) => member.id)).toEqual(["a"]);
          expect(
            (yield* Ref.get(harness.dispatched)).some(
              (command) => command.type === "project.refresh" && command.projectId === "b",
            ),
          ).toBe(true);
        }),
    ),
);

it.effect("refuses generic space teardown of a saga before leasing or invoking CLI", () =>
  scenario(sagaFixture, (_, fixture) =>
    Effect.gen(function* () {
      const ops = yield* StaveOperations;
      for (const kind of ["archiveSpace", "destroySpace"] as const) {
        const op: StaveOperation = {
          kind,
          workspaceRoot: fixture.rootsById.get("story")!,
          expectedManifestCreatedAt: CREATED_AT,
          force: false,
          memory: "keep",
        };
        expect((yield* Effect.flip(ops.dryRun(op))).code).toBe("saga_space");
        expect(failedError(yield* runToEnd(ops, kind, op)).code).toBe("saga_space");
      }
      expect(fixture.history).toEqual([]);
    }),
  ),
);

it.effect(
  "create-with-saga waits for the saga mutex and refreshes enrollment after a later verify failure",
  () =>
    scenario(
      (roots) =>
        Effect.gen(function* () {
          const fixture = yield* sagaFixture(roots);
          const held = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const reachedCreate = yield* Deferred.make<void>();
          return {
            ...fixture,
            held,
            release,
            reachedCreate,
            cliExtra: {
              ...fixture.cliExtra,
              spaceCreate: (input) =>
                Deferred.succeed(reachedCreate, undefined).pipe(
                  Effect.andThen(createSpaceOnDisk(roots)(input)),
                ),
              spaceStatus: (id) =>
                id === "new-member"
                  ? Effect.succeed(
                      statusResult(
                        id,
                        roots.path.join(roots.agentWorkDir, id),
                        "2026-09-02T00:00:00Z",
                      ),
                    )
                  : fixture.cliExtra.spaceStatus!(id),
            } satisfies Partial<StaveCliShape>,
          };
        }),
      (harness, fixture) =>
        Effect.gen(function* () {
          const ops = yield* StaveOperations;
          const lock = yield* Effect.forkChild(
            ops.withSpaceLock(
              fixture.rootsById.get("story")!,
              Deferred.succeed(fixture.held, undefined).pipe(
                Effect.andThen(Deferred.await(fixture.release)),
              ),
            ),
          );
          yield* Deferred.await(fixture.held);
          const create = yield* Effect.forkChild(
            runToEnd(ops, "enroll", createSpaceOperation({ spaceId: "new-member", saga: "story" })),
          );
          yield* Effect.yieldNow;
          expect(Option.isNone(yield* Deferred.poll(fixture.reachedCreate))).toBe(true);
          yield* Deferred.succeed(fixture.release, undefined);
          yield* Fiber.join(lock);
          expect(failedError(yield* Fiber.join(create)).code).toBe("incarnation_mismatch");
          expect(
            (yield* Ref.get(harness.dispatched)).some(
              (command) => command.type === "project.refresh" && command.projectId === "story",
            ),
          ).toBe(true);
        }),
    ),
);

it.effect("rechecks nested projects added while saga sessions are stopping", () =>
  scenario(
    (roots) =>
      Effect.gen(function* () {
        const fixture = yield* sagaFixture(roots);
        const nested = roots.path.join(fixture.rootsById.get("b")!, "repo");
        yield* roots.fs.makeDirectory(nested).pipe(Effect.orDie);
        return {
          ...fixture,
          onQuiesce: Effect.sync(() => {
            if (!fixture.shellProjects.some((project) => project.id === "nested"))
              fixture.shellProjects.push(projectShell("nested", nested));
          }),
        };
      }),
    (_, fixture) =>
      Effect.gen(function* () {
        const ops = yield* StaveOperations;
        const result = yield* runToEnd(ops, "nested-during-stop", {
          kind: "sagaArchive",
          sagaRoot: fixture.rootsById.get("story")!,
          expectedManifestCreatedAt: CREATED_AT,
          force: false,
          memory: "keep",
        });
        expect(failedError(result).code).toBe("nested_project");
        expect(fixture.history).not.toContain("cli");
        expect([...fixture.rows.values()].every((row) => row.ownerToken === null)).toBe(true);
      }),
  ),
);

it.effect("keeps a legacy unreadable cleanup without reading or mutating the disk", () =>
  scenario(
    (roots) =>
      Effect.sync(() => {
        const root = roots.path.join(roots.agentWorkDir, SPACE_ID);
        const fixture = lifecycleFixture(root, "refused");
        let reads = 0;
        return {
          root,
          fixture,
          lifecycle: fixture.service,
          reads: () => reads,
          readerLoad: () =>
            Effect.sync(() => {
              reads++;
              return Option.none<StaveProjectInfo>();
            }),
        };
      }),
    (harness, options) =>
      Effect.gen(function* () {
        const ops = yield* StaveOperations;
        const operation = {
          kind: "lifecycleAction" as const,
          projectId: ProjectId.make("p"),
          workspaceRoot: options.root,
          action: "dismiss" as const,
          force: false,
          memory: "keep" as const,
        };
        expect((yield* ops.dryRun(operation)).plan).toHaveLength(1);
        expect(finishedResult(yield* runToEnd(ops, "dismiss-legacy", operation))).toEqual({
          kind: "lifecycleAction",
          result: { projectId: "p", disposition: "kept" },
        });
        expect(options.reads()).toBe(0);
        expect(yield* Ref.get(harness.cliCalls)).toEqual([]);
        expect(options.fixture.row().deleteIntentSequence).toBeNull();
      }),
  ),
);

it.effect(
  "destroys a durable deleted-project row with no active shell and no duplicate project deletion",
  () =>
    scenario(
      (roots) =>
        Effect.gen(function* () {
          const root = roots.path.join(roots.agentWorkDir, SPACE_ID);
          yield* roots.fs.makeDirectory(root).pipe(Effect.orDie);
          const fixture = lifecycleFixture(root, "pending_destroy");
          return {
            root,
            fixture,
            lifecycle: fixture.service,
            readerLoad: () => Effect.succeed(Option.some(infoFor())),
          };
        }),
      (harness, options) =>
        Effect.gen(function* () {
          const ops = yield* StaveOperations;
          yield* ops.executeLifecycle({
            kind: "lifecycleAction",
            projectId: ProjectId.make("p"),
            workspaceRoot: options.root,
            expectedManifestCreatedAt: CREATED_AT,
            action: "retry",
            target: "destroy",
            force: false,
            memory: "keep",
          });
          expect(options.fixture.history).toEqual(["lease", "destroying", "destroyed", "release"]);
          expect(harness.analytics).toEqual([
            {
              event: "stave.space.destroyed",
              properties: { operationKind: "lifecycleAction", trigger: "automatic", count: 1 },
            },
          ]);
          expect(
            (yield* Ref.get(harness.cliCalls)).filter((call) => call.method === "spaceDestroy"),
          ).toHaveLength(1);
          expect(
            (yield* Ref.get(harness.dispatched)).filter(
              (command) => command.type === "project.delete",
            ),
          ).toEqual([]);
        }),
    ),
);

it.effect("revalidates automatic eligibility after quiescence and prevents the disk verb", () =>
  scenario(
    (roots) =>
      Effect.gen(function* () {
        const root = roots.path.join(roots.agentWorkDir, SPACE_ID);
        yield* roots.fs.makeDirectory(root).pipe(Effect.orDie);
        const fixture = lifecycleFixture(root, "pending_archive");
        let eligible = true;
        const archiveCalls: string[] = [];
        return {
          root,
          archiveCalls,
          fixture,
          lifecycle: fixture.service,
          readerLoad: () => Effect.succeed(Option.some(infoFor())),
          onQuiesce: Effect.sync(() => {
            eligible = false;
          }),
          validate: Effect.suspend(() =>
            eligible
              ? Effect.void
              : new StaveRefusalError({
                  code: "space_transitioning",
                  message: "Thread became active",
                  details: null,
                }),
          ),
          cliExtra: {
            spaceList: (input) => Effect.succeed(input?.archived ? [] : [listRow(root)]),
            spaceArchive: (input) =>
              Effect.sync(() => {
                archiveCalls.push(input.id);
                throw new Error("archive must not be invoked");
              }),
          },
        };
      }),
    (harness, options) =>
      Effect.gen(function* () {
        const ops = yield* StaveOperations;
        const error = yield* Effect.flip(
          ops.executeLifecycle(
            {
              kind: "lifecycleAction",
              projectId: ProjectId.make("p"),
              workspaceRoot: options.root,
              expectedManifestCreatedAt: CREATED_AT,
              action: "retry",
              target: "archive",
              force: false,
              memory: "keep",
            },
            options.validate,
          ),
        );
        expect(error.code).toBe("space_transitioning");
        expect(
          (yield* Ref.get(harness.cliCalls)).filter((call) => call.method === "spaceDestroy"),
        ).toEqual([]);
        expect(options.archiveCalls).toEqual([]);
        expect(options.fixture.row().disposition).toBe("refused");
      }),
  ),
);

it.effect("requires an explicit reviewed cleanup verb and the recorded incarnation", () =>
  scenario(
    (roots) =>
      Effect.sync(() => {
        const root = roots.path.join(roots.agentWorkDir, SPACE_ID);
        const fixture = lifecycleFixture(root, "refused");
        return {
          root,
          fixture,
          lifecycle: fixture.service,
          readerLoad: () => Effect.succeed(Option.some({ ...infoFor(), spaceId: "replacement" })),
        };
      }),
    (harness, options) =>
      Effect.gen(function* () {
        const ops = yield* StaveOperations;
        const operation = {
          kind: "lifecycleAction" as const,
          projectId: ProjectId.make("p"),
          workspaceRoot: options.root,
          action: "retry" as const,
          force: false,
          memory: "keep" as const,
        };
        expect((yield* Effect.flip(ops.dryRun(operation))).code).toBe("incarnation_mismatch");
        expect(
          (yield* Effect.flip(ops.dryRun({ ...operation, expectedManifestCreatedAt: CREATED_AT })))
            .code,
        ).toBe("invalid_arguments");
        expect(
          (yield* Effect.flip(
            ops.dryRun({ ...operation, expectedManifestCreatedAt: CREATED_AT, target: "destroy" }),
          )).code,
        ).toBe("incarnation_mismatch");
        expect(yield* Ref.get(harness.cliCalls)).toEqual([]);
      }),
  ),
);

it.effect(
  "automatic saga revalidates every participant before quiescence and again before CLI",
  () =>
    scenario(
      (roots) =>
        Effect.gen(function* () {
          const fixture = yield* sagaFixture(roots);
          const root = fixture.rootsById.get("story")!;
          const row = yield* fixture.lifecycle.ensure!({
            projectId: ProjectId.make("story"),
            workspaceRoot: root,
            spaceId: "story",
            manifestCreatedAt: CREATED_AT,
            now: NOW,
          }).pipe(Effect.orDie);
          return {
            ...fixture,
            root,
            lifecycle: {
              ...fixture.lifecycle,
              getByProjectId: () =>
                Effect.sync(() => Option.some(fixture.rows.get(row.projectId)!)),
              isProjectDeleted: () => Effect.succeed(false),
            },
          };
        }),
      (_harness, fixture) =>
        Effect.gen(function* () {
          const ops = yield* StaveOperations;
          const validated: string[] = [];
          const error = yield* Effect.flip(
            ops.executeLifecycle(
              {
                kind: "lifecycleAction",
                projectId: ProjectId.make("story"),
                workspaceRoot: fixture.root,
                expectedManifestCreatedAt: CREATED_AT,
                action: "archiveNow",
                force: false,
                memory: "keep",
              },
              Effect.void,
              (id) =>
                Effect.suspend(() => {
                  validated.push(id);
                  return id === "b" && validated.filter((value) => value === "b").length === 2
                    ? new StaveRefusalError({
                        code: "space_transitioning",
                        message: "Member became active",
                        details: null,
                      })
                    : Effect.void;
                }),
            ),
          );
          expect(error.code).toBe("space_transitioning");
          expect(validated.filter((id) => id === "b")).toHaveLength(2);
          expect(fixture.history).not.toContain("cli");
        }),
    ),
);

it.effect("records a terminal result only once across start-or-attach and observe replay", () =>
  scenario({}, (harness) =>
    Effect.gen(function* () {
      const ops = yield* StaveOperations;
      const operation = createSpaceOperation({
        title: "secret title",
        edits: [{ repo: "secret-repo", base: "secret-base" }],
        memory: [{ spec: "secret-den" }],
      });
      yield* runToEnd(ops, "private-operation-id", operation);
      yield* runToEnd(ops, "private-operation-id", operation);
      yield* Stream.runCollect(ops.observe({ operationId: "private-operation-id" }));
      expect(harness.analytics).toEqual([
        {
          event: "stave.space.created",
          properties: { operationKind: "createSpace", trigger: "interactive", count: 1 },
        },
      ]);
    }),
  ),
);

it.effect("failure telemetry excludes raw stderr, details and command text", () =>
  scenario(
    {
      cli: {
        spaceCreate: () =>
          Effect.fail(
            new StaveError({
              code: "unknown",
              message: "secret message",
              verb: "secret command",
              stderrTail: "secret stderr",
              details: { path: "secret path", den: "secret den" },
              exitCode: 1,
            }),
          ),
      },
    },
    (harness) =>
      Effect.gen(function* () {
        const ops = yield* StaveOperations;
        const events = yield* runToEnd(ops, "secret-operation-id", createSpaceOperation());
        expect(terminal(events).kind).toBe("failed");
        expect(harness.analytics).toEqual([
          {
            event: "stave.space.failed",
            properties: {
              operationKind: "createSpace",
              trigger: "interactive",
              count: 1,
              code: "unknown",
            },
          },
        ]);
      }),
  ),
);

describe("reviewed saga teardown scope", () => {
  it.effect("refuses an unreviewed cascade before leases or quiescence", () =>
    scenario(sagaFixture, (_, fixture) =>
      Effect.gen(function* () {
        const ops = yield* StaveOperations;
        const events = yield* collect(ops, {
          operationId: "missing-review",
          operation: {
            kind: "sagaArchive",
            sagaRoot: fixture.rootsById.get("story")!,
            expectedManifestCreatedAt: CREATED_AT,
            force: false,
            memory: "keep",
          },
        });
        expect(failedError(events).code).toBe("incarnation_mismatch");
        expect(fixture.history).toEqual([]);
      }),
    ),
  );
  it.effect("rejects changed roster edges and affected member projects after preview", () =>
    scenario(sagaFixture, (_, fixture) =>
      Effect.gen(function* () {
        const ops = yield* StaveOperations;
        const operation = {
          kind: "sagaArchive" as const,
          sagaRoot: fixture.rootsById.get("story")!,
          expectedManifestCreatedAt: CREATED_AT,
          force: false,
          memory: "keep" as const,
        };
        const preview = yield* ops.dryRun(operation);
        expect(
          preview.sagaReview?.participants.find((member) => member.spaceId === "a")?.projectId,
        ).toBe("a");
        expect(
          preview.sagaReview?.participants.find((member) => member.spaceId === "story")?.projectId,
        ).toBe("story");
        fixture.setMembers(fixture.members().map((member) => ({ ...member, after: [] })));
        const result = yield* collect(ops, {
          operationId: "changed-review",
          operation: { ...operation, expectedSagaReview: preview.sagaReview!.fingerprint },
        });
        expect(failedError(result).code).toBe("incarnation_mismatch");
        expect(fixture.history).toEqual([]);
        const fresh = yield* ops.dryRun(operation);
        fixture.shellProjects.splice(
          fixture.shellProjects.findIndex((project) => project.id === "a"),
          1,
        );
        expect(
          failedError(
            yield* collect(ops, {
              operationId: "changed-project",
              operation: { ...operation, expectedSagaReview: fresh.sagaReview!.fingerprint },
            }),
          ).code,
        ).toBe("incarnation_mismatch");
        expect(fixture.history).toEqual([]);
      }),
    ),
  );
});

it.effect("refuses archive of an archived incarnation before preview or mutation", () =>
  scenario(
    (roots) =>
      Effect.gen(function* () {
        const root = roots.path.join(roots.agentWorkDir, ".archive", SPACE_ID);
        yield* roots.fs.makeDirectory(root, { recursive: true }).pipe(Effect.orDie);
        return { root, readerLoad: () => Effect.succeed(Option.some(infoFor("archived"))) };
      }),
    (harness, options) =>
      Effect.gen(function* () {
        const ops = yield* StaveOperations;
        const operation = {
          kind: "archiveSpace" as const,
          workspaceRoot: options.root,
          expectedManifestCreatedAt: CREATED_AT,
          force: true,
          memory: "keep" as const,
        };
        expect((yield* Effect.flip(ops.dryRun(operation))).code).toBe("archived_project");
        expect(failedError(yield* runToEnd(ops, "old-archive", operation)).code).toBe(
          "archived_project",
        );
        expect(yield* Ref.get(harness.cliCalls)).toEqual([]);
      }),
  ),
);

it.effect("quiesces providers and terminals before detaching memory", () =>
  scenario(
    (roots) =>
      Effect.gen(function* () {
        const root = roots.path.join(roots.agentWorkDir, SPACE_ID);
        yield* roots.fs.makeDirectory(root).pipe(Effect.orDie);
        const quiesced: string[] = [];
        return {
          root,
          quiesced,
          activeProject: project("p", root),
          readerLoad: () => Effect.succeed(Option.some(infoFor())),
          cliExtra: {
            memoryDetach: () =>
              Effect.sync(() => {
                expect(quiesced).toEqual(["providers", "terminals"]);
                return {
                  spaceId: SPACE_ID,
                  spacePath: root,
                  manifest: manifest(SPACE_ID),
                  detached: [],
                  notes: [],
                };
              }),
          },
        };
      }),
    (_, options) =>
      Effect.gen(function* () {
        const ops = yield* StaveOperations;
        expect(
          finishedResult(
            yield* runToEnd(ops, "detach-after-stop", {
              kind: "memoryDetach",
              workspaceRoot: options.root,
              expectedManifestCreatedAt: CREATED_AT,
              fate: "destroy",
            }),
          ).kind,
        ).toBe("memoryDetach");
      }),
  ),
);

it.effect("reports an uncertain creation candidate without granting destructive cleanup", () =>
  scenario(
    (roots) =>
      Effect.succeed({
        cli: {
          spaceCreate: (input) =>
            Effect.gen(function* () {
              if (input.dryRun) return PLAN;
              yield* roots.fs
                .makeDirectory(roots.path.join(roots.agentWorkDir, input.id))
                .pipe(Effect.orDie);
              return yield* new StaveError({
                code: "timeout",
                message: "response lost",
                verb: "space create",
                exitCode: null,
                stderrTail: null,
                details: null,
              });
            }),
        },
      } satisfies HarnessOptions),
    (harness) =>
      Effect.gen(function* () {
        const ops = yield* StaveOperations;
        const result = failedError(
          yield* runToEnd(ops, "uncertain-create", createSpaceOperation()),
        );
        expect(result.details?.uncertainPartialSpace).toMatchObject({
          spaceId: SPACE_ID,
          spacePath: harness.path.join(harness.agentWorkDir, SPACE_ID),
        });
        expect(result.details?.partialSpace).toBeUndefined();
        expect(result.message).toContain("ownership could not be verified");
        expect(yield* Ref.get(harness.dispatched)).toEqual([]);
      }),
  ),
);

it.effect("saga review binds archived member conversations and survives coordinator deletion", () =>
  scenario(
    (roots) =>
      Effect.gen(function* () {
        const fixture = yield* sagaFixture(roots);
        const anchors = [
          {
            threadId: ThreadId.make("archived-member-thread"),
            createdAt: NOW,
            updatedAt: NOW,
            settledAt: null,
            unsettledAt: null,
            archivedAt: NOW,
            deletedAt: null,
            settledOverride: null,
          },
        ];
        return {
          ...fixture,
          anchors,
          threadAnchors: (projectId: ProjectId) => Effect.succeed(projectId === "a" ? anchors : []),
        };
      }),
    (_, fixture) =>
      Effect.gen(function* () {
        const ops = yield* StaveOperations;
        const operation = {
          kind: "sagaArchive" as const,
          sagaRoot: fixture.rootsById.get("story")!,
          expectedManifestCreatedAt: CREATED_AT,
          force: false,
          memory: "keep" as const,
        };
        const before = yield* ops.dryRun(operation);
        expect(
          before.sagaReview?.participants.find((member) => member.spaceId === "a")?.threadIds,
        ).toEqual(["archived-member-thread"]);
        fixture.shellProjects.splice(
          fixture.shellProjects.findIndex((project) => project.id === "story"),
          1,
        );
        const after = yield* ops.dryRun(operation);
        expect(after.sagaReview?.projectDeletionFingerprint).toBe(
          before.sagaReview?.projectDeletionFingerprint,
        );
        expect(after.sagaReview?.fingerprint).not.toBe(before.sagaReview?.fingerprint);
        fixture.anchors.push({
          ...fixture.anchors[0]!,
          threadId: ThreadId.make("another-archived-thread"),
        });
        expect(
          failedError(
            yield* collect(ops, {
              operationId: "archived-thread-scope",
              operation: { ...operation, expectedSagaReview: before.sagaReview!.fingerprint },
            }),
          ).code,
        ).toBe("incarnation_mismatch");
        expect(fixture.history).toEqual([]);
      }),
  ),
);

for (const moved of [false, true]) {
  it.effect(
    `recovers archive completion ${moved ? "after" : "before"} the project path update`,
    () =>
      scenario(
        (roots) =>
          Effect.gen(function* () {
            const live = roots.path.join(roots.agentWorkDir, SPACE_ID);
            const archive = roots.path.join(roots.agentWorkDir, ".archive", SPACE_ID);
            yield* roots.fs.makeDirectory(archive, { recursive: true }).pipe(Effect.orDie);
            const fixture = lifecycleFixture(live, "archiving");
            return {
              live,
              archive,
              fixture,
              activeProject: project("p", moved ? archive : live),
              lifecycle: fixture.service,
              readerLoad: (root: string) =>
                Effect.succeed(root === archive ? Option.some(infoFor("archived")) : Option.none()),
              cliExtra: {
                spaceList: (input) => Effect.succeed(input?.archived ? [listRow(archive)] : []),
              } satisfies Partial<StaveCliShape>,
            };
          }),
        (harness, options) =>
          Effect.gen(function* () {
            const ops = yield* StaveOperations;
            yield* ops.reconcileIncomplete;
            expect(options.fixture.row().disposition).toBe("archived");
            expect(options.fixture.row().workspaceRoot).toBe(options.archive);
            expect(
              (yield* Ref.get(harness.dispatched)).filter(
                (command) => command.type === "project.meta.update",
              ),
            ).toHaveLength(moved ? 0 : 1);
          }),
      ),
  );
}

it.effect("restore recovery clears the previous expired archive schedule", () =>
  scenario(
    (roots) =>
      Effect.gen(function* () {
        const live = roots.path.join(roots.agentWorkDir, SPACE_ID);
        const archive = roots.path.join(roots.agentWorkDir, ".archive", SPACE_ID);
        yield* roots.fs.makeDirectory(live).pipe(Effect.orDie);
        const fixture = lifecycleFixture(archive, "restoring");
        yield* fixture.service.updateDisposition!({
          projectId: ProjectId.make("p"),
          leaseEpoch: 0,
          ownerToken: "seed",
          now: NOW,
          patch: { anchorAt: CREATED_AT, scheduledAt: CREATED_AT, archiveDeadlineAt: CREATED_AT },
        }).pipe(Effect.orDie);
        return {
          live,
          fixture,
          activeProject: project("p", archive),
          lifecycle: fixture.service,
          readerLoad: (root: string) =>
            Effect.succeed(root === live ? Option.some(infoFor()) : Option.none()),
          cliExtra: {
            spaceList: (input) => Effect.succeed(input?.archived ? [] : [listRow(live)]),
          } satisfies Partial<StaveCliShape>,
        };
      }),
    (_, options) =>
      Effect.gen(function* () {
        const ops = yield* StaveOperations;
        yield* ops.reconcileIncomplete;
        expect(options.fixture.row()).toMatchObject({
          disposition: "live",
          workspaceRoot: options.live,
          anchorAt: null,
          scheduledAt: null,
          archiveDeadlineAt: null,
        });
      }),
  ),
);

it.effect("rejects an explicit saga preview after the coordinator is reimported", () =>
  scenario(sagaFixture, (_, fixture) =>
    Effect.gen(function* () {
      const ops = yield* StaveOperations;
      const root = fixture.rootsById.get("story")!;
      const operation = {
        kind: "sagaArchive" as const,
        sagaRoot: root,
        expectedManifestCreatedAt: CREATED_AT,
        force: false,
        memory: "keep" as const,
      };
      const preview = yield* ops.dryRun(operation);
      fixture.shellProjects.splice(
        fixture.shellProjects.findIndex((project) => project.id === "story"),
        1,
        projectShell("replacement", root),
      );
      const result = yield* collect(ops, {
        operationId: "replacement-coordinator",
        operation: { ...operation, expectedSagaReview: preview.sagaReview!.fingerprint },
      });
      expect(failedError(result).code).toBe("incarnation_mismatch");
      expect(fixture.history).toEqual([]);
    }),
  ),
);

it.effect(
  "durable saga deletion refuses a replacement coordinator despite matching member consent",
  () =>
    scenario(
      (roots) =>
        Effect.gen(function* () {
          const fixture = yield* sagaFixture(roots);
          return {
            ...fixture,
            lifecycle: {
              ...fixture.lifecycle,
              getByProjectId: (id: ProjectId) =>
                Effect.sync(() => Option.fromNullishOr(fixture.rows.get(id))),
              isProjectDeleted: () => Effect.succeed(true),
            },
          };
        }),
      (harness, fixture) =>
        Effect.gen(function* () {
          const ops = yield* StaveOperations;
          const root = fixture.rootsById.get("story")!;
          const operation = {
            kind: "sagaArchive" as const,
            sagaRoot: root,
            expectedManifestCreatedAt: CREATED_AT,
            force: false,
            memory: "keep" as const,
          };
          const preview = yield* ops.dryRun(operation);
          fixture.rows.set(ProjectId.make("story"), {
            ...lifecycleFixture(root, "pending_archive").row(),
            projectId: ProjectId.make("story"),
            spaceId: "story",
            deleteIntentSequence: 10,
          });
          fixture.shellProjects.splice(
            fixture.shellProjects.findIndex((project) => project.id === "story"),
            1,
            projectShell("replacement", root),
          );
          const error = yield* Effect.flip(
            ops.executeLifecycle({
              kind: "lifecycleAction",
              projectId: ProjectId.make("story"),
              workspaceRoot: root,
              expectedManifestCreatedAt: CREATED_AT,
              action: "retry",
              target: "archive",
              force: false,
              memory: "keep",
              expectedSagaReview: preview.sagaReview!.projectDeletionFingerprint,
            }),
          );
          expect(error.code).toBe("incarnation_mismatch");
          expect(fixture.history).not.toContain("cli");
          expect(
            (yield* Ref.get(harness.dispatched)).filter(
              (command) => command.type === "project.delete",
            ),
          ).toEqual([]);
        }),
    ),
);

for (const disabled of ["settings", "server"] as const) {
  it.effect(
    `production operation layer leaves recovery to the worker with ${disabled} disabled`,
    () =>
      scenario(
        (roots) =>
          Effect.gen(function* () {
            const root = roots.path.join(roots.agentWorkDir, SPACE_ID);
            const recoveryReads: string[] = [];
            const fixture = lifecycleFixture(root, "archiving");
            return {
              productionLayer: true,
              settingsEnabled: disabled !== "settings",
              serverEnabled: disabled !== "server",
              recoveryReads,
              lifecycle: {
                ...fixture.service,
                listIncomplete: () =>
                  Effect.sync(() => {
                    recoveryReads.push("read");
                    return [fixture.row()];
                  }),
              },
            };
          }),
        (harness, options) =>
          Effect.gen(function* () {
            yield* StaveOperations;
            expect(options.recoveryReads).toEqual([]);
            expect(yield* Ref.get(harness.cliCalls)).toEqual([]);
            expect(yield* Ref.get(harness.dispatched)).toEqual([]);
          }),
      ),
  );
}

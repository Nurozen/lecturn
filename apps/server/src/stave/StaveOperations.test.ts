import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type OrchestrationCommand,
  type OrchestrationProject,
  type OrchestrationProjectShell,
  ProjectId,
  type StaveCreateSpaceOperation,
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
  StaveOperations,
  type StaveOperationsLimits,
  type StaveOperationsShape,
} from "./StaveOperations.ts";
import { STAVE_ARCHIVE_DIRECTORY_NAME, StaveWorkspaceReader } from "./StaveWorkspaceReader.ts";

// ── Fixtures ──────────────────────────────────────────────────

const SPACE_ID = "demo";
const CREATED_AT = "2026-09-01T00:00:00Z";
const NOW = "2026-09-07T00:00:00.000Z";
const CONFIG_PATH = "/cfg/stave/config.yaml";
const PLAN: StaveDryRunPlan = { dryRun: true, plan: ["would create space demo"] };
const ENGINE_SEQUENCE = 42;
const CREATE_NOTES = ["cloned api", "wrote .stave.yaml"];

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
  /** Replaces the scenario's temp directory (the alias test points at a symlinked root). */
  readonly agentWorkDir?: string;
  readonly configExists?: boolean;
  readonly limits?: StaveOperationsLimits;
  readonly cli?: Partial<CliFakes>;
  /** Stdout the fake `git` answers with; defaults to nothing. */
  readonly processStdout?: (input: ProcessRunInput) => string;
  readonly shellProjects?: ReadonlyArray<OrchestrationProjectShell>;
  /** What `getActiveProjectByWorkspaceRoot` answers for every root. */
  readonly activeProject?: OrchestrationProject;
  /** Called with the running count on every config load (ordering probe for lock tests). */
  readonly onConfigLoad?: (count: number) => Effect.Effect<void>;
}

interface Harness extends Roots {
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

    const layer = layerWith(options.limits ?? {}).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(StaveCli)({
            spaceCreate: record("spaceCreate", fakes.spaceCreate),
            spaceStatus: record("spaceStatus", fakes.spaceStatus),
            spaceDestroy: record("spaceDestroy", fakes.spaceDestroy),
            reposAdd: record("reposAdd", fakes.reposAdd),
            setup: record("setup", fakes.setup),
          }),
          configReader,
          Layer.mock(StaveWorkspaceReader)({
            load: () => Effect.succeed(Option.none()),
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
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 0,
                projects: options.shellProjects ?? [],
                threads: [],
                updatedAt: NOW,
              }),
            getActiveProjectByWorkspaceRoot: () =>
              Effect.succeed(Option.fromNullishOr(options.activeProject)),
          }),
          WorkspacePaths.layer,
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-stave-operations-" }),
          StaveAdmission.layerNoop,
        ),
      ),
      Layer.provide(NodeServices.layer),
      Layer.orDie,
    );

    const harness: Harness = { fs, path, agentWorkDir, layer, cliCalls, dispatched, invalidated };
    return harness;
  });

/**
 * One test: a scoped temp `agentWorkDir`, a harness built from `options`
 * (static, or derived from the roots when the test prepares disk or gates
 * first), and `body` run against that single StaveOperations instance. The
 * resolved options are handed back so a body can reach the gates it built.
 */
const scenario = <Options extends HarnessOptions, A, E>(
  options: Options | ((roots: Roots) => Effect.Effect<Options>),
  body: (harness: Harness, options: Options) => Effect.Effect<A, E, StaveOperations>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "stave-operations-" });
    const roots: Roots = { fs, path, agentWorkDir: tempDir };
    const resolved = typeof options === "function" ? yield* options(roots) : options;
    const harness = yield* makeHarness(
      { ...roots, agentWorkDir: resolved.agentWorkDir ?? tempDir },
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
  collect(ops, { operationId, operation });

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
        expect(yield* Ref.get(harness.invalidated)).toEqual([]);
      }),
    ),
  );

  it.effect("removePartialSpace destroys a matching space and refreshes the project on it", () =>
    scenario(
      (roots) =>
        Effect.succeed({
          activeProject: project("on-space", roots.path.join(roots.agentWorkDir, SPACE_ID)),
        }),
      (harness) =>
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
          expect(destroy).toContain("--force");
          expect(destroy).toContain("--memory=destroy");
          expect(finishedResult(events).kind).toBe("removePartialSpace");

          const calls = yield* Ref.get(harness.cliCalls);
          expect(methodsCalled(calls)).toEqual(["spaceStatus", "spaceDestroy"]);
          expect(calls[1]?.input).toEqual({ id: SPACE_ID, force: true, memory: "destroy" });
          expect(yield* Ref.get(harness.invalidated)).toEqual([spacePath]);

          const dispatched = yield* Ref.get(harness.dispatched);
          expect(dispatched.map((command) => command.type)).toEqual(["project.refresh"]);
          const refresh = dispatched[0];
          expect(refresh?.type === "project.refresh" ? refresh.projectId : null).toBe("on-space");
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
        expect(yield* Ref.get(harness.invalidated)).toEqual([
          harness.path.join(harness.agentWorkDir, SPACE_ID),
        ]);
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
          const noDryRun = yield* Effect.flip(
            ops.dryRun({ kind: "syncSpace", workspaceRoot: "/spaces/demo", referencesOnly: false }),
          );
          expect(noDryRun).toBeInstanceOf(StaveError);
          expect(noDryRun.code).toBe("invalid_arguments");
          expect(noDryRun.verb).toBe("space sync");

          const notAPlan = yield* Effect.flip(ops.dryRun(createSpaceOperation()));
          expect(notAPlan.code).toBe("unreadable");
          expect(notAPlan.verb).toBe("space create");
        }),
    ),
  );
});

describe("StaveOperations unimplemented kinds", () => {
  it.effect("fails a kind that is not implemented yet without touching Stave", () =>
    scenario({}, (harness) =>
      Effect.gen(function* () {
        const ops = yield* StaveOperations;
        const events = yield* runToEnd(ops, "op-add", {
          kind: "addRepo",
          workspaceRoot: "/spaces/demo",
          repo: "api",
          mode: "edit",
          noFetch: false,
          linkMemory: false,
        });
        expect(outline(events)).toEqual(["failed"]);
        const error = failedError(events);
        expect(error.code).toBe("invalid_arguments");
        expect(error.message).toContain("not implemented");
        expect(yield* Ref.get(harness.cliCalls)).toEqual([]);
        expect((yield* summaryOf(ops, "op-add")).state).toBe("failed");
      }),
    ),
  );
});

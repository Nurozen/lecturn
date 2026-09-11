import { bundledStaveFeatures } from "./staveFeatures.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessEnvironment, HostProcessPlatform } from "@lecturn/shared/hostProcess";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as StaveBinary from "./StaveBinary.ts";
import * as StaveCli from "./StaveCli.ts";
import { makeRuntime } from "./staveRpcHandlers.ts";
import { StaveWorkspaceReader } from "./StaveWorkspaceReader.ts";
import { StaveError } from "./StaveError.ts";
import { isStaveDryRunPlan } from "./staveJson.ts";
import {
  SAMPLE_ERROR_DIRTY_WORKTREES,
  SAMPLE_ERROR_SPACE_NOT_FOUND,
  SAMPLE_PROSE_SPACE_STATUS_NOT_FOUND_STDERR,
  SAMPLE_SPACE_ADD,
  SAMPLE_SPACE_CREATE,
  SAMPLE_SPACE_CREATE_DRY_RUN,
  SAMPLE_SPACE_STATUS,
  SAMPLE_SPACE_SYNC,
  SAMPLE_VERSION_OUTPUT,
} from "./testing/staveJsonSamples.ts";

// ── Fake spawner (same shape as processRunner.test.ts) ────────

type ChildProcessCommand = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: {
    readonly shell?: boolean | string;
    readonly env?: NodeJS.ProcessEnv;
    readonly extendEnv?: boolean;
  };
};

// Accesses private properties of ChildProcessCommand for testing purposes
function asChildProcessCommand(command: unknown): ChildProcessCommand {
  return command as ChildProcessCommand;
}

// Completes `ended` only when the sink is run and its upstream finishes (EOF).
const eofTrackingStdin = (ended: Deferred.Deferred<void>) =>
  Sink.drain.pipe(Sink.mapEffect(() => Deferred.succeed(ended, undefined).pipe(Effect.asVoid)));

function makeHandle(input: {
  readonly stdout?: string | Stream.Stream<Uint8Array>;
  readonly stderr?: string | Stream.Stream<Uint8Array>;
  readonly code?: number;
  readonly stdin?: ChildProcessSpawner.ChildProcessHandle["stdin"];
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: input.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(input.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: input.stdin ?? Sink.drain,
    stdout:
      typeof input.stdout === "string"
        ? Stream.encodeText(Stream.make(input.stdout))
        : (input.stdout ?? Stream.empty),
    stderr:
      typeof input.stderr === "string"
        ? Stream.encodeText(Stream.make(input.stderr))
        : (input.stderr ?? Stream.empty),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

interface RecordedSpawn {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv | undefined;
  readonly extendEnv: boolean | undefined;
}

type Respond = (
  command: ChildProcessCommand,
) => Effect.Effect<ChildProcessSpawner.ChildProcessHandle, PlatformError.PlatformError>;

/** Records every spawn and answers with `respond`. */
function makeRecorder(respond: Respond) {
  const spawns: Array<RecordedSpawn> = [];
  const spawner = ChildProcessSpawner.make((raw) => {
    const command = asChildProcessCommand(raw);
    spawns.push({
      command: command.command,
      args: command.args,
      env: command.options.env,
      extendEnv: command.options.extendEnv,
    });
    return respond(command);
  });
  return { spawns, spawner };
}

const canned =
  (input: Parameters<typeof makeHandle>[0]): Respond =>
  () =>
    Effect.succeed(makeHandle(input));

const FAKE_BINARY = "/fake/stave";

const fixedBinary = StaveBinary.layerFixed({
  path: FAKE_BINARY,
  source: "path",
  version: "0.4.0",
  commit: null,
});

interface HarnessOptions {
  readonly configPath?: string;
  readonly binary?: Layer.Layer<StaveBinary.StaveBinary>;
}

const cliLayer = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  options: HarnessOptions = {},
) =>
  StaveCli.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        options.binary ?? fixedBinary,
        ProcessRunner.layer.pipe(
          Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        ),
        ServerSettings.layerTest({
          stave: { configPath: options.configPath ?? "/cfg/config.yaml" },
        }),
      ),
    ),
  );

/** Runs `f` against a StaveCli wired to the fake spawner; returns the recorded spawns too. */
const withCli = <A, E>(
  respond: Respond,
  f: (cli: StaveCli.StaveCliShape) => Effect.Effect<A, E>,
  options: HarnessOptions = {},
) => {
  const { spawns, spawner } = makeRecorder(respond);
  return Effect.gen(function* () {
    const cli = yield* StaveCli.StaveCli;
    const result = yield* f(cli);
    return { result, spawns };
  }).pipe(Effect.provide(cliLayer(spawner, options)));
};

const expectStaveError = (error: unknown): StaveError => {
  expect(error).toBeInstanceOf(StaveError);
  return error as StaveError;
};

const unwrap = <A>(result: Result.Result<A, string>): A => {
  if (Result.isFailure(result)) {
    throw new Error(`expected success, got failure: ${result.failure}`);
  }
  return result.success;
};

const failureOf = <A>(result: Result.Result<A, string>): string => {
  if (Result.isSuccess(result)) {
    throw new Error(`expected failure, got success: ${String(result.success)}`);
  }
  return result.failure;
};

// ── Tests ─────────────────────────────────────────────────────

describe("StaveCli argv", () => {
  it.effect("space create puts --config first, then verb, --json, flags, positionals", () =>
    Effect.gen(function* () {
      const { result, spawns } = yield* withCli(canned({ stdout: SAMPLE_SPACE_CREATE }), (cli) =>
        cli.spaceCreate({
          id: "s-1",
          edits: ["api"],
          references: ["web"],
          memory: [],
          saga: "s",
          after: ["m1"],
        }),
      );

      expect(isStaveDryRunPlan(result)).toBe(false);
      expect(spawns).toHaveLength(1);
      expect(spawns[0]?.command).toBe(FAKE_BINARY);
      expect(spawns[0]?.args).toEqual([
        "--config",
        "/cfg/config.yaml",
        "space",
        "create",
        "--json",
        "--edit=api",
        "--reference=web",
        "--saga=s",
        "--after=m1",
        "s-1",
      ]);
    }),
  );

  it.effect("omits --config when the setting is empty", () =>
    Effect.gen(function* () {
      const { spawns } = yield* withCli(
        canned({ stdout: SAMPLE_SPACE_STATUS }),
        (cli) => cli.spaceStatus("s-1"),
        { configPath: "" },
      );

      expect(spawns[0]?.args).toEqual(["space", "status", "--json", "s-1"]);
    }),
  );

  it.effect("space add renders the mode flag and --link-memory=false", () =>
    Effect.gen(function* () {
      const { spawns } = yield* withCli(canned({ stdout: SAMPLE_SPACE_ADD }), (cli) =>
        cli.spaceAdd({
          id: "s-1",
          repo: "web",
          mode: "reference",
          base: "origin/main",
          linkMemory: false,
        }),
      );

      expect(spawns[0]?.args).toEqual([
        "--config",
        "/cfg/config.yaml",
        "space",
        "add",
        "--json",
        "--reference",
        "--base=origin/main",
        "--link-memory=false",
        "s-1",
        "web",
      ]);
    }),
  );

  it("memory detach maps fate onto --destroy / --keep / nothing", () => {
    expect(
      unwrap(StaveCli.buildStaveArgv.memoryDetach({ id: "s-1", fate: "destroy", alias: "notes" })),
    ).toEqual(["memory", "detach", "--json", "--destroy", "s-1", "notes"]);
    expect(unwrap(StaveCli.buildStaveArgv.memoryDetach({ id: "s-1", fate: "keep" }))).toEqual([
      "memory",
      "detach",
      "--json",
      "--keep",
      "s-1",
    ]);
    expect(
      unwrap(StaveCli.buildStaveArgv.memoryDetach({ id: "s-1", force: true, dryRun: true })),
    ).toEqual(["memory", "detach", "--json", "--force", "--dry-run", "s-1"]);
  });

  it("every read verb asks for --json except version", () => {
    const build = StaveCli.buildStaveArgv;
    expect(unwrap(build.version())).toEqual(["version"]);
    expect(unwrap(build.configShow())).toEqual(["config", "show", "--json"]);
    expect(unwrap(build.reposList())).toEqual(["repos", "list", "--json"]);
    expect(unwrap(build.spaceList({}))).toEqual(["space", "list", "--json"]);
    expect(unwrap(build.spaceList({ archived: true }))).toEqual([
      "space",
      "list",
      "--json",
      "--archived",
    ]);
    expect(unwrap(build.spaceStatus("s-1"))).toEqual(["space", "status", "--json", "s-1"]);
    expect(unwrap(build.sagaList())).toEqual(["saga", "list", "--json"]);
    expect(unwrap(build.sagaStatus("train"))).toEqual(["saga", "status", "--json", "train"]);
    expect(unwrap(build.memoryProviders())).toEqual(["memory", "providers", "--json"]);
    expect(unwrap(build.memoryList({}))).toEqual(["memory", "list", "--json"]);
    expect(unwrap(build.memoryList({ spaceId: "s-1" }))).toEqual([
      "memory",
      "list",
      "--json",
      "s-1",
    ]);
  });

  it("mutation builders keep flags before positionals", () => {
    const build = StaveCli.buildStaveArgv;
    expect(unwrap(build.setup({ force: true }))).toEqual(["setup", "--json", "--force"]);
    expect(
      unwrap(
        build.reposAdd({
          name: "api",
          url: "git@example.com:org/api.git",
          adopt: true,
          dryRun: true,
        }),
      ),
    ).toEqual([
      "repos",
      "add",
      "--json",
      "--adopt",
      "--dry-run",
      "api",
      "git@example.com:org/api.git",
    ]);
    expect(unwrap(build.spaceInit({ id: "s-1", kind: "spike", spec: "./spec.md" }))).toEqual([
      "space",
      "init",
      "--json",
      "--kind=spike",
      "--spec=./spec.md",
      "s-1",
    ]);
    expect(
      unwrap(build.spaceRemove({ id: "s-1", repo: "api", mode: "edit", force: true })),
    ).toEqual(["space", "remove", "--json", "--edit", "--force", "s-1", "api"]);
    expect(unwrap(build.spaceSync({ id: "s-1", referencesOnly: true }))).toEqual([
      "space",
      "sync",
      "--json",
      "--references-only",
      "s-1",
    ]);
    expect(
      unwrap(build.spaceRetarget({ id: "s-1", repo: "api", base: "space:s-0", dryRun: true })),
    ).toEqual([
      "space",
      "retarget",
      "--json",
      "--repo=api",
      "--base=space:s-0",
      "--dry-run",
      "s-1",
    ]);
    expect(unwrap(build.spaceArchive({ id: "s-1", force: true, memory: "contribute" }))).toEqual([
      "space",
      "archive",
      "--json",
      "--force",
      "--memory=contribute",
      "s-1",
    ]);
    expect(unwrap(build.spaceRestore({ id: "s-1", from: "s-1-20260906T120000Z" }))).toEqual([
      "space",
      "restore",
      "--json",
      "--from=s-1-20260906T120000Z",
      "s-1",
    ]);
    expect(unwrap(build.spaceDestroy({ id: "s-1", memory: "destroy", dryRun: true }))).toEqual([
      "space",
      "destroy",
      "--json",
      "--memory=destroy",
      "--dry-run",
      "s-1",
    ]);
    expect(
      unwrap(
        build.sagaCreate({
          id: "train",
          spec: "spec.md",
          references: ["web:v2"],
          memory: ["."],
          noLearn: true,
        }),
      ),
    ).toEqual([
      "saga",
      "create",
      "--json",
      "--spec=spec.md",
      "--reference=web:v2",
      "--memory=.",
      "--no-learn",
      "train",
    ]);
    expect(
      unwrap(build.sagaAdd({ sagaId: "train", spaceId: "s-2", after: ["s-1"], clearAfter: true })),
    ).toEqual(["saga", "add", "--json", "--after=s-1", "--clear-after", "train", "s-2"]);
    expect(unwrap(build.sagaRemove({ sagaId: "train", spaceId: "s-2", dryRun: true }))).toEqual([
      "saga",
      "remove",
      "--json",
      "--dry-run",
      "train",
      "s-2",
    ]);
    expect(unwrap(build.sagaSync({ id: "train" }))).toEqual(["saga", "sync", "--json", "train"]);
    expect(unwrap(build.sagaArchive({ id: "train", memory: "keep" }))).toEqual([
      "saga",
      "archive",
      "--json",
      "--memory=keep",
      "train",
    ]);
    expect(unwrap(build.sagaDestroy({ id: "train", force: true }))).toEqual([
      "saga",
      "destroy",
      "--json",
      "--force",
      "train",
    ]);
    expect(
      unwrap(
        build.memoryAttach({
          id: "s-1",
          provider: "marmot",
          use: "mem-1",
          name: "notes",
          edit: ["team/wiki"],
          link: ["team/faq"],
          opt: ["depth=1"],
        }),
      ),
    ).toEqual([
      "memory",
      "attach",
      "--json",
      "--provider=marmot",
      "--use=mem-1",
      "--name=notes",
      "--edit=team/wiki",
      "--link=team/faq",
      "--opt=depth=1",
      "s-1",
    ]);
  });

  it("rejects ids that break Stave's name rule and flag-shaped free values", () => {
    const build = StaveCli.buildStaveArgv;
    for (const id of ["../x", "-bad", "", "a b"]) {
      expect(failureOf(build.spaceStatus(id))).toContain("space id");
      expect(failureOf(build.spaceArchive({ id }))).toContain("space id");
      expect(failureOf(build.sagaStatus(id))).toContain("saga id");
    }
    expect(failureOf(build.reposAdd({ name: "api", url: "--adopt" }))).toContain("url");
    expect(failureOf(build.reposAdd({ name: "../api", url: "https://x" }))).toContain("repo name");
    expect(failureOf(build.reposAdd({ name: "api", url: "   " }))).toContain("url");
    expect(failureOf(build.reposAdd({ name: "api", url: "https://x\nevil" }))).toContain("url");
    expect(
      failureOf(
        build.spaceCreate({
          id: "s-1",
          edits: ["../x:main"],
          references: [],
          memory: [],
          after: [],
        }),
      ),
    ).toContain("--edit");
    expect(
      failureOf(
        build.spaceCreate({ id: "s-1", edits: [], references: [], memory: [], after: ["m1"] }),
      ),
    ).toBe("after requires saga");
    expect(
      failureOf(build.spaceAdd({ id: "s-1", repo: "api", mode: "edit", base: "-x" })),
    ).toContain("--base");
    expect(failureOf(build.memoryAttach({ id: "s-1", edit: [], link: [], opt: ["-x"] }))).toContain(
      "--opt",
    );
    expect(failureOf(build.spaceRestore({ id: "s-1", from: "../etc" }))).toContain("--from");
    expect(failureOf(build.memoryDetach({ id: "s-1", alias: "-rf" }))).toContain("memory alias");
  });

  it.effect("an invalid id fails with invalid_arguments and never spawns", () =>
    Effect.gen(function* () {
      for (const id of ["../x", "-bad", ""]) {
        const { result, spawns } = yield* withCli(canned({ stdout: SAMPLE_SPACE_STATUS }), (cli) =>
          cli.spaceStatus(id).pipe(Effect.flip),
        );
        const error = expectStaveError(result);
        expect(error.code).toBe("invalid_arguments");
        expect(error.verb).toBe("space status");
        expect(error.exitCode).toBeNull();
        expect(spawns).toHaveLength(0);
      }

      const { result, spawns } = yield* withCli(canned({ stdout: "{}" }), (cli) =>
        cli.reposAdd({ name: "api", url: "--adopt" }).pipe(Effect.flip),
      );
      expect(expectStaveError(result).code).toBe("invalid_arguments");
      expect(spawns).toHaveLength(0);
    }),
  );
});

describe("StaveCli spawn discipline", () => {
  it.effect("closes stdin, drops STAVE_CD_FD, forwards MARMOT_HOME, resolves env fully", () =>
    Effect.gen(function* () {
      const ended = yield* Deferred.make<void>();
      const { spawns } = yield* withCli(
        () =>
          Effect.succeed(
            makeHandle({ stdout: SAMPLE_SPACE_STATUS, stdin: eofTrackingStdin(ended) }),
          ),
        (cli) => cli.spaceStatus("s-1"),
      ).pipe(
        Effect.provideService(HostProcessEnvironment, {
          PATH: "/usr/bin",
          STAVE_CD_FD: "3",
          MARMOT_HOME: "/m",
        }),
      );

      expect(yield* Deferred.isDone(ended)).toBe(true);
      expect(spawns[0]?.extendEnv).toBe(false);
      expect(spawns[0]?.env).toEqual({ PATH: "/usr/bin", MARMOT_HOME: "/m" });
    }),
  );

  it.effect("leaves MARMOT_HOME out when the host does not set it", () =>
    Effect.gen(function* () {
      const { spawns } = yield* withCli(canned({ stdout: SAMPLE_SPACE_STATUS }), (cli) =>
        cli.spaceStatus("s-1"),
      ).pipe(Effect.provideService(HostProcessEnvironment, { PATH: "/usr/bin", MARMOT_HOME: "" }));

      expect(spawns[0]?.env).toEqual({ PATH: "/usr/bin", MARMOT_HOME: "" });
      expect(spawns[0]?.extendEnv).toBe(false);
    }),
  );
});

describe("StaveCli output policy", () => {
  it.effect("decodes a success payload on exit 0", () =>
    Effect.gen(function* () {
      const { result } = yield* withCli(canned({ stdout: SAMPLE_SPACE_STATUS }), (cli) =>
        cli.spaceStatus("s-1"),
      );

      expect(result.spaceId).toBe("s-1");
      expect(result.repos.map((repo) => repo.name)).toEqual(["api", "web"]);
    }),
  );

  it.effect("reads the error envelope on exit 1", () =>
    Effect.gen(function* () {
      const { result } = yield* withCli(
        canned({ stdout: SAMPLE_ERROR_DIRTY_WORKTREES, code: 1 }),
        (cli) => cli.spaceArchive({ id: "s-1" }).pipe(Effect.flip),
      );

      const error = expectStaveError(result);
      expect(error.code).toBe("dirty_worktrees");
      expect(error.details?.repos).toEqual(["api"]);
      expect(error.exitCode).toBe(1);
      expect(error.verb).toBe("space archive");
      expect(error.stderrTail).toBeNull();
      expect(error.message).toContain("dirty editable worktrees");
    }),
  );

  it.effect("normalises an unknown envelope code to unknown and keeps rawCode", () =>
    Effect.gen(function* () {
      const envelope =
        '{"error":{"code":"brand_new_code","message":"future stave","details":{"hint":1}}}';
      const { result } = yield* withCli(canned({ stdout: envelope, code: 1 }), (cli) =>
        cli.spaceSync({ id: "s-1" }).pipe(Effect.flip),
      );

      const error = expectStaveError(result);
      expect(error.code).toBe("unknown");
      expect(error.details).toEqual({ hint: 1, rawCode: "brand_new_code" });
      expect(error.message).toBe("future stave");
    }),
  );

  it.effect("degrades prose on stderr with empty stdout to non_json_output", () =>
    Effect.gen(function* () {
      const { result } = yield* withCli(
        canned({ stdout: "", stderr: SAMPLE_PROSE_SPACE_STATUS_NOT_FOUND_STDERR, code: 1 }),
        (cli) => cli.spaceStatus("nope").pipe(Effect.flip),
      );

      const error = expectStaveError(result);
      expect(error.code).toBe("non_json_output");
      expect(error.exitCode).toBe(1);
      expect(error.stderrTail).toBe(SAMPLE_PROSE_SPACE_STATUS_NOT_FOUND_STDERR.trim());
      expect(error.message).toBe(error.stderrTail);
    }),
  );

  it.effect("falls back to the exit status when both streams are empty", () =>
    Effect.gen(function* () {
      const { result } = yield* withCli(canned({ code: 3 }), (cli) =>
        cli.spaceStatus("s-1").pipe(Effect.flip),
      );

      const error = expectStaveError(result);
      expect(error.code).toBe("non_json_output");
      expect(error.message).toBe("stave space status exited with status 3");
      expect(error.exitCode).toBe(3);
    }),
  );

  it.effect("reports prose on stdout for a json verb as non_json_output", () =>
    Effect.gen(function* () {
      const { result } = yield* withCli(
        canned({ stdout: "SPACE  s-1\nrepos: api web\n", stderr: "warn\n" }),
        (cli) => cli.spaceStatus("s-1").pipe(Effect.flip),
      );

      const error = expectStaveError(result);
      expect(error.code).toBe("non_json_output");
      expect(error.exitCode).toBe(0);
      expect(error.message).toBe("stave space status did not return JSON");
      expect(error.details?.stdoutHead).toBe("SPACE  s-1\nrepos: api web\n");
      expect(error.stderrTail).toBe("warn");
    }),
  );

  it.effect("reports JSON that misses the contract as unreadable", () =>
    Effect.gen(function* () {
      const { result } = yield* withCli(canned({ stdout: '{"nope":1}' }), (cli) =>
        cli.spaceStatus("s-1").pipe(Effect.flip),
      );

      const error = expectStaveError(result);
      expect(error.code).toBe("unreadable");
      expect(error.exitCode).toBe(0);
      expect(typeof error.details?.detail).toBe("string");
    }),
  );

  it.effect("parses version prose", () =>
    Effect.gen(function* () {
      const { result, spawns } = yield* withCli(
        canned({ stdout: SAMPLE_VERSION_OUTPUT }),
        (cli) => cli.version,
      );

      expect(result).toEqual({ version: "0.4.0" });
      expect(spawns[0]?.args).toEqual(["--config", "/cfg/config.yaml", "version"]);
    }),
  );

  it.effect("returns the plan for a dry run", () =>
    Effect.gen(function* () {
      const { result, spawns } = yield* withCli(
        canned({ stdout: SAMPLE_SPACE_CREATE_DRY_RUN }),
        (cli) =>
          cli.spaceCreate({
            id: "s-dry",
            edits: ["api"],
            references: [],
            memory: [],
            after: [],
            dryRun: true,
          }),
      );

      expect(isStaveDryRunPlan(result)).toBe(true);
      if (isStaveDryRunPlan(result)) {
        expect(result.plan).toHaveLength(6);
      }
      expect(spawns[0]?.args).toContain("--dry-run");
    }),
  );

  it.effect("treats a plan on a verb without dry-run as unreadable", () =>
    Effect.gen(function* () {
      const { result } = yield* withCli(canned({ stdout: SAMPLE_SPACE_CREATE_DRY_RUN }), (cli) =>
        cli.spaceInit({ id: "s-1" }).pipe(Effect.flip),
      );

      expect(expectStaveError(result).code).toBe("unreadable");
    }),
  );
});

describe("StaveCli spawn failures", () => {
  it.effect("maps a NotFound spawn error to binary_missing", () =>
    Effect.gen(function* () {
      const { result } = yield* withCli(
        () =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
              pathOrDescriptor: FAKE_BINARY,
            }),
          ),
        (cli) => cli.spaceStatus("s-1").pipe(Effect.flip),
      );

      const error = expectStaveError(result);
      expect(error.code).toBe("binary_missing");
      expect(error.details).toEqual({ path: FAKE_BINARY });
      expect(error.exitCode).toBeNull();
    }),
  );

  it.effect("maps any other spawn error to spawn_failed", () =>
    Effect.gen(function* () {
      const { result } = yield* withCli(
        () =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "ChildProcess",
              method: "spawn",
              pathOrDescriptor: FAKE_BINARY,
            }),
          ),
        (cli) => cli.spaceStatus("s-1").pipe(Effect.flip),
      );

      const error = expectStaveError(result);
      expect(error.code).toBe("spawn_failed");
      expect(error.message).toContain("Failed to spawn process");
    }),
  );

  it.effect("reports an unresolved binary as binary_missing without spawning", () =>
    Effect.gen(function* () {
      const missing = Layer.succeed(
        StaveBinary.StaveBinary,
        StaveBinary.StaveBinary.of({
          resolveForPath: () =>
            Effect.fail(new StaveBinary.StaveBinaryNotFound({ candidates: [] })),
          features: Effect.succeed(bundledStaveFeatures()),
          featuresFor: () => Effect.succeed(bundledStaveFeatures()),
          resolve: Effect.fail(new StaveBinary.StaveBinaryNotFound({ candidates: ["stave"] })),
          resolveRunnable: Effect.fail(
            new StaveBinary.StaveBinaryNotFound({ candidates: ["stave"] }),
          ),
          invalidate: Effect.void,
        }),
      );
      const { result, spawns } = yield* withCli(
        canned({ stdout: SAMPLE_SPACE_STATUS }),
        (cli) => cli.spaceStatus("s-1").pipe(Effect.flip),
        { binary: missing },
      );

      const error = expectStaveError(result);
      expect(error.code).toBe("binary_missing");
      expect(error.details).toEqual({ candidates: ["stave"] });
      expect(error.verb).toBe("space status");
      expect(spawns).toHaveLength(0);
    }),
  );
});

describe("StaveCli timeouts", () => {
  const neverExits = canned({ exitCode: Effect.never });

  it.effect("a read times out after STAVE_READ_TIMEOUT", () =>
    Effect.gen(function* () {
      const fiber = yield* withCli(neverExits, (cli) =>
        cli.spaceStatus("s-1").pipe(Effect.flip),
      ).pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      yield* TestClock.adjust(StaveCli.STAVE_READ_TIMEOUT);
      const { result } = yield* Fiber.join(fiber);

      const error = expectStaveError(result);
      expect(error.code).toBe("timeout");
      expect(error.message).toBe(
        `stave space status timed out after ${Duration.toMillis(StaveCli.STAVE_READ_TIMEOUT)}ms`,
      );
      expect(error.exitCode).toBeNull();
    }),
  );

  it.effect("a mutation outlives the read timeout and stops at STAVE_MUTATION_TIMEOUT", () =>
    Effect.gen(function* () {
      const settled = yield* Deferred.make<void>();
      const fiber = yield* withCli(neverExits, (cli) =>
        cli.spaceSync({ id: "s-1" }).pipe(Effect.flip),
      ).pipe(Effect.ensuring(Deferred.succeed(settled, undefined)), Effect.forkScoped);

      yield* Effect.yieldNow;
      yield* TestClock.adjust(StaveCli.STAVE_READ_TIMEOUT);
      expect(yield* Deferred.isDone(settled)).toBe(false);

      yield* TestClock.adjust(
        Duration.subtract(StaveCli.STAVE_MUTATION_TIMEOUT, StaveCli.STAVE_READ_TIMEOUT),
      );
      const { result } = yield* Fiber.join(fiber);

      const error = expectStaveError(result);
      expect(error.code).toBe("timeout");
      expect(error.verb).toBe("space sync");
      expect(error.message).toBe(
        `stave space sync timed out after ${Duration.toMillis(StaveCli.STAVE_MUTATION_TIMEOUT)}ms`,
      );
    }),
  );
});

describe("StaveCli streaming", () => {
  it.effect("onLine receives stderr progress lines", () =>
    Effect.gen(function* () {
      const lines: Array<string> = [];
      const { result } = yield* withCli(
        canned({ stdout: SAMPLE_SPACE_SYNC, stderr: "fetching api\nfetching web\n" }),
        (cli) =>
          cli.spaceSync(
            { id: "s-1" },
            { onLine: (line) => Effect.sync(() => void lines.push(line)) },
          ),
      );

      expect(result.spaceId).toBe("s-1");
      expect(lines).toContain("fetching api");
      expect(lines).toContain("fetching web");
    }),
  );
});

// ── Real process ──────────────────────────────────────────────

const FAKE_STAVE_ENV_KEYS = [
  "FAKE_STAVE_MODE",
  "FAKE_STAVE_STDOUT",
  "FAKE_STAVE_ARGV_FILE",
] as const;

/** Sets the fake binary's env for the duration of `effect`, restoring the host env after. */
const withFakeStaveEnv = <A, E, R>(
  values: Partial<Record<(typeof FAKE_STAVE_ENV_KEYS)[number], string>>,
  effect: Effect.Effect<A, E, R>,
) => {
  const previous = new Map(FAKE_STAVE_ENV_KEYS.map((key) => [key, process.env[key]] as const));
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      for (const key of FAKE_STAVE_ENV_KEYS) {
        const value = values[key];
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }),
    () => effect,
    () =>
      Effect.sync(() => {
        for (const key of FAKE_STAVE_ENV_KEYS) {
          const value = previous.get(key);
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      }),
  );
};

it.layer(NodeServices.layer)("StaveCli real process", (it) => {
  const installFakeStave = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "lecturn-stave-cli-" });
    const binary = path.join(dir, "stave");
    yield* fileSystem.copyFile(path.join(import.meta.dirname, "testing", "fake-stave.sh"), binary);
    yield* fileSystem.chmod(binary, 0o755);
    return { dir, binary, argvFile: path.join(dir, "argv.txt") };
  });

  const realCli = (binary: string) =>
    StaveCli.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          StaveBinary.layerFixed({
            path: binary,
            source: "settings",
            version: "0.4.0",
            commit: null,
          }),
          ProcessRunner.layer,
          ServerSettings.layerTest({ stave: { configPath: "/cfg/config.yaml" } }),
        ),
      ),
    );

  it.effect("drives a real binary through every output path", () =>
    Effect.gen(function* () {
      // This integration fixture is a POSIX shell executable.
      if ((yield* HostProcessPlatform) === "win32") return;
      const fileSystem = yield* FileSystem.FileSystem;
      const { binary, argvFile } = yield* installFakeStave;

      yield* Effect.gen(function* () {
        const cli = yield* StaveCli.StaveCli;

        const status = yield* withFakeStaveEnv(
          {
            FAKE_STAVE_MODE: "json",
            FAKE_STAVE_STDOUT: SAMPLE_SPACE_STATUS,
            FAKE_STAVE_ARGV_FILE: argvFile,
          },
          cli.spaceStatus("s-1"),
        );
        expect(status.spaceId).toBe("s-1");
        const argv = (yield* fileSystem.readFileString(argvFile)).trimEnd().split("\n");
        expect(argv).toEqual(["--config", "/cfg/config.yaml", "space", "status", "--json", "s-1"]);

        const notFound = yield* withFakeStaveEnv(
          { FAKE_STAVE_MODE: "error", FAKE_STAVE_STDOUT: SAMPLE_ERROR_SPACE_NOT_FOUND },
          cli.spaceSync({ id: "nope" }).pipe(Effect.flip),
        );
        expect(expectStaveError(notFound).code).toBe("space_not_found");
        expect(notFound.exitCode).toBe(1);

        const prose = yield* withFakeStaveEnv(
          { FAKE_STAVE_MODE: "prose" },
          cli.spaceStatus("s-1").pipe(Effect.flip),
        );
        const proseError = expectStaveError(prose);
        expect(proseError.code).toBe("non_json_output");
        expect(proseError.exitCode).toBe(1);
        expect(proseError.stderrTail).toBe("hello");
      }).pipe(Effect.provide(realCli(binary)));
    }),
  );
});

it.effect("feature gates exact requested flags before any mutating spawn", () =>
  Effect.gen(function* () {
    const limited = bundledStaveFeatures();
    const binary = StaveBinary.layerFixed(
      { path: FAKE_BINARY, source: "settings", version: "0.1.0", commit: null },
      {
        ...limited,
        source: "help",
        commands: limited.commands.map((command) =>
          command.verb === "space add"
            ? { ...command, flags: command.flags.filter((flag) => flag !== "branch") }
            : command,
        ),
      },
    );
    const allowed = yield* withCli(
      canned({ stdout: SAMPLE_SPACE_ADD }),
      (cli) => cli.spaceAdd({ id: "s-1", repo: "api", mode: "edit" }),
      { binary },
    );
    expect(allowed.spawns).toHaveLength(1);
    const denied = yield* withCli(
      canned({ stdout: SAMPLE_SPACE_ADD }),
      (cli) =>
        cli
          .spaceAdd({ id: "s-1", repo: "api", mode: "edit", branch: "private-branch" })
          .pipe(Effect.flip),
      { binary },
    );
    expect(denied.spawns).toHaveLength(0);
    expect(denied.result.code).toBe("unsupported_feature");
    expect(denied.result.details).toEqual({ missing: ["branch"] });
    expect(denied.result.message).not.toContain("private-branch");
  }),
);

it.effect(
  "failed mutations update shared RPC diagnostics and later successful reads retain the failure",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-09-01T00:00:00.000Z"));
      const recorder = makeRecorder((command) =>
        Effect.succeed(
          makeHandle(
            command.args.includes("sync")
              ? { stdout: SAMPLE_ERROR_DIRTY_WORKTREES, code: 1 }
              : { stdout: SAMPLE_SPACE_STATUS },
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const cli = yield* StaveCli.StaveCli;
        const runtime = yield* makeRuntime();
        expect(Option.isNone(yield* runtime.lastFailure)).toBe(true);
        const error = yield* Effect.flip(cli.spaceSync({ id: "s-1" }));
        expect(error.code).toBe("dirty_worktrees");
        expect(Option.getOrThrow(yield* runtime.lastFailure)).toMatchObject({
          at: "2026-09-01T00:00:00.000Z",
          verb: "space sync",
          code: "dirty_worktrees",
          message: error.message,
        });
        yield* TestClock.adjust("1 second");
        yield* cli.spaceStatus("s-1");
        expect(Option.getOrThrow(yield* runtime.lastFailure)).toMatchObject({
          at: "2026-09-01T00:00:00.000Z",
          verb: "space sync",
          code: "dirty_worktrees",
        });
        expect(recorder.spawns).toHaveLength(2);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(cliLayer(recorder.spawner), Layer.mock(StaveWorkspaceReader)({})),
        ),
      );
    }),
);

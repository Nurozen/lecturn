/**
 * `lecturn squire load-fixture` (D44f): loads a Squire fixture scenario into a
 * running dev or test server through the dev fixture route. It targets the
 * worktree's own Lecturn home unless `--base-dir` names one, never the shared
 * home, and refuses before it issues an auth session unless that server
 * serves the fixture route, which exists only with `LECTURN_SQUIRE=1` and
 * `LECTURN_TEST_PROVIDERS=1` (R26).
 */
import {
  AuthOrchestrationOperateScope,
  SquireFakeScript,
  SquireFixtureScenario,
} from "@lecturn/contracts";
import { resolveWorktreeLecturnHome } from "@lecturn/shared/devHome";
import * as HostProcess from "@lecturn/shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { applyFixtureOverrides } from "../squire/SquireDevFixtures.ts";
import { SQUIRE_DEV_FIXTURE_ROUTE, SquireDevFixtureRequest } from "../squire/http.ts";
import { baseDirFlag, resolveCliAuthConfig } from "./config.ts";

export class SquireFixtureHomeMissingError extends Schema.TaggedError<SquireFixtureHomeMissingError>()(
  "SquireFixtureHomeMissingError",
  {},
) {
  override get message(): string {
    return "Not inside a git worktree, so there is no worktree Lecturn home. Pass --base-dir to name the dev server's home.";
  }
}

export class SquireFixtureServerMissingError extends Schema.TaggedError<SquireFixtureServerMissingError>()(
  "SquireFixtureServerMissingError",
  { statePath: Schema.String },
) {
  override get message(): string {
    return `No running Lecturn server found (checked ${this.statePath}).`;
  }
}

export class SquireFixtureGateClosedError extends Schema.TaggedError<SquireFixtureGateClosedError>()(
  "SquireFixtureGateClosedError",
  { origin: Schema.String, status: Schema.Int },
) {
  override get message(): string {
    return `The server at ${this.origin} does not serve Squire fixtures (status ${this.status}). Start it with LECTURN_SQUIRE=1 LECTURN_TEST_PROVIDERS=1.`;
  }
}

export class SquireFixtureFileError extends Schema.TaggedError<SquireFixtureFileError>()(
  "SquireFixtureFileError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not read the fixture file ${this.path}.`;
  }
}

export class SquireFixtureUsageError extends Schema.TaggedError<SquireFixtureUsageError>()(
  "SquireFixtureUsageError",
  { problem: Schema.String },
) {
  override get message(): string {
    return this.problem;
  }
}

export class SquireFixtureRequestError extends Schema.TaggedError<SquireFixtureRequestError>()(
  "SquireFixtureRequestError",
  {
    op: Schema.String,
    status: Schema.optionalKey(Schema.Int),
    detail: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    const status = this.status === undefined ? "no response" : `status ${this.status}`;
    return `Squire fixture ${this.op} failed (${status})${this.detail ? `: ${this.detail}` : ""}.`;
  }
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const ServerFailure = Schema.Struct({ message: Schema.String });
const decodeServerFailure = Schema.decodeUnknownOption(ServerFailure);

/** `k=v`; the value is JSON when it parses, else the raw string. */
const parseFixtureSet = (entries: ReadonlyArray<string>) =>
  Effect.forEach(entries, (entry) => {
    const index = entry.indexOf("=");
    if (index <= 0) {
      return Effect.fail(
        new SquireFixtureUsageError({ problem: `--set expects key=value, got "${entry}".` }),
      );
    }
    const raw = entry.slice(index + 1);
    return Effect.succeed([
      entry.slice(0, index),
      Option.getOrElse(decodeJson(raw), () => raw),
    ] as const);
  }).pipe(Effect.map((pairs) => Object.fromEntries(pairs)));

/** `events.*` and `timeline.*` address the scenario; every other path is relative to `setup`. */
const isScenarioPath = (path: string) => /^(events|timeline)(\.|$)/.test(path);

const readJsonFile = Effect.fn("squire.readFixtureFile")(function* (file: string) {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const resolved = path.resolve(yield* HostProcess.WorkingDirectory, file);
  const text = yield* fileSystem
    .readFileString(resolved)
    .pipe(Effect.mapError((cause) => new SquireFixtureFileError({ path: resolved, cause })));
  return {
    resolved,
    json: yield* Option.match(decodeJson(text), {
      onNone: () =>
        Effect.fail(new SquireFixtureFileError({ path: resolved, cause: new Error("not JSON") })),
      onSome: Effect.succeed,
    }),
  };
});

const decodeFile = <S extends Schema.Top>(schema: S, file: { resolved: string; json: unknown }) =>
  Schema.decodeUnknownEffect(schema)(file.json).pipe(
    Effect.mapError((cause) => new SquireFixtureFileError({ path: file.resolved, cause })),
  );

const resolveFixtureHome = Effect.fn("squire.resolveFixtureHome")(function* (
  explicit: Option.Option<string>,
) {
  if (Option.isSome(explicit) && explicit.value.trim().length > 0) {
    return yield* resolveBaseDir(explicit.value);
  }
  // Never LECTURN_HOME or ~/.lecturn: those are the developer's live install.
  const home = yield* resolveWorktreeLecturnHome(yield* HostProcess.WorkingDirectory);
  if (home === undefined) return yield* new SquireFixtureHomeMissingError();
  return home;
});

/**
 * The fixture route authenticates before reading anything, so an
 * unauthenticated probe answers 401 exactly when it exists and 404 otherwise.
 */
const requireFixtureServer = Effect.fn("squire.requireFixtureServer")(function* (home: string) {
  const { serverRuntimeStatePath } = yield* ServerConfig.deriveServerPaths(home, undefined, {
    baseDirIsExplicit: true,
  });
  const missing = new SquireFixtureServerMissingError({ statePath: serverRuntimeStatePath });
  const state = yield* readPersistedServerRuntimeState(serverRuntimeStatePath).pipe(
    Effect.orElseSucceed(() => Option.none()),
  );
  if (Option.isNone(state) || !isProcessAlive(state.value.pid)) return yield* missing;
  const origin = state.value.origin;
  const client = yield* HttpClient.HttpClient;
  const probe = yield* client
    .execute(HttpClientRequest.post(new URL(SQUIRE_DEV_FIXTURE_ROUTE, origin).toString()))
    .pipe(Effect.option);
  if (Option.isNone(probe)) return yield* missing;
  if (probe.value.status !== 401) {
    return yield* new SquireFixtureGateClosedError({ origin, status: probe.value.status });
  }
  return origin;
});

const encodeRequest = Schema.encodeEffect(SquireDevFixtureRequest);

const sendFixtureRequest = (origin: string, token: string, request: SquireDevFixtureRequest) =>
  Effect.gen(function* () {
    const failed = (fields: {
      readonly status?: number;
      readonly detail?: string;
      readonly cause?: unknown;
    }) => new SquireFixtureRequestError({ op: request.op, ...fields });
    const body = yield* encodeRequest(request).pipe(Effect.mapError((cause) => failed({ cause })));
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(
        HttpClientRequest.post(new URL(SQUIRE_DEV_FIXTURE_ROUTE, origin).toString()).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.bodyJsonUnsafe(body),
        ),
      )
      .pipe(Effect.mapError((cause) => failed({ cause })));
    const json = yield* response.json.pipe(Effect.orElseSucceed(() => undefined));
    if (response.status !== 200) {
      const detail = decodeServerFailure(json);
      return yield* failed({
        status: response.status,
        ...(Option.isSome(detail) ? { detail: detail.value.message } : {}),
      });
    }
    return json;
  });

const LoadedResult = Schema.Struct({ squireId: Schema.String });
const InjectedResult = Schema.Struct({ sequence: Schema.Int });

const runFixtureOps = Effect.fn("squire.runFixtureOps")(function* (input: {
  readonly origin: string;
  readonly token: string;
  readonly reset: Option.Option<string>;
  readonly scenario: Option.Option<SquireFixtureScenario>;
  readonly setupOverrides: Readonly<Record<string, unknown>>;
  readonly fake: Option.Option<SquireFakeScript>;
}) {
  const send = (request: SquireDevFixtureRequest) =>
    sendFixtureRequest(input.origin, input.token, request);
  const decodeResult = <S extends Schema.Top>(schema: S, op: string, value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError((cause) => new SquireFixtureRequestError({ op, status: 200, cause })),
    );

  if (Option.isSome(input.reset)) {
    yield* send({ op: "reset", name: input.reset.value });
    yield* Console.log(`Reset ${input.reset.value}.`);
  }
  if (Option.isNone(input.scenario)) return;
  const scenario = input.scenario.value;
  const loaded = yield* decodeResult(
    LoadedResult,
    "loadSetup",
    yield* send({
      op: "loadSetup",
      setup: scenario.setup,
      ...(Object.keys(input.setupOverrides).length === 0 ? {} : { set: input.setupOverrides }),
      ...(Option.isSome(input.fake) ? { fake: input.fake.value } : {}),
    }),
  );
  const sequences: Array<number> = [];
  for (const event of scenario.events) {
    const injected = yield* decodeResult(
      InjectedResult,
      "inject",
      yield* send({ op: "inject", event }),
    );
    sequences.push(injected.sequence);
  }
  for (const sequence of sequences) yield* send({ op: "drainThrough", sequence });
  for (const action of scenario.timeline ?? []) yield* send({ op: "timeline", action });
  yield* Console.log(
    `Loaded ${scenario.id} into Squire ${loaded.squireId}: ${scenario.events.length} event(s), ${(scenario.timeline ?? []).length} timeline step(s).`,
  );
});

const loadFixture = Effect.fn("squire.loadFixture")(function* (flags: {
  readonly file: Option.Option<string>;
  readonly set: ReadonlyArray<string>;
  readonly reset: Option.Option<string>;
  readonly fakeProvider: Option.Option<string>;
  readonly baseDir: Option.Option<string>;
}) {
  if (Option.isNone(flags.file) && Option.isNone(flags.reset)) {
    return yield* new SquireFixtureUsageError({
      problem: "Pass a fixture file, --reset <name>, or both.",
    });
  }
  if (Option.isNone(flags.file) && (flags.set.length > 0 || Option.isSome(flags.fakeProvider))) {
    return yield* new SquireFixtureUsageError({
      problem: "--set and --fake-provider need a fixture file.",
    });
  }
  // Inputs are read and validated before the server is touched.
  const overrides = Object.entries(yield* parseFixtureSet(flags.set));
  // Setup paths travel to the loader unapplied: what they name decides what it
  // changes on a Squire the user already has.
  const setupOverrides = Object.fromEntries(overrides.filter(([path]) => !isScenarioPath(path)));
  const scenario = yield* Effect.transposeOption(
    Option.map(flags.file, (file) =>
      Effect.gen(function* () {
        const read = yield* readJsonFile(file);
        const json = applyFixtureOverrides(
          read.json,
          Object.fromEntries(overrides.filter(([path]) => isScenarioPath(path))),
        );
        yield* decodeFile(SquireFixtureScenario, {
          resolved: read.resolved,
          json: applyFixtureOverrides(
            json,
            Object.fromEntries(
              Object.entries(setupOverrides).map(([path, value]) => [`setup.${path}`, value]),
            ),
          ),
        });
        return yield* decodeFile(SquireFixtureScenario, { resolved: read.resolved, json });
      }),
    ),
  );
  const fake = yield* Effect.transposeOption(
    Option.map(flags.fakeProvider, (file) =>
      Effect.flatMap(readJsonFile(file), (read) => decodeFile(SquireFakeScript, read)),
    ),
  );

  const home = yield* resolveFixtureHome(flags.baseDir);
  const origin = yield* requireFixtureServer(home);

  const config = yield* resolveCliAuthConfig(
    { baseDir: Option.some(home) },
    yield* GlobalFlag.LogLevel,
  );
  return yield* Effect.gen(function* () {
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    yield* Effect.acquireUseRelease(
      environmentAuth.issueSession({
        scopes: [AuthOrchestrationOperateScope],
        label: "lecturn squire load-fixture",
      }),
      (issued) =>
        runFixtureOps({
          origin,
          token: issued.token,
          reset: flags.reset,
          scenario,
          setupOverrides,
          fake,
        }),
      (issued) =>
        environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
    );
  }).pipe(
    Effect.provide(
      EnvironmentAuth.layerRuntime.pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
      ),
    ),
  );
});

const loadFixtureCommand = Command.make("load-fixture", {
  file: Argument.String("file").pipe(
    Argument.withDescription(
      "Fixture scenario JSON, for example apps/server/src/squire/testdata/scenarios/05-merged-propose-thread.json.",
    ),
    Argument.optional,
  ),
  set: Flag.String("set").pipe(
    Flag.withDescription(
      "Override a value: key=value, where value is JSON or a string. events.* and timeline.* address the scenario; other keys are relative to setup. Repeatable.",
    ),
    Flag.atLeast(0),
  ),
  reset: Flag.String("reset").pipe(
    Flag.withDescription("Delete the fixture Squire with this name first."),
    Flag.optional,
  ),
  fakeProvider: Flag.String("fake-provider").pipe(
    Flag.withDescription("squireFake script JSON the fixture Squire's home thread runs."),
    Flag.optional,
  ),
  baseDir: baseDirFlag,
}).pipe(
  Command.withDescription("Load a Squire fixture into a running dev or test server."),
  Command.withHandler((flags) => loadFixture(flags).pipe(Effect.provide(FetchHttpClient.layer))),
);

export const squireCommand = Command.make("squire").pipe(
  Command.withDescription("Squire developer tools."),
  Command.unlisted,
  Command.withSubcommands([loadFixtureCommand]),
);

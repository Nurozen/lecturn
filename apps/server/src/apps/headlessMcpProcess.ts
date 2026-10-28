/**
 * The stdio MCP client for an app's headless tool command. One
 * connection is one spawned process speaking newline-delimited JSON-RPC.
 * `@modelcontextprotocol/sdk` is a devDependency only, so this is our own
 * small client rather than the SDK's.
 */
// Foreign JSON-RPC lines are decoded only as far as routing needs; results
// pass through to callers that decode them with their own schemas.
// @effect-diagnostics preferSchemaOverJson:off
import {
  APP_WORKSPACE_ROOT_PLACEHOLDER,
  type AppHeadlessTools,
  AppsError,
} from "@lecturn/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { McpSchema } from "effect/ai";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

/** The version RocketWright pins; its answer is accepted whatever it says. */
export const HEADLESS_MCP_PROTOCOL_VERSION = "2025-11-25";

const HANDSHAKE_TIMEOUT = Duration.seconds(30);
const LIST_TIMEOUT = Duration.seconds(30);
const MAX_LIST_OUTPUT_BYTES = 4 * 1024 * 1024;
const STDERR_TAIL_BYTES = 2_000;
const KILL_GRACE = Duration.seconds(5);

/**
 * The desktop app runs the server with this set; inherited, it would turn an
 * Electron-built app command into plain Node.
 */
const STRIPPED_ENV = ["ELECTRON_RUN_AS_NODE"] as const;

export interface HeadlessProcessSpec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

const substitute = (value: string, workspaceRoot: string) =>
  value.replaceAll(APP_WORKSPACE_ROOT_PLACEHOLDER, workspaceRoot);

/**
 * `listArgs` is `undefined` for the call-path command. The registration's env
 * is pinned at grant (it is part of the grant fingerprint), so it wins over
 * the host's.
 */
export const resolveHeadlessSpec = (input: {
  readonly headless: AppHeadlessTools;
  readonly workspaceRoot: string;
  readonly hostEnv: Readonly<Record<string, string | undefined>>;
  readonly args: ReadonlyArray<string>;
}): HeadlessProcessSpec => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.hostEnv)) {
    if (value !== undefined) env[name] = value;
  }
  for (const name of STRIPPED_ENV) delete env[name];
  for (const [name, value] of Object.entries(input.headless.env ?? {})) {
    env[name] = substitute(value, input.workspaceRoot);
  }
  return {
    command: input.headless.command,
    args: input.args.map((arg) => substitute(arg, input.workspaceRoot)),
    cwd: substitute(input.headless.cwd, input.workspaceRoot),
    env,
  };
};

const failure = (message: string) => new AppsError({ code: "unavailable", message });

const describeCause = (cause: unknown) =>
  cause instanceof Error
    ? cause.message
    : Cause.isCause(cause)
      ? Cause.pretty(cause)
      : String(cause);

const command = (spec: HeadlessProcessSpec, stdin: Stream.Stream<Uint8Array>) =>
  ChildProcess.make(spec.command, [...spec.args], {
    cwd: spec.cwd,
    env: spec.env,
    extendEnv: false,
    stdin: { stream: stdin, endOnDone: true },
    forceKillAfter: KILL_GRACE,
  });

const collectStderrTail = (stderr: Stream.Stream<Uint8Array, unknown>) => {
  let tail = "";
  return {
    tail: () => tail.trim(),
    drain: stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          tail = (tail + chunk).slice(-STDERR_TAIL_BYTES);
        }),
      ),
      Effect.ignore,
    ),
  };
};

type JsonRpcMessage = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is JsonRpcMessage =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseLine = (line: string): JsonRpcMessage | undefined => {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

const rpcErrorMessage = (error: unknown) =>
  isRecord(error) && typeof error.message === "string" ? error.message : "request failed";

export interface HeadlessMcpConnection {
  readonly pid: number;
  /** Fails with `AppsError` on a JSON-RPC error or when the process goes away. */
  readonly request: (method: string, params: unknown) => Effect.Effect<unknown, AppsError>;
  /** Ends stdin and waits for the process to exit on its own. */
  readonly closeStdin: Effect.Effect<void>;
  /** SIGTERM to the process group; revoke and shutdown only. */
  readonly kill: Effect.Effect<void>;
  /** Resolves once the process's stdout has ended. */
  readonly exited: Effect.Effect<void>;
}

/**
 * Spawns the process in the caller's scope (closing it kills the process) and
 * completes the MCP handshake before returning.
 */
export const connect = Effect.fn("headlessMcpProcess.connect")(function* (
  spec: HeadlessProcessSpec,
): Effect.fn.Return<
  HeadlessMcpConnection,
  AppsError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const input = yield* Queue.make<Uint8Array, Cause.Done>();
  const handle = yield* spawner
    .spawn(command(spec, Stream.fromQueue(input)))
    .pipe(
      Effect.mapError((cause) =>
        failure(`Could not start ${spec.command}: ${describeCause(cause)}`),
      ),
    );

  const pending = new Map<number, Deferred.Deferred<unknown, AppsError>>();
  let nextId = 1;
  let gone: AppsError | undefined;
  const stderr = collectStderrTail(handle.stderr);
  const exited = yield* Deferred.make<void>();
  const encoder = new TextEncoder();

  const write = (message: JsonRpcMessage) =>
    Queue.offer(input, encoder.encode(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`));

  const settleAll = (error: AppsError) =>
    Effect.gen(function* () {
      gone = error;
      for (const deferred of pending.values()) yield* Deferred.fail(deferred, error);
      pending.clear();
      yield* Deferred.succeed(exited, undefined);
    });

  const onMessage = (message: JsonRpcMessage) =>
    Effect.gen(function* () {
      if (typeof message.method === "string") {
        // Server-to-client requests (roots, sampling, elicitation) are not offered.
        if (message.id !== undefined) {
          yield* write({
            id: message.id,
            error: { code: -32601, message: `Lecturn does not support ${message.method}.` },
          });
        }
        return;
      }
      if (typeof message.id !== "number") return;
      const deferred = pending.get(message.id);
      if (deferred === undefined) return;
      pending.delete(message.id);
      if (message.error !== undefined) {
        yield* Deferred.fail(deferred, failure(rpcErrorMessage(message.error)));
      } else {
        yield* Deferred.succeed(deferred, message.result);
      }
    });

  yield* Effect.forkScoped(stderr.drain);
  yield* handle.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => {
      const message = parseLine(line);
      return message === undefined ? Effect.void : onMessage(message);
    }),
    Effect.ignore,
    Effect.andThen(
      Effect.suspend(() =>
        settleAll(
          failure(`${spec.command} exited${stderr.tail() === "" ? "" : `: ${stderr.tail()}`}`),
        ),
      ),
    ),
    Effect.forkScoped,
  );
  // A kill closes the scope, which interrupts the reader before it settles;
  // this finalizer runs first, so waiting and later requests fail, not hang.
  yield* Effect.addFinalizer(() =>
    Effect.suspend(() =>
      gone === undefined ? settleAll(failure(`${spec.command} was stopped.`)) : Effect.void,
    ),
  );

  const request = (method: string, params: unknown) =>
    Effect.suspend(() => {
      if (gone !== undefined) return Effect.fail(gone);
      const id = nextId++;
      return Deferred.make<unknown, AppsError>().pipe(
        Effect.tap((deferred) => Effect.sync(() => pending.set(id, deferred))),
        Effect.tap(() => write({ id, method, params })),
        Effect.flatMap(Deferred.await),
        Effect.onInterrupt(() => Effect.sync(() => pending.delete(id))),
      );
    });

  const connection: HeadlessMcpConnection = {
    pid: handle.pid,
    request,
    closeStdin: Queue.end(input).pipe(Effect.andThen(Deferred.await(exited))),
    kill: handle.kill().pipe(Effect.ignore),
    exited: Deferred.await(exited),
  };

  yield* request("initialize", {
    protocolVersion: HEADLESS_MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "lecturn", version: "1.0.0" },
  }).pipe(
    Effect.timeoutOrElse({
      duration: HANDSHAKE_TIMEOUT,
      orElse: () => Effect.fail(failure(`${spec.command} did not answer initialize.`)),
    }),
  );
  yield* write({ method: "notifications/initialized" });
  return connection;
});

const decodeTools = Schema.decodeUnknownEffect(Schema.Array(McpSchema.Tool));

const decodeToolList = (value: unknown, source: string) =>
  decodeTools(isRecord(value) ? value.tools : Array.isArray(value) ? value : undefined).pipe(
    Effect.mapError(() => failure(`${source} printed tool definitions Lecturn cannot read.`)),
  );

/** Follows `nextCursor` so a paged server lists every tool. */
export const listTools = (connection: HeadlessMcpConnection) =>
  Effect.gen(function* () {
    const tools: Array<McpSchema.Tool> = [];
    let cursor: string | undefined;
    do {
      const page = yield* connection.request("tools/list", cursor === undefined ? {} : { cursor });
      tools.push(...(yield* decodeToolList(page, "The app's tool server")));
      cursor = isRecord(page) && typeof page.nextCursor === "string" ? page.nextCursor : undefined;
    } while (cursor !== undefined);
    return tools;
  }).pipe(
    Effect.timeoutOrElse({
      duration: LIST_TIMEOUT,
      orElse: () => Effect.fail(failure("The app's tool server did not list its tools.")),
    }),
  );

/**
 * Runs the registration's lock-free listing command: it prints the tool
 * definitions as JSON (`{tools}` or a bare array) and exits.
 */
export const runListCommand = Effect.fn("headlessMcpProcess.runListCommand")(function* (
  spec: HeadlessProcessSpec,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner
        .spawn(command(spec, Stream.empty))
        .pipe(
          Effect.mapError((cause) =>
            failure(`Could not start ${spec.command}: ${describeCause(cause)}`),
          ),
        );
      const stderr = collectStderrTail(handle.stderr);
      const [stdout, exitCode] = yield* Effect.all(
        [
          handle.stdout.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (text, chunk) => text + chunk,
            ),
          ),
          handle.exitCode,
          stderr.drain,
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError((cause) => failure(`${spec.command} failed: ${describeCause(cause)}`)),
      );
      if (exitCode !== 0) {
        return yield* failure(
          `${spec.command} exited with ${exitCode}${stderr.tail() === "" ? "" : `: ${stderr.tail()}`}`,
        );
      }
      if (stdout.length > MAX_LIST_OUTPUT_BYTES) {
        return yield* failure(`${spec.command} printed more than ${MAX_LIST_OUTPUT_BYTES} bytes.`);
      }
      const parsed = parseJson(stdout);
      return yield* decodeToolList(parsed, spec.command);
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: LIST_TIMEOUT,
      orElse: () => Effect.fail(failure(`${spec.command} did not exit after listing its tools.`)),
    }),
  );
});

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

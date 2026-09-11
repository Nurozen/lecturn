import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { HostProcessEnvironment, HostProcessPlatform } from "@lecturn/shared/hostProcess";
import { resolveSpawnCommand } from "@lecturn/shared/shell";
import {
  collectUint8StreamText,
  decodeUtf8,
  type CollectedUint8StreamText,
} from "./stream/collectUint8StreamText.ts";

export interface ProcessRunInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly spawnCwd?: string | undefined;
  readonly timeout?: Duration.Input | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Defaults to inheriting the host environment; false uses only `env`. */
  readonly extendEnv?: boolean | undefined;
  /**
   * Variable names removed from the child's environment after `env` has been
   * merged over the host environment (e.g. `["STAVE_CD_FD"]` so a child never
   * inherits a parent-only protocol descriptor).
   */
  readonly unsetEnv?: ReadonlyArray<string> | undefined;
  /**
   * Text written to the child's stdin. Any string, including `""`, is written
   * and then ENDS the pipe so the child sees EOF; `undefined` never runs the
   * stdin sink and leaves the pipe open.
   */
  readonly stdin?: string | undefined;
  readonly maxOutputBytes?: number | undefined;
  readonly outputMode?: "error" | "truncate" | undefined;
  readonly truncatedMarker?: string | undefined;
  /**
   * On timeout, return a synthetic timedOut result.
   * Partial stdout/stderr are not preserved.
   */
  readonly timeoutBehavior?: "error" | "timedOutResult" | undefined;
  /**
   * Receives each complete stdout line as it arrives, while output is still
   * being buffered into the result. Lines are split on "\n" with a trailing
   * "\r" stripped; empty lines are skipped and a trailing partial line is
   * flushed at end-of-stream. Output caps, truncation, and the returned text
   * are unaffected.
   */
  readonly onStdoutLine?: ((line: string) => Effect.Effect<void>) | undefined;
  /** Same as `onStdoutLine`, for stderr. */
  readonly onStderrLine?: ((line: string) => Effect.Effect<void>) | undefined;
}

export interface ProcessRunOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: ChildProcessSpawner.ExitCode | null;
  readonly timedOut: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly stdoutInvalidUtf8: boolean;
  readonly stderrInvalidUtf8: boolean;
}

const ProcessInvocationFields = {
  command: Schema.String,
  argumentCount: Schema.Number,
  cwd: Schema.optional(Schema.String),
  spawnCwd: Schema.optional(Schema.String),
};

const formatProcessInvocation = (input: {
  readonly command: string;
  readonly cwd?: string | undefined;
  readonly spawnCwd?: string | undefined;
}): string => {
  const executionCwd = input.spawnCwd ?? input.cwd;
  return executionCwd === undefined
    ? `'${input.command}'`
    : `'${input.command}' in '${executionCwd}'`;
};

export class ProcessSpawnError extends Schema.TaggedErrorClass<ProcessSpawnError>()(
  "ProcessSpawnError",
  {
    ...ProcessInvocationFields,
    resolvedCommand: Schema.optional(Schema.String),
    resolvedArgumentCount: Schema.optional(Schema.Number),
    shell: Schema.optional(Schema.Boolean),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to spawn process ${formatProcessInvocation(this)}`;
  }
}

export class ProcessStdinError extends Schema.TaggedErrorClass<ProcessStdinError>()(
  "ProcessStdinError",
  {
    ...ProcessInvocationFields,
    stdinBytes: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to write stdin for process ${formatProcessInvocation(this)}`;
  }
}

export class ProcessOutputLimitError extends Schema.TaggedErrorClass<ProcessOutputLimitError>()(
  "ProcessOutputLimitError",
  {
    ...ProcessInvocationFields,
    stream: Schema.Literals(["stdout", "stderr"]),
    maxBytes: Schema.Number,
    observedBytes: Schema.Number,
  },
) {
  override get message(): string {
    return `Process ${formatProcessInvocation(this)} ${this.stream} produced ${this.observedBytes} bytes, exceeding the ${this.maxBytes} byte limit`;
  }
}

export class ProcessReadError extends Schema.TaggedErrorClass<ProcessReadError>()(
  "ProcessReadError",
  {
    ...ProcessInvocationFields,
    stream: Schema.Literals(["stdout", "stderr", "exitCode"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read ${this.stream} for process ${formatProcessInvocation(this)}`;
  }
}

export class ProcessTimeoutError extends Schema.TaggedErrorClass<ProcessTimeoutError>()(
  "ProcessTimeoutError",
  {
    ...ProcessInvocationFields,
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Process ${formatProcessInvocation(this)} timed out after ${this.timeoutMs}ms`;
  }
}

export const ProcessRunError = Schema.Union([
  ProcessSpawnError,
  ProcessStdinError,
  ProcessOutputLimitError,
  ProcessReadError,
  ProcessTimeoutError,
]);
export type ProcessRunError = typeof ProcessRunError.Type;

export class ProcessRunner extends Context.Service<
  ProcessRunner,
  {
    readonly run: (input: ProcessRunInput) => Effect.Effect<ProcessRunOutput, ProcessRunError>;
  }
>()("lecturn/processRunner") {}

const DEFAULT_TIMEOUT = "60 seconds";
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const WINDOWS_COMMAND_NOT_FOUND_PATTERNS = [
  /is not recognized as an internal or external command/i,
  /n.o . reconhecido como um comando interno/i,
  /non . riconosciuto come comando interno o esterno/i,
  /n.est pas reconnu en tant que commande interne/i,
  /no se reconoce como un comando interno o externo/i,
  /wird nicht als interner oder externer befehl/i,
] as const;

function hasWindowsCommandNotFoundMessage(output: string): boolean {
  return WINDOWS_COMMAND_NOT_FOUND_PATTERNS.some((pattern) => pattern.test(output));
}

export const isWindowsCommandNotFound = Effect.fn("processRunner.isWindowsCommandNotFound")(
  function* (code: number | null, stderr: string) {
    const platform = yield* HostProcessPlatform;
    if (platform !== "win32") return false;
    if (code === 9009) return true;
    return hasWindowsCommandNotFoundMessage(stderr);
  },
);

// Line splitter shared with GitVcsDriverCore.collectOutput: decodes chunks
// incrementally and emits complete lines, flushing the partial tail on end.
const makeLineEmitter = (onLine: (line: string) => Effect.Effect<void>) => {
  const decoder = new TextDecoder();
  let lineBuffer = "";

  const emitCompleteLines = Effect.fnUntraced(function* (flush: boolean) {
    let newlineIndex = lineBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = lineBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        yield* onLine(line);
      }
      newlineIndex = lineBuffer.indexOf("\n");
    }

    if (flush) {
      const trailing = lineBuffer.replace(/\r$/, "");
      lineBuffer = "";
      if (trailing.length > 0) {
        yield* onLine(trailing);
      }
    }
  });

  return {
    feed: Effect.fnUntraced(function* (chunk: Uint8Array) {
      lineBuffer += decoder.decode(chunk, { stream: true });
      yield* emitCompleteLines(false);
    }),
    flush: Effect.suspend(() => {
      lineBuffer += decoder.decode();
      return emitCompleteLines(true);
    }),
  };
};

const collectText = Effect.fn("processRunner.collectText")(function* (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly spawnCwd?: string | undefined;
  readonly streamName: "stdout" | "stderr";
  readonly stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>;
  readonly maxOutputBytes: number;
  readonly outputMode: "error" | "truncate";
  readonly truncatedMarker: string;
  readonly onLine?: ((line: string) => Effect.Effect<void>) | undefined;
}) {
  const lineEmitter = input.onLine === undefined ? undefined : makeLineEmitter(input.onLine);
  const mappedStream = input.stream.pipe(
    Stream.mapError(
      (cause) =>
        new ProcessReadError({
          command: input.command,
          argumentCount: input.args.length,
          cwd: input.cwd,
          spawnCwd: input.spawnCwd,
          stream: input.streamName,
          cause,
        }),
    ),
  );
  const stream =
    lineEmitter === undefined ? mappedStream : mappedStream.pipe(Stream.tap(lineEmitter.feed));

  const collected = yield* collectBuffered({ ...input, stream });
  if (lineEmitter !== undefined) {
    yield* lineEmitter.flush;
  }
  return collected;
});

const collectBuffered = Effect.fnUntraced(function* (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly spawnCwd?: string | undefined;
  readonly streamName: "stdout" | "stderr";
  readonly stream: Stream.Stream<Uint8Array, ProcessReadError>;
  readonly maxOutputBytes: number;
  readonly outputMode: "error" | "truncate";
  readonly truncatedMarker: string;
}) {
  const stream = input.stream;

  if (input.outputMode === "truncate") {
    return yield* collectUint8StreamText({
      stream,
      maxBytes: input.maxOutputBytes,
      truncatedMarker: input.truncatedMarker,
    });
  }

  return yield* stream.pipe(
    Stream.runFoldEffect<
      {
        readonly chunks: Uint8Array<ArrayBufferLike>[];
        readonly bytes: number;
      },
      Uint8Array<ArrayBufferLike>,
      ProcessOutputLimitError | ProcessReadError,
      never
    >(
      () => ({ chunks: [], bytes: 0 }),
      (state, chunk) => {
        const remainingBytes = input.maxOutputBytes - state.bytes;
        if (chunk.byteLength > remainingBytes) {
          return Effect.fail(
            new ProcessOutputLimitError({
              command: input.command,
              argumentCount: input.args.length,
              cwd: input.cwd,
              spawnCwd: input.spawnCwd,
              stream: input.streamName,
              maxBytes: input.maxOutputBytes,
              observedBytes: state.bytes + chunk.byteLength,
            }),
          );
        }

        state.chunks.push(chunk);
        return Effect.succeed({
          chunks: state.chunks,
          bytes: state.bytes + chunk.byteLength,
        });
      },
    ),
    Effect.map((state): CollectedUint8StreamText => ({
      ...decodeUtf8(Buffer.concat(state.chunks, state.bytes)),
      bytes: state.bytes,
      truncated: false,
    })),
  );
});

function finalizeRunProcess<R>(
  effect: Effect.Effect<ProcessRunOutput, ProcessRunError, R | Scope.Scope>,
  input: ProcessRunInput,
): Effect.Effect<ProcessRunOutput, ProcessRunError, Exclude<R, Scope.Scope>> {
  const timeout = Duration.fromInputUnsafe(input.timeout ?? DEFAULT_TIMEOUT);
  const timeoutBehavior = input.timeoutBehavior ?? "error";

  return effect.pipe(
    Effect.scoped,
    Effect.timeoutOption(timeout),
    Effect.flatMap((result) => {
      if (Option.isSome(result)) {
        return Effect.succeed(result.value);
      }
      if (timeoutBehavior === "timedOutResult") {
        return Effect.succeed({
          stdout: "",
          stderr: "",
          code: null,
          timedOut: true,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        } satisfies ProcessRunOutput);
      }
      return Effect.fail(
        new ProcessTimeoutError({
          command: input.command,
          argumentCount: input.args.length,
          cwd: input.cwd,
          spawnCwd: input.spawnCwd,
          timeoutMs: Duration.toMillis(timeout),
        }),
      );
    }),
  );
}

// Without `unsetEnv` the spawner merges `env` over the host environment itself;
// with it, the merge happens here so the named variables can be dropped.
const resolveEnvOptions = Effect.fnUntraced(function* (
  input: Pick<ProcessRunInput, "env" | "unsetEnv" | "extendEnv">,
): Effect.fn.Return<{ readonly env?: NodeJS.ProcessEnv; readonly extendEnv?: boolean }> {
  const unsetEnv = input.unsetEnv ?? [];
  if (unsetEnv.length === 0) {
    if (input.extendEnv === false) return { env: input.env ?? {}, extendEnv: false };
    return input.env === undefined ? {} : { env: input.env, extendEnv: true };
  }

  const hostEnvironment = yield* HostProcessEnvironment;
  const env: NodeJS.ProcessEnv = {
    ...(input.extendEnv === false ? {} : hostEnvironment),
    ...input.env,
  };
  for (const name of unsetEnv) {
    delete env[name];
  }
  return { env, extendEnv: false };
});

const runProcessCore = Effect.fn("processRunner.runProcessCore")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  input: ProcessRunInput,
): Effect.fn.Return<ProcessRunOutput, ProcessRunError, Scope.Scope> {
  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const outputMode = input.outputMode ?? "error";
  const truncatedMarker = input.truncatedMarker ?? "";
  const envOptions = yield* resolveEnvOptions(input);
  const spawnCommand = yield* resolveSpawnCommand(input.command, input.args, envOptions);

  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...((input.spawnCwd ?? input.cwd) ? { cwd: input.spawnCwd ?? input.cwd } : {}),
        ...envOptions,
        shell: spawnCommand.shell,
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new ProcessSpawnError({
            command: input.command,
            argumentCount: input.args.length,
            cwd: input.cwd,
            spawnCwd: input.spawnCwd,
            resolvedCommand: spawnCommand.command,
            resolvedArgumentCount: spawnCommand.args.length,
            shell: spawnCommand.shell,
            cause,
          }),
      ),
    );

  const stdin = input.stdin;
  const writeStdin =
    stdin === undefined
      ? Effect.void
      : Stream.run(Stream.encodeText(Stream.make(stdin)), child.stdin).pipe(
          Effect.mapError(
            (cause) =>
              new ProcessStdinError({
                command: input.command,
                argumentCount: input.args.length,
                cwd: input.cwd,
                spawnCwd: input.spawnCwd,
                stdinBytes: Buffer.byteLength(stdin),
                cause,
              }),
          ),
        );

  const [stdout, stderr] = yield* Effect.all(
    [
      collectText({
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        spawnCwd: input.spawnCwd,
        streamName: "stdout",
        stream: child.stdout,
        maxOutputBytes,
        outputMode,
        truncatedMarker,
        onLine: input.onStdoutLine,
      }),
      collectText({
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        spawnCwd: input.spawnCwd,
        streamName: "stderr",
        stream: child.stderr,
        maxOutputBytes,
        outputMode,
        truncatedMarker,
        onLine: input.onStderrLine,
      }),
      writeStdin,
    ],
    { concurrency: "unbounded" },
  );

  const exitCode = yield* child.exitCode.pipe(
    Effect.mapError(
      (cause) =>
        new ProcessReadError({
          command: input.command,
          argumentCount: input.args.length,
          cwd: input.cwd,
          spawnCwd: input.spawnCwd,
          stream: "exitCode",
          cause,
        }),
    ),
  );

  return {
    stdout: stdout.text,
    stderr: stderr.text,
    code: exitCode,
    timedOut: false,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    stdoutInvalidUtf8: stdout.invalidUtf8,
    stderrInvalidUtf8: stderr.invalidUtf8,
  } satisfies ProcessRunOutput;
});

export const make = Effect.fn("ProcessRunner.make")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const run: ProcessRunner["Service"]["run"] = (input) =>
    finalizeRunProcess(runProcessCore(spawner, input), input);

  return ProcessRunner.of({
    run,
  });
});

export const layer = Layer.effect(ProcessRunner, make());

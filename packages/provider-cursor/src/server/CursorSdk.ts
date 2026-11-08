// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- The SDK must load from disk beside its Webpack chunks. The guard runs in Node's unhandled-rejection callback, outside an Effect runtime. stderr must match Node's default unhandled-rejection print.
import * as NodeModule from "node:module";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export type CursorSdkModule = typeof import("@cursor/sdk") & typeof import("@cursor/sdk/sqlite");

export const CURSOR_SDK_NOT_INSTALLED_MESSAGE =
  "Cursor SDK (`@cursor/sdk`) is not installed with this Lecturn server.";

export class CursorSdkNotInstalledError extends Schema.TaggedError<CursorSdkNotInstalledError>()(
  "CursorSdkNotInstalledError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return CURSOR_SDK_NOT_INSTALLED_MESSAGE;
  }
}

export const isCursorSdkNotInstalledError = Schema.is(CursorSdkNotInstalledError);

/** A missing dependency inside an installed SDK is a broken install, not an omitted one. */
function isCursorSdkMissing(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    Reflect.get(cause, "code") === "MODULE_NOT_FOUND" &&
    cause.message.startsWith("Cannot find module '@cursor/sdk'")
  );
}

function makeLoad(
  require: (id: string) => unknown,
): Effect.Effect<CursorSdkModule, CursorSdkNotInstalledError> {
  let sdk: CursorSdkModule | undefined;
  return Effect.suspend(() => {
    try {
      sdk ??= {
        ...(require("@cursor/sdk") as typeof import("@cursor/sdk")),
        ...(require("@cursor/sdk/sqlite") as typeof import("@cursor/sdk/sqlite")),
      };
      return Effect.succeed(sdk);
    } catch (cause) {
      return isCursorSdkMissing(cause)
        ? Effect.fail(new CursorSdkNotInstalledError({ cause }))
        : Effect.die(cause);
    }
  });
}

// The SDK leaves a shell-error promise unhandled, which would exit the server.
const CURSOR_SHELL_SPAWN_MARKERS = [
  "dump_zsh_state",
  "dump_bash_state",
  "__CURSOR_SANDBOX_ENV_RESTORE",
] as const;

function isCursorShellSpawnFailure(reason: unknown): boolean {
  if (typeof reason !== "object" || reason === null) {
    return false;
  }
  const syscall = Reflect.get(reason, "syscall");
  const code = Reflect.get(reason, "code");
  const spawnargs = Reflect.get(reason, "spawnargs");
  if (typeof syscall !== "string" || !syscall.startsWith("spawn") || typeof code !== "string") {
    return false;
  }
  if (!Array.isArray(spawnargs)) {
    return false;
  }
  return spawnargs.some(
    (arg) =>
      typeof arg === "string" && CURSOR_SHELL_SPAWN_MARKERS.some((marker) => arg.includes(marker)),
  );
}

/**
 * After a local exec fails, the SDK writes a final frame to the exec's stream from
 * a promise nothing awaits. If that stream has already closed, the write rejects.
 * The SDK's class is minified, so only its `name` identifies it.
 */
function isCursorClosedStreamWrite(reason: unknown): boolean {
  return reason instanceof Error && reason.name === "WriteIterableClosedError";
}

function onUnhandledRejection(reason: unknown): void {
  if (isCursorShellSpawnFailure(reason)) {
    console.error("Cursor shell spawn failed. The server will keep running.", reason);
    return;
  }
  if (isCursorClosedStreamWrite(reason)) {
    console.error("Cursor SDK wrote to a closed exec stream. The server will keep running.");
    return;
  }
  if (process.listenerCount("unhandledRejection") > 1) {
    return;
  }
  console.error(reason);
  process.exit(1);
}

/**
 * The proprietary SDK may be left out of apps that bundle this server, so it loads on first use.
 * Keeps the shell spawn guard armed while in-process agents run.
 */
export class CursorSdk extends Context.Service<
  CursorSdk,
  {
    readonly load: Effect.Effect<CursorSdkModule, CursorSdkNotInstalledError>;
  }
>()("@lecturn/provider-cursor/server/CursorSdk") {}

/** Provide once per process: a second guard would defer to the first and swallow real rejections. */
export const layerFromRequire = (require: (id: string) => unknown) =>
  Layer.effect(
    CursorSdk,
    Effect.acquireRelease(
      Effect.sync(() => {
        process.on("unhandledRejection", onUnhandledRejection);
      }),
      () =>
        Effect.sync(() => {
          process.off("unhandledRejection", onUnhandledRejection);
        }),
    ).pipe(Effect.as(CursorSdk.of({ load: makeLoad(require) }))),
  );

// createRequire loads the disk-backed SDK and adjacent chunks even from a Node SEA executable.
export const layer = layerFromRequire(NodeModule.createRequire(import.meta.url));

// @effect-diagnostics nodeBuiltinImport:off -- the parent pipe is a raw inherited descriptor.
/**
 * The connected-app sidecar (D9): an app starts its own Lecturn server and
 * hands it an `app-sidecar` envelope on `--bootstrap-fd`. The server stays in
 * web mode, grants the app without a prompt, and seeds an in-memory grant
 * that the helper exchanges at `/api/auth/token` for its `app:<appId>`
 * session.
 */
import {
  type AppSidecarBootstrap,
  AuthAppHostScope,
  type DesktopBackendBootstrap,
  type ServerBootstrapEnvelope,
} from "@lecturn/contracts";
import * as NodeNet from "node:net";
import type * as NodeStream from "node:stream";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as ServerConfig from "../config.ts";
import { isProcessAlive } from "../serverRuntimeState.ts";
import { formatAppSubject } from "./subjects.ts";

/** Desktop fields keep driving config resolution; the sidecar envelope travels on to the registry. */
export const splitServerBootstrap = (
  envelope: Option.Option<ServerBootstrapEnvelope>,
): {
  readonly desktop: DesktopBackendBootstrap | undefined;
  readonly appSidecar: AppSidecarBootstrap | undefined;
} => {
  const value = Option.getOrUndefined(envelope);
  return value?.mode === "app-sidecar"
    ? { desktop: undefined, appSidecar: value }
    : { desktop: value, appSidecar: undefined };
};

// In memory, so it dies with the sidecar; until then it lasts as long as the
// session it is exchanged for.
const SEED_TTL_DAYS = 30;

/**
 * Seeded like the desktop's bootstrap token. `desktop-bootstrap` because it is
 * not a pairing code (it cannot approve MCP clients) and a re-exchange
 * replaces the helper's previous session instead of piling them up.
 */
export const appSidecarSeedGrants = (
  config: Pick<ServerConfig.ServerConfig["Service"], "appSidecar">,
) =>
  Effect.gen(function* () {
    const sidecar = config.appSidecar;
    if (sidecar === undefined) return [];
    const now = yield* DateTime.now;
    return [
      [
        sidecar.appSeedToken,
        {
          method: "desktop-bootstrap" as const,
          scopes: [AuthAppHostScope],
          subject: formatAppSubject(sidecar.registration.appId),
          label: sidecar.registration.name,
          expiresAt: DateTime.add(now, { days: SEED_TTL_DAYS }),
          remainingUses: "unbounded" as const,
        },
      ] as const,
    ];
  });

export class AppSidecarParentExitedError extends Schema.TaggedError<AppSidecarParentExitedError>()(
  "AppSidecarParentExitedError",
  {},
) {
  override get message(): string {
    return "The app that started this Lecturn sidecar exited.";
  }
}

export class AppSidecarParentPipeError extends Schema.TaggedError<AppSidecarParentPipeError>()(
  "AppSidecarParentPipeError",
  { fd: Schema.Number, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not watch the app sidecar parent pipe on file descriptor ${this.fd}.`;
  }
}

/** How the sidecar sees its parent; tests stand in for the process and the pipe. */
export interface AppSidecarParentProbe {
  /** Re-read on every poll: a parent that dies re-parents the sidecar, which changes it. */
  readonly parentPid: () => number;
  readonly isAlive: (pid: number) => boolean;
  readonly openPipe: (fd: number) => NodeStream.Readable;
}

const defaultParentProbe: AppSidecarParentProbe = {
  parentPid: () => process.ppid,
  isAlive: isProcessAlive,
  // A socket, not `fs.createReadStream`: a blocking read would hold a libuv
  // pool thread for the server's whole life.
  openPipe: (fd) => new NodeNet.Socket({ fd, readable: true, writable: false }),
};

export interface AppSidecarParentWatchOptions {
  readonly probe?: Partial<AppSidecarParentProbe>;
  readonly pollInterval?: Duration.Input;
}

const awaitPipeEnd = (fd: number, probe: AppSidecarParentProbe) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => probe.openPipe(fd),
      catch: (cause) => new AppSidecarParentPipeError({ fd, cause }),
    }),
    (stream) => Effect.sync(() => stream.destroy()),
  ).pipe(
    Effect.matchEffect({
      // The poll still notices the parent going; only the prompt signal is lost.
      onFailure: (error) =>
        Effect.logWarning(error.message, { cause: String(error.cause) }).pipe(
          Effect.andThen(Effect.never),
        ),
      onSuccess: (stream) =>
        Effect.callback<void>((resume) => {
          const gone = () => resume(Effect.void);
          stream.once("end", gone);
          stream.once("close", gone);
          stream.once("error", gone);
          // Nothing is ever written; flowing mode is what surfaces the end-of-file.
          stream.resume();
        }),
    }),
    Effect.scoped,
  );

/**
 * Completes once the app that started this sidecar is gone. The pipe reports
 * it at once, even when the app died before the server got here; the parent
 * poll covers an app that passed no pipe, and Windows, which never re-parents.
 */
export const awaitAppSidecarParentExit = (
  sidecar: AppSidecarBootstrap,
  options: AppSidecarParentWatchOptions = {},
): Effect.Effect<void> => {
  const probe = { ...defaultParentProbe, ...options.probe };
  const pollInterval = options.pollInterval ?? Duration.seconds(1);
  const pipe =
    sidecar.parentPipeFd === undefined ? Effect.never : awaitPipeEnd(sidecar.parentPipeFd, probe);
  const poll = Effect.gen(function* () {
    const parent = probe.parentPid();
    while (true) {
      yield* Effect.sleep(pollInterval);
      if (probe.parentPid() !== parent || !probe.isAlive(parent)) return;
    }
  });
  return Effect.raceFirst(pipe, poll);
};

/**
 * A sidecar serves only the app that started it, so it ends with that app,
 * however the app ended. Failing rather than interrupting makes the CLI exit
 * once the server's finalizers have run.
 */
export const exitWithAppSidecarParent =
  (
    config: Pick<ServerConfig.ServerConfig["Service"], "appSidecar">,
    options?: AppSidecarParentWatchOptions,
  ) =>
  <A, E, R>(
    server: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | AppSidecarParentExitedError, R> => {
    const sidecar = config.appSidecar;
    if (sidecar === undefined) return server;
    return Effect.raceFirst(
      server,
      awaitAppSidecarParentExit(sidecar, options).pipe(
        Effect.andThen(Effect.fail(new AppSidecarParentExitedError())),
      ),
    );
  };

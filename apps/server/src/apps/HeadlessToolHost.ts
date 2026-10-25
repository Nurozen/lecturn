/**
 * Runs each granted app's headless tool command, one process per app project
 * (D5). A process starts on the first call or empty-cache listing and stays
 * up between calls; the idle reaper (headlessReaper.ts, run from the
 * onRunTerminal hook) closes it later. The process table is the shared
 * AppRuntimeState one, so that hook sees what this host runs.
 *
 * `inFlightCalls` counts every holder: calls, listings and `acquire` scopes.
 * The reaper only needs to know that someone is still using the process.
 */
import type { AppId, ProjectId } from "@lecturn/contracts";
import { AppsError } from "@lecturn/contracts";
import * as HostProcess from "@lecturn/shared/HostProcess";
import * as KeyedLock from "@lecturn/shared/KeyedLock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { McpSchema } from "effect/ai";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  AppRuntimeState,
  type HeadlessProcessEntry,
  type HeadlessProcessKey,
} from "./AppRuntimeState.ts";
import {
  connect,
  type HeadlessMcpConnection,
  listTools as listConnectionTools,
  resolveHeadlessSpec,
  runListCommand,
} from "./headlessMcpProcess.ts";
import {
  AppProjectService,
  AppRegistryService,
  type AppsFailure,
  HeadlessToolHost,
} from "./services.ts";

export const headlessProcessKey = (appId: AppId, projectId: ProjectId): HeadlessProcessKey =>
  `${appId} ${projectId}`;

interface Slot {
  readonly connection: HeadlessMcpConnection;
  readonly scope: Scope.Closeable;
}

const decodeCallResult = Schema.decodeUnknownEffect(McpSchema.CallToolResult);
const decodeReadResult = Schema.decodeUnknownEffect(McpSchema.ReadResourceResult);

const make = Effect.gen(function* () {
  const { headlessProcesses } = yield* AppRuntimeState;
  const registry = yield* AppRegistryService;
  const projects = yield* AppProjectService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const layerScope = yield* Effect.scope;
  const hostEnv = yield* HostProcess.Environment;
  const lock = yield* KeyedLock.make<HeadlessProcessKey>();
  const slots = new Map<HeadlessProcessKey, Slot>();

  const updateEntry = (
    key: HeadlessProcessKey,
    update: (entry: HeadlessProcessEntry) => HeadlessProcessEntry,
  ) =>
    Ref.update(headlessProcesses, (entries) => {
      const entry = entries.get(key);
      if (entry === undefined) return entries;
      const next = new Map(entries);
      next.set(key, update(entry));
      return next;
    });

  /** Drops the slot only if it is still the one the caller saw. */
  const forget = (key: HeadlessProcessKey, slot: Slot) =>
    Effect.gen(function* () {
      if (slots.get(key) !== slot) return false;
      slots.delete(key);
      yield* Ref.update(headlessProcesses, (entries) => {
        const next = new Map(entries);
        next.delete(key);
        return next;
      });
      return true;
    });

  const kill = (key: HeadlessProcessKey, slot: Slot) =>
    forget(key, slot).pipe(Effect.andThen(Scope.close(slot.scope, Exit.void)));

  /** Under the key lock, so a call that started meanwhile keeps its process. */
  const closeIfIdle = (key: HeadlessProcessKey, slot: Slot) =>
    lock
      .withLock(
        key,
        Effect.gen(function* () {
          const entry = (yield* Ref.get(headlessProcesses)).get(key);
          if (entry === undefined || entry.inFlightCalls > 0) return false;
          return yield* forget(key, slot);
        }),
      )
      .pipe(
        Effect.flatMap((closing) =>
          closing
            ? slot.connection.closeStdin.pipe(Effect.andThen(Scope.close(slot.scope, Exit.void)))
            : Effect.void,
        ),
      );

  const requireHeadless = (appId: AppId) =>
    Effect.gen(function* () {
      const record = yield* registry.get(appId);
      if (Option.isNone(record) || record.value.status.state !== "granted") {
        return yield* new AppsError({
          code: "forbidden",
          message: `${appId} is not a granted connected app.`,
        });
      }
      return {
        name: record.value.registration.name,
        headless: record.value.registration.headlessTools,
      };
    });

  const requireWorkspaceRoot = (projectId: ProjectId) =>
    projects.resolveAppForProject(projectId).pipe(
      Effect.flatMap((binding) =>
        Option.isSome(binding)
          ? Effect.succeed(binding.value.workspaceRoot)
          : Effect.fail(
              new AppsError({
                code: "not-found",
                message: `Project ${projectId} is not a connected-app project.`,
              }),
            ),
      ),
    );

  const specFor = (appId: AppId, projectId: ProjectId, mode: "call" | "list") =>
    Effect.gen(function* () {
      const { name, headless } = yield* requireHeadless(appId);
      if (headless === undefined) return Option.none();
      const args = mode === "call" ? headless.args : headless.listArgs;
      if (args === undefined) return Option.none();
      const workspaceRoot = yield* requireWorkspaceRoot(projectId);
      return Option.some({
        name,
        spec: resolveHeadlessSpec({ headless, workspaceRoot, hostEnv, args }),
      });
    });

  const spawn = (appId: AppId, projectId: ProjectId, key: HeadlessProcessKey) =>
    Effect.gen(function* () {
      const resolved = yield* specFor(appId, projectId, "call");
      if (Option.isNone(resolved)) {
        return yield* new AppsError({
          code: "not-found",
          message: `${appId} has no headless tools.`,
        });
      }
      const scope = yield* Scope.fork(layerScope);
      const connection = yield* connect(resolved.value.spec).pipe(
        Scope.provide(scope),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
      );
      const slot: Slot = { connection, scope };
      slots.set(key, slot);
      yield* Ref.update(headlessProcesses, (entries) =>
        new Map(entries).set(key, {
          appId,
          projectId,
          inFlightCalls: 0,
          lastCallEndedAt: null,
          close: closeIfIdle(key, slot),
          kill: kill(key, slot),
        }),
      );
      // A process that exits on its own is replaced on the next call.
      yield* connection.exited.pipe(
        Effect.andThen(forget(key, slot)),
        Effect.andThen(Scope.close(scope, Exit.void)),
        Effect.forkIn(layerScope),
      );
      return slot;
    });

  const hold = (appId: AppId, projectId: ProjectId) => {
    const key = headlessProcessKey(appId, projectId);
    return lock.withLock(
      key,
      Effect.gen(function* () {
        const slot = slots.get(key) ?? (yield* spawn(appId, projectId, key));
        yield* updateEntry(key, (entry) => ({ ...entry, inFlightCalls: entry.inFlightCalls + 1 }));
        return slot;
      }),
    );
  };

  const release = (appId: AppId, projectId: ProjectId) =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        updateEntry(headlessProcessKey(appId, projectId), (entry) => ({
          ...entry,
          inFlightCalls: Math.max(0, entry.inFlightCalls - 1),
          lastCallEndedAt: now,
        })),
      ),
    );

  const withProcess = <A, E>(
    appId: AppId,
    projectId: ProjectId,
    use: (connection: HeadlessMcpConnection) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | AppsFailure> =>
    Effect.acquireUseRelease(
      hold(appId, projectId),
      (slot) => use(slot.connection),
      () => release(appId, projectId),
    );

  const listFromProcess = (appId: AppId, projectId: ProjectId) =>
    withProcess(appId, projectId, listConnectionTools);

  const listFromCommand = (appId: AppId, projectId: ProjectId) =>
    specFor(appId, projectId, "list").pipe(
      Effect.flatMap((resolved) =>
        Option.isNone(resolved)
          ? Effect.succeedNone
          : runListCommand(resolved.value.spec).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.asSome,
            ),
      ),
    );

  const cache = (appId: AppId, tools: ReadonlyArray<McpSchema.Tool>) =>
    registry.setCachedTools(appId, "headless", tools).pipe(Effect.as(tools));

  const stopApp = (appId: AppId) =>
    Ref.get(headlessProcesses).pipe(
      Effect.flatMap((entries) =>
        Effect.forEach(
          [...entries.values()].filter((entry) => entry.appId === appId),
          (entry) => entry.kill,
          { discard: true },
        ),
      ),
    );

  // Revoke and delete arrive as status changes; the registry sits below this
  // service and does not call it.
  yield* registry.streamStatus.pipe(
    Stream.runForEach((event) => {
      switch (event.type) {
        case "snapshot":
          return Effect.forEach(
            event.apps.filter((app) => app.state !== "granted"),
            (app) => stopApp(app.appId),
            { discard: true },
          );
        case "upsert":
          return event.app.state === "granted" ? Effect.void : stopApp(event.app.appId);
        case "remove":
          return stopApp(event.appId);
      }
    }),
    Effect.catchCause((cause) =>
      Effect.logWarning("Headless tool processes no longer follow app status", { cause }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );

  return HeadlessToolHost.of({
    acquire: (appId, projectId) =>
      Effect.acquireRelease(hold(appId, projectId), () => release(appId, projectId)).pipe(
        Effect.asVoid,
      ),
    listTools: listFromProcess,
    call: (appId, projectId, request) =>
      withProcess(appId, projectId, (connection) =>
        connection.request("tools/call", {
          name: request.name,
          arguments: request.arguments,
          _meta: request.meta,
        }),
      ).pipe(
        Effect.flatMap((result) =>
          decodeCallResult(result).pipe(
            Effect.mapError(
              () =>
                new AppsError({
                  code: "unavailable",
                  message: `The app answered ${request.name} with a result Lecturn cannot read.`,
                }),
            ),
          ),
        ),
      ),
    readResource: (appId, projectId, uri) =>
      withProcess(appId, projectId, (connection) =>
        connection.request("resources/read", { uri }),
      ).pipe(
        Effect.flatMap((result) =>
          decodeReadResult(result).pipe(
            Effect.mapError(
              () =>
                new AppsError({
                  code: "unavailable",
                  message: `The app answered ${uri} with a resource Lecturn cannot read.`,
                }),
            ),
          ),
        ),
      ),
    refreshDefinitions: (appId, projectId) =>
      Effect.gen(function* () {
        const listed = yield* listFromCommand(appId, projectId);
        if (Option.isSome(listed)) {
          yield* cache(appId, listed.value);
          return;
        }
        // Without listArgs only a process that is already up may be asked:
        // starting one could take a lock from a session the app runs itself.
        if (slots.has(headlessProcessKey(appId, projectId))) {
          yield* cache(appId, yield* listFromProcess(appId, projectId));
        }
      }),
    listForEmptyCache: (appId, projectId) =>
      Effect.gen(function* () {
        const { headless } = yield* requireHeadless(appId);
        if (headless === undefined) return [];
        const listed = yield* listFromCommand(appId, projectId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("App listing command failed; asking its tool server", {
              appId,
              cause,
            }).pipe(Effect.as(Option.none())),
          ),
        );
        if (Option.isSome(listed)) return yield* cache(appId, listed.value);
        return yield* cache(appId, yield* listFromProcess(appId, projectId));
      }),
    stopApp,
  });
});

export const layer = Layer.effect(HeadlessToolHost, make);

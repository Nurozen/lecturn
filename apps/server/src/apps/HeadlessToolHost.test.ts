// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@lecturn/shared/HostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as AppRuntimeState from "./AppRuntimeState.ts";
import { makeHeadlessReaper } from "./headlessReaper.ts";
import * as HeadlessToolHostLayer from "./HeadlessToolHost.ts";
import { HeadlessToolHost } from "./services.ts";
import {
  fixtureAppId as appId,
  fixtureProjectId as projectId,
  fixtureRegistration,
  makeFakeApps,
  makeWorkspace,
} from "./testing/headlessAppFixture.ts";

type Workspace = ReturnType<typeof makeWorkspace>;
type FakeApps = Effect.Success<ReturnType<typeof makeFakeApps>>;

/** Holds back every spawned process's output, its initialize answer first, until `gate` ends. */
const gatedSpawner = (gate: Effect.Effect<void>) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner;
      return ChildProcessSpawner.make((command) =>
        real.spawn(command).pipe(
          Effect.map((handle) =>
            ChildProcessSpawner.makeHandle({
              ...handle,
              stdout: Stream.unwrap(gate.pipe(Effect.as(handle.stdout))),
            }),
          ),
        ),
      );
    }),
  );

/** Builds a real host over the fixture app; the reaper sees no active run. */
const withHost = <A, E>(
  options: { readonly listArgs: boolean; readonly beforeOutput?: Effect.Effect<void> },
  body: (context: {
    readonly host: HeadlessToolHost["Service"];
    readonly workspace: Workspace;
    readonly fake: FakeApps;
    readonly processes: Effect.Effect<number>;
    readonly reaper: Effect.Success<ReturnType<typeof makeHeadlessReaper>>;
  }) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const workspace = makeWorkspace();
      yield* Effect.addFinalizer(() => Effect.sync(workspace.remove));
      const fake = yield* makeFakeApps({
        registration: fixtureRegistration(workspace.logPath, options),
        workspaceRoot: workspace.workspaceRoot,
      });
      const context = yield* Layer.build(
        HeadlessToolHostLayer.layer.pipe(
          Layer.provideMerge(AppRuntimeState.layer),
          Layer.provide(fake.layer),
          Layer.provide(gatedSpawner(options.beforeOutput ?? Effect.void)),
          Layer.provide(NodeServices.layer),
          // The desktop app's flag must not reach the app's command.
          Layer.provide(
            Layer.succeed(HostProcess.Environment, { ...process.env, ELECTRON_RUN_AS_NODE: "1" }),
          ),
        ),
      );
      const host = Context.get(context, HeadlessToolHost);
      const { headlessProcesses } = Context.get(context, AppRuntimeState.AppRuntimeState);
      const reaper = yield* makeHeadlessReaper(() => Effect.succeed(false)).pipe(
        Effect.provide(context),
      );
      return yield* body({
        host,
        workspace,
        fake,
        processes: Ref.get(headlessProcesses).pipe(Effect.map((entries) => entries.size)),
        reaper,
      });
    }),
  );

const call = (
  host: HeadlessToolHost["Service"],
  name: string,
  args: Record<string, unknown> = {},
) => host.call(appId, projectId, { name, arguments: args, meta: {} });

const starts = (workspace: Workspace, mode: "list" | "serve") =>
  workspace.events().filter((event) => event.event === "start" && event.mode === mode);

it.effect("starts the app's command once per app project and reuses it", () =>
  withHost({ listArgs: false }, ({ host, workspace, processes }) =>
    Effect.gen(function* () {
      const first = yield* call(host, "echo_meta");
      const second = yield* call(host, "echo_meta");
      expect(first.structuredContent).toEqual(second.structuredContent);

      const [start, ...others] = starts(workspace, "serve");
      expect(others).toEqual([]);
      // The fixture only answers initialize at 2025-11-25.
      expect(start).toMatchObject({
        cwd: workspace.workspaceRoot,
        argv: ["--project", workspace.workspaceRoot],
        pinned: workspace.workspaceRoot,
        electronRunAsNode: null,
      });
      expect(yield* processes).toBe(1);
    }),
  ),
);

it.effect("reads a card document on the call-path process it shares with calls", () =>
  withHost({ listArgs: false }, ({ host, workspace, processes }) =>
    Effect.gen(function* () {
      yield* call(host, "echo_meta");
      const read = yield* host.readResource(appId, projectId, "ui://ex/counter-card");
      expect(read.contents[0]).toMatchObject({
        uri: "ui://ex/counter-card",
        mimeType: "text/html;profile=mcp-app",
      });
      const missing = yield* host
        .readResource(appId, projectId, "ui://ex/missing")
        .pipe(Effect.flip);
      expect(missing.message).toContain("resource not found");
      expect(starts(workspace, "serve")).toHaveLength(1);
      expect(yield* processes).toBe(1);
    }),
  ),
);

it.effect("closes stdin of an idle process after the idle timeout and lets it exit", () =>
  withHost({ listArgs: false }, ({ host, workspace, processes, reaper }) =>
    Effect.gen(function* () {
      yield* call(host, "echo_meta");
      yield* reaper.onProjectRunEnded(projectId);

      yield* TestClock.adjust("59 seconds");
      expect(yield* processes).toBe(1);

      yield* TestClock.adjust("1 second");
      yield* reaper.awaitIdle;
      expect(yield* processes).toBe(0);
      const ends = workspace
        .events()
        .filter((event) => event.event !== "start" && event.event !== "call");
      expect(ends.map((event) => event.event)).toEqual(["stdin-closed", "exit"]);

      // The next call starts a fresh process.
      yield* call(host, "echo_meta");
      expect(starts(workspace, "serve")).toHaveLength(2);
    }),
  ),
);

it.effect("never closes a process that is still finishing a call", () =>
  withHost({ listArgs: false }, ({ host, workspace, processes, reaper }) =>
    Effect.gen(function* () {
      yield* call(host, "echo_meta");
      const release = NodePath.join(workspace.workspaceRoot, "release");
      const holding = yield* Effect.forkChild(call(host, "hold", { release }), {
        startImmediately: true,
      });
      yield* reaper.onProjectRunEnded(projectId);

      yield* TestClock.adjust("2 minutes");
      expect(yield* processes).toBe(1);
      expect(workspace.events().some((event) => event.event === "stdin-closed")).toBe(false);

      NodeFS.writeFileSync(release, "");
      yield* Fiber.join(holding);
      yield* TestClock.adjust("1 minute");
      yield* reaper.awaitIdle;
      expect(yield* processes).toBe(0);
      expect(workspace.events().find((event) => event.event === "stdin-closed")).toMatchObject({
        inFlight: 0,
      });
      expect(workspace.events().some((event) => event.event === "sigterm")).toBe(false);
    }),
  ),
);

it.effect("stops an app's processes at once when it is revoked", () =>
  withHost({ listArgs: false }, ({ host, workspace, processes, fake }) =>
    Effect.gen(function* () {
      yield* call(host, "echo_meta");
      yield* fake.publishStatus("revoked");
      expect(yield* processes).toBe(0);
      expect(workspace.events().map((event) => event.event)).toContain("sigterm");
      expect(yield* call(host, "echo_meta").pipe(Effect.flip)).toMatchObject({
        code: "forbidden",
      });
    }),
  ),
);

it.effect("fails a call still waiting on a process its revoke stopped", () =>
  withHost({ listArgs: false }, ({ host, workspace, fake }) =>
    Effect.gen(function* () {
      yield* call(host, "echo_meta");
      const release = NodePath.join(workspace.workspaceRoot, "release");
      const holding = yield* Effect.forkChild(call(host, "hold", { release }), {
        startImmediately: true,
      });
      yield* fake.publishStatus("revoked");
      expect(yield* Fiber.join(holding).pipe(Effect.flip)).toMatchObject({ code: "unavailable" });
    }),
  ),
);

it.effect("stops a process revoked while it starts and never sends it the call", () =>
  Effect.gen(function* () {
    const spawned = yield* Deferred.make<void>();
    const answer = yield* Deferred.make<void>();
    const beforeOutput = Deferred.succeed(spawned, undefined).pipe(
      Effect.andThen(Deferred.await(answer)),
    );
    yield* withHost({ listArgs: false, beforeOutput }, ({ host, workspace, processes, fake }) =>
      Effect.gen(function* () {
        const calling = yield* Effect.forkChild(call(host, "echo_meta"), {
          startImmediately: true,
        });
        yield* Deferred.await(spawned);
        yield* fake.publishStatus("revoked");
        yield* Deferred.succeed(answer, undefined);

        expect(yield* Fiber.join(calling).pipe(Effect.flip)).toMatchObject({ code: "forbidden" });
        expect(yield* processes).toBe(0);
        const events = workspace.events().map((event) => event.event);
        expect(events).not.toContain("call");
        expect(events).toContain("sigterm");
      }),
    );
  }),
);

it.effect("reaps a process a card started after the last run's process was reaped", () =>
  withHost({ listArgs: false }, ({ host, workspace, processes, reaper }) =>
    Effect.gen(function* () {
      yield* call(host, "echo_meta");
      yield* reaper.onProjectRunEnded(projectId);
      yield* TestClock.adjust("1 minute");
      yield* reaper.awaitIdle;
      expect(yield* processes).toBe(0);

      // A saved card in a stopped thread: no run will end to arm the reaper.
      yield* host.readResource(appId, projectId, "ui://ex/counter-card");
      expect(starts(workspace, "serve")).toHaveLength(2);
      yield* TestClock.adjust("59 seconds");
      expect(yield* processes).toBe(1);

      yield* TestClock.adjust("1 second");
      yield* reaper.awaitIdle;
      expect(yield* processes).toBe(0);
    }),
  ),
);

it.effect("refreshes definitions with listArgs, never with the call-path command", () =>
  withHost({ listArgs: true }, ({ host, workspace, processes, fake }) =>
    Effect.gen(function* () {
      yield* host.refreshDefinitions(appId, projectId);

      expect(fake.cacheWrites).toEqual([
        {
          tier: "headless",
          names: ["increment", "refresh_card", "echo_meta", "gated_job", "hold"],
        },
      ]);
      expect(starts(workspace, "list")).toHaveLength(1);
      expect(workspace.events().filter((event) => event.event === "exit")).toHaveLength(1);
      expect(starts(workspace, "serve")).toEqual([]);
      expect(yield* processes).toBe(0);
    }),
  ),
);

it.effect("spawns nothing on grant or refresh without listArgs", () =>
  withHost({ listArgs: false }, ({ host, workspace, processes, fake }) =>
    Effect.gen(function* () {
      yield* fake.publishStatus("granted");
      yield* host.refreshDefinitions(appId, projectId);

      expect(workspace.events()).toEqual([]);
      expect(fake.cacheWrites).toEqual([]);
      expect(yield* processes).toBe(0);
    }),
  ),
);

it.effect("fills an empty cache from listArgs when declared, else from the call-path process", () =>
  Effect.gen(function* () {
    yield* withHost({ listArgs: true }, ({ host, workspace, processes }) =>
      Effect.gen(function* () {
        const tools = yield* host.listForEmptyCache(appId, projectId);
        expect(tools.map((tool) => tool.name)).toContain("increment");
        expect(starts(workspace, "serve")).toEqual([]);
        expect(yield* processes).toBe(0);
      }),
    );
    yield* withHost({ listArgs: false }, ({ host, workspace, processes, fake }) =>
      Effect.gen(function* () {
        const tools = yield* host.listForEmptyCache(appId, projectId);
        expect(tools.map((tool) => tool.name)).toContain("increment");
        expect(fake.cacheWrites.map((write) => write.tier)).toEqual(["headless"]);
        // The listing process is the call process: it stays up and serves calls.
        expect(yield* processes).toBe(1);
        yield* call(host, "echo_meta");
        expect(starts(workspace, "serve")).toHaveLength(1);
      }),
    );
  }),
);

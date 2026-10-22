import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ResourceMonitorCommand,
  ResourceMonitorEvent,
  type ResourceMonitorProcessTableCommand,
} from "@lecturn/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import * as Client from "./NativeTelemetryClient.ts";
import { ResourceMonitorBinary } from "./ResourceMonitorBinary.ts";

const decodeCommand = Schema.decodeUnknownSync(Schema.fromJsonString(ResourceMonitorCommand));
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(ResourceMonitorEvent));
const capabilities = {
  cumulativeCpuTime: true,
  currentCpuPercent: true,
  residentMemory: true,
  virtualMemory: true,
  ioBytes: true,
  processStartTime: true,
  processTree: true,
};
const makeFixture = Effect.fn("test.nativeTelemetryTransport")(function* () {
  const commands = yield* Queue.unbounded<ResourceMonitorProcessTableCommand>();
  const spawned = yield* Queue.unbounded<{
    readonly output: Queue.Queue<Uint8Array>;
    readonly exit: Deferred.Deferred<ChildProcessSpawner.ExitCode>;
  }>();
  let rejectWrites = false;
  const spawner = ChildProcessSpawner.make(
    Effect.fn("test.spawnMonitor")(function* () {
      const output = yield* Queue.unbounded<Uint8Array>();
      const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const terminate = Deferred.succeed(exit, ChildProcessSpawner.ExitCode(0)).pipe(Effect.asVoid);
      yield* Queue.offer(
        output,
        new TextEncoder().encode(
          encodeEvent({
            version: 3,
            type: "hello",
            sidecarVersion: "fixture",
            sidecarPid: 123,
            platform: "fixture",
            arch: "fixture",
            capabilities,
          }) + "\n",
        ),
      );
      yield* Queue.offer(spawned, { output, exit });
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(123),
        exitCode: Deferred.await(exit),
        isRunning: Deferred.isDone(exit).pipe(Effect.map((done) => !done)),
        kill: () => terminate,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((bytes: Uint8Array) =>
          Effect.gen(function* () {
            const command = decodeCommand(new TextDecoder().decode(bytes));
            if (command.type === "processTable") {
              if (rejectWrites)
                return yield* PlatformError.systemError({
                  module: "ChildProcessSpawner",
                  method: "write",
                  _tag: "Unknown",
                  cause: "fixture write failure",
                });
              yield* Queue.offer(commands, command);
            }
          }),
        ),
        stdout: Stream.fromQueue(output),
        stderr: Stream.never,
        all: Stream.fromQueue(output),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const client = yield* Client.make().pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(ResourceMonitorBinary, { resolve: Effect.succeed("fixture-monitor") }),
    Effect.provide(ServerConfig.layerTest("/fixture", { prefix: "lecturn-monitor-transport-" })),
  );
  const child = yield* Queue.take(spawned);
  const ready = Effect.fn("test.awaitMonitorReady")(function* () {
    const health = yield* client.subscribeHealth;
    if (health.latest.status !== "healthy") {
      yield* health.changes.pipe(
        Stream.filter((value) => value.status === "healthy"),
        Stream.take(1),
        Stream.runDrain,
      );
    }
  });
  yield* ready();
  return {
    client,
    commands,
    spawned,
    child,
    ready,
    rejectWrites: () => {
      rejectWrites = true;
    },
  };
});
const respond = Effect.fn("test.processTableResponse")(function* (
  output: Queue.Queue<Uint8Array>,
  requestId: string,
  pid: number,
) {
  yield* Queue.offer(
    output,
    new TextEncoder().encode(
      encodeEvent({
        version: 3,
        type: "processTable",
        requestId,
        processes: [{ pid, ppid: 1, name: `process-${pid}` }],
      }) + "\n",
    ),
  );
});

it.layer(NodeServices.layer)("native process-table transport", (it) => {
  it.effect("correlates concurrent requests and ignores unknown and interrupted responses", () =>
    Effect.gen(function* () {
      const { client, commands, child } = yield* makeFixture();
      const first = yield* client.processTable.pipe(Effect.forkChild);
      const a = yield* Queue.take(commands);
      const second = yield* client.processTable.pipe(Effect.forkChild);
      const b = yield* Queue.take(commands);
      expect(a.requestId).not.toBe(b.requestId);
      yield* respond(child.output, "unknown", 999);
      yield* respond(child.output, b.requestId, 222);
      expect(yield* Fiber.join(second)).toEqual([{ pid: 222, ppid: 1, name: "process-222" }]);
      yield* respond(child.output, a.requestId, 111);
      expect(yield* Fiber.join(first)).toEqual([{ pid: 111, ppid: 1, name: "process-111" }]);
      const cancelled = yield* client.processTable.pipe(Effect.forkChild);
      const c = yield* Queue.take(commands);
      yield* Fiber.interrupt(cancelled);
      yield* respond(child.output, c.requestId, 333);
      const next = yield* client.processTable.pipe(Effect.forkChild);
      const d = yield* Queue.take(commands);
      yield* respond(child.output, d.requestId, 444);
      expect(yield* Fiber.join(next)).toEqual([{ pid: 444, ppid: 1, name: "process-444" }]);
    }),
  );
  it.effect("times out an unanswered request and permits a later request", () =>
    Effect.gen(function* () {
      const { client, commands, child } = yield* makeFixture();
      const unanswered = yield* client.processTable.pipe(Effect.flip, Effect.forkChild);
      const old = yield* Queue.take(commands);
      yield* TestClock.adjust("5 seconds");
      expect(yield* Fiber.join(unanswered)).toMatchObject({
        _tag: "NativeTelemetryRequestTimedOut",
        operation: "processTable",
      });
      yield* respond(child.output, old.requestId, 111);
      const next = yield* client.processTable.pipe(Effect.forkChild);
      const command = yield* Queue.take(commands);
      yield* respond(child.output, command.requestId, 222);
      expect(yield* Fiber.join(next)).toEqual([{ pid: 222, ppid: 1, name: "process-222" }]);
    }),
  );
  it.effect("reports stdin write failures without waiting for the response timeout", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      fixture.rejectWrites();
      expect(yield* fixture.client.processTable.pipe(Effect.flip)).toMatchObject({
        _tag: "NativeTelemetryCommandFailed",
        operation: "processTable",
      });
    }),
  );
  it.effect("fails every pending request on exit and recovers against a fresh sidecar", () =>
    Effect.gen(function* () {
      const { client, commands, child, spawned, ready } = yield* makeFixture();
      const first = yield* client.processTable.pipe(Effect.flip, Effect.forkChild);
      yield* Queue.take(commands);
      const second = yield* client.processTable.pipe(Effect.flip, Effect.forkChild);
      yield* Queue.take(commands);
      yield* Deferred.succeed(child.exit, ChildProcessSpawner.ExitCode(9));
      expect(yield* Fiber.join(first)).toMatchObject({
        _tag: "NativeTelemetryExited",
        exitCode: 9,
      });
      expect(yield* Fiber.join(second)).toMatchObject({
        _tag: "NativeTelemetryExited",
        exitCode: 9,
      });
      yield* TestClock.adjust("500 millis");
      const restarted = yield* Queue.take(spawned);
      yield* ready();
      const next = yield* client.processTable.pipe(Effect.forkChild);
      const command = yield* Queue.take(commands);
      yield* respond(restarted.output, command.requestId, 555);
      expect(yield* Fiber.join(next)).toEqual([{ pid: 555, ppid: 1, name: "process-555" }]);
    }),
  );
});

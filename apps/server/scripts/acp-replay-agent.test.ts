import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

function runReplay(entries: ReadonlyArray<unknown>, input: string, interruptWrite = false) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "lecturn-acp-status-" });
    const statusPath = path.join(directory, "status.json");
    const observationsPath = path.join(directory, "observations.jsonl");
    const preloadPath = path.join(directory, "observe.mjs");
    yield* fs.writeFileString(
      preloadPath,
      `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const statusPath = process.env.LECTURN_ACP_REPLAY_STATUS_PATH;
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...args) => {
  fs.appendFileSync(process.env.REPLAY_OBSERVATIONS_PATH, JSON.stringify({
    frame: JSON.parse(chunk),
    status: JSON.parse(fs.readFileSync(statusPath, "utf8")),
  }) + "\\n");
  return write(chunk, ...args);
};
if (process.env.REPLAY_INTERRUPT_WRITE === "true") {
  const writeFile = fs.writeFileSync;
  fs.writeFileSync = (path, data, ...args) => {
    if (JSON.parse(data).cursor > 0) {
      fs.closeSync(fs.openSync(path, "w"));
      process.exit(77);
    }
    return writeFile(path, data, ...args);
  };
  syncBuiltinESMExports();
}
`,
    );
    const child = yield* spawner.spawn(
      ChildProcess.make(
        process.execPath,
        [
          "--experimental-strip-types",
          "--import",
          preloadPath,
          yield* path.fromFileUrl(new URL("./acp-replay-agent.ts", import.meta.url)),
        ],
        {
          stdin: Stream.make(new TextEncoder().encode(input)),
          env: {
            LECTURN_ACP_REPLAY_TRANSCRIPT: Buffer.from(
              JSON.stringify({ scenario: "checkpoint", entries }),
            ).toString("base64"),
            LECTURN_ACP_REPLAY_STATUS_PATH: statusPath,
            REPLAY_OBSERVATIONS_PATH: observationsPath,
            REPLAY_INTERRUPT_WRITE: String(interruptWrite),
          },
        },
      ),
    );
    const { exitCode, stderr } = yield* Effect.all(
      {
        exitCode: child.exitCode,
        stderr: child.stderr.pipe(Stream.decodeText(), Stream.runCollect),
        stdout: child.stdout.pipe(Stream.runDrain),
      },
      { concurrency: "unbounded" },
    );
    const observations = (yield* fs.exists(observationsPath))
      ? (yield* fs.readFileString(observationsPath))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
    return {
      exitCode: Number(exitCode),
      stderr: stderr.join(""),
      status: JSON.parse(yield* fs.readFileString(statusPath)),
      observations,
    };
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
}

describe("ACP replay checkpoints", () => {
  it.effect("commits each inbound frame before the parent can receive it", () =>
    Effect.gen(function* () {
      const result = yield* runReplay(
        [
          {
            type: "emit_inbound",
            frame: { kind: "notification", method: "session/update", params: {} },
          },
          {
            type: "emit_inbound",
            frame: { kind: "request", method: "fs/read_text_file", params: {} },
          },
          {
            type: "expect_outbound",
            frame: { kind: "response", method: "fs/read_text_file", result: { content: "ok" } },
          },
          {
            type: "expect_outbound",
            frame: { kind: "request", method: "initialize", params: {} },
          },
          {
            type: "emit_inbound",
            frame: { kind: "response", method: "initialize", result: { protocolVersion: 1 } },
          },
        ],
        '{"jsonrpc":"2.0","id":1,"result":{"content":"ok"}}\n' +
          '{"jsonrpc":"2.0","id":42,"method":"initialize","params":{}}\n',
      );
      assert.equal(result.exitCode, 0, result.stderr);
      assert.deepEqual(
        result.observations.map((observation) => observation.status),
        [1, 2, 5].map((cursor) => ({ scenario: "checkpoint", cursor, total: 5 })),
      );
      assert.deepEqual(result.observations.at(-1)?.frame, {
        jsonrpc: "2.0",
        id: 42,
        result: { protocolVersion: 1 },
      });
    }),
  );

  it.effect("preserves the previous checkpoint when interrupted during the next write", () =>
    Effect.gen(function* () {
      const result = yield* runReplay(
        [
          {
            type: "expect_outbound",
            frame: { kind: "request", method: "initialize", params: {} },
          },
        ],
        '{"jsonrpc":"2.0","id":42,"method":"initialize","params":{}}\n',
        true,
      );
      assert.equal(result.exitCode, 77, result.stderr);
      assert.deepEqual(result.status, { scenario: "checkpoint", cursor: 0, total: 1 });
    }),
  );

  it.effect("records a mismatch before returning the error response", () =>
    Effect.gen(function* () {
      const result = yield* runReplay(
        [
          {
            type: "expect_outbound",
            frame: { kind: "request", method: "initialize", params: {} },
          },
        ],
        '{"jsonrpc":"2.0","id":42,"method":"unexpected","params":{}}\n',
      );
      assert.equal(result.exitCode, 1, result.stderr);
      assert.equal(result.observations.length, 1);
      assert.deepEqual(result.observations[0].status, result.status);
      assert.equal(result.status.cursor, 0);
      assert.equal(result.status.failure.cursor, 0);
      assert.equal(result.status.failure.expected.frame.method, "initialize");
      assert.equal(result.status.failure.actual.method, "unexpected");
    }),
  );

  it.effect("keeps the failing cursor when an inbound response has no pending request", () =>
    Effect.gen(function* () {
      const result = yield* runReplay(
        [
          {
            type: "emit_inbound",
            frame: { kind: "response", method: "initialize", result: {} },
          },
        ],
        "",
      );
      assert.equal(result.exitCode, 1, result.stderr);
      assert.deepEqual(result.observations, []);
      assert.equal(result.status.cursor, 0);
      assert.equal(result.status.failure.cursor, 0);
      assert.equal(result.status.failure.detail, "No pending client request for initialize");
      assert.equal(result.status.failure.expected.frame.method, "initialize");
    }),
  );
});

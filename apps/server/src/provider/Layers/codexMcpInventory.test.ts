// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as ProcessRunner from "../../processRunner.ts";
import { hasCanonicalMarmotServer } from "./codexMcpInventory.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const output = (stdout: string): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});
const launch = {
  binaryPath: "/selected/codex",
  cwd: "/space/root",
  homePath: "/selected/codex-home",
  launchArgs:
    '-c profile="space" --profile work --enable example --listen off --analytics-default-enabled',
  environment: { PATH: "/selected/bin", KEEP: "present" },
  appServerArgs: ["-c", 'mcp_servers.t3-code.url="http://localhost/mcp"'],
};

it.effect("lists with the session's exact binary, args, home, cwd and explicit environment", () =>
  Effect.gen(function* () {
    const present = yield* hasCanonicalMarmotServer(launch, {
      run: (input) =>
        Effect.sync(() => {
          assert.deepEqual(input, {
            command: "/selected/codex",
            args: [
              "-c",
              "profile=space",
              "--profile",
              "work",
              "--enable",
              "example",
              "-c",
              'mcp_servers.t3-code.url="http://localhost/mcp"',
              "mcp",
              "list",
              "--json",
            ],
            cwd: "/space/root",
            env: { PATH: "/selected/bin", KEEP: "present", CODEX_HOME: "/selected/codex-home" },
            extendEnv: false,
            stdin: "",
            timeout: "10 seconds",
            timeoutBehavior: "timedOutResult",
            maxOutputBytes: 1024 * 1024,
          });
          return output(
            encodeJson([
              {
                name: "context-marmot",
                enabled: true,
                transport: {
                  type: "stdio",
                  command: "/old/marmot",
                  env: { SECRET: "not retained" },
                },
              },
            ]),
          );
        }),
    });
    assert.isTrue(present);
  }),
);

for (const [name, result, reason] of [
  [
    "unsupported CLI",
    { ...output("secret output"), code: ChildProcessSpawner.ExitCode(2) },
    "output",
  ],
  ["timeout", { ...output("secret output"), timedOut: true }, "timeout"],
  ["truncation", { ...output("[]"), stdoutTruncated: true }, "output"],
  ["invalid UTF8", { ...output("[]"), stdoutInvalidUtf8: true }, "output"],
  ["invalid JSON", output("secret output"), "invalid_response"],
  ["invalid inventory", output('[{"enabled":true}]'), "invalid_response"],
] as const) {
  it.effect(`fails closed for ${name} without exposing CLI output`, () =>
    Effect.gen(function* () {
      const error = yield* hasCanonicalMarmotServer(launch, {
        run: () => Effect.succeed(result),
      }).pipe(Effect.flip);
      assert.equal(error.reason, reason);
      assert.include(error.message, "mcp list --json");
      assert.notInclude(encodeJson(error), "secret output");
    }),
  );
}

it.effect("maps unreadable binary errors without retaining their cause", () =>
  Effect.gen(function* () {
    const error = yield* hasCanonicalMarmotServer(launch, {
      run: () =>
        Effect.fail(
          new ProcessRunner.ProcessSpawnError({
            command: "codex",
            argumentCount: 3,
            cause: "secret",
          }),
        ),
    }).pipe(Effect.flip);
    assert.equal(error.reason, "process");
    assert.notInclude(encodeJson(error), "secret");
  }),
);

it.effect("inherits the host environment only when the runtime does", () =>
  Effect.gen(function* () {
    const present = yield* hasCanonicalMarmotServer(
      { binaryPath: "codex", cwd: "/space" },
      {
        run: (input) =>
          Effect.sync(() => {
            assert.deepEqual(input.env, {});
            assert.isTrue(input.extendEnv);
            return output("[]");
          }),
      },
    );
    assert.isFalse(present);
  }),
);

it.layer(NodeServices.layer)("Codex MCP inventory fixture CLI", (it) => {
  it.effect("reads fixture inventory with explicit process environment and launch cwd", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) === "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const fixture = path.join(root, "inventory.cjs");
      const home = path.join(root, "codex-home");
      yield* fs.writeFileString(
        fixture,
        `#!${process.execPath}
const assert = require("node:assert/strict");
assert.deepEqual(process.argv.slice(2), ["mcp", "list", "--json"]);
assert.equal(process.cwd(), ${encodeJson(root)});
assert.equal(process.env.CODEX_HOME, ${encodeJson(home)});
assert.equal(process.env.ONLY_EXPLICIT, "yes");
assert.equal(process.env.PATH, undefined);
process.stdout.write(JSON.stringify([{name:"context-marmot",enabled:false,transport:{type:"streamable_http",url:"https://fixture.invalid/mcp"}}]));
`,
      );
      yield* fs.chmod(fixture, 0o755);
      const runner = yield* ProcessRunner.make();
      const present = yield* hasCanonicalMarmotServer(
        {
          binaryPath: fixture,
          cwd: root,
          homePath: home,
          environment: { ONLY_EXPLICIT: "yes" },
        },
        runner,
      );
      assert.isTrue(present);
    }),
  );
});

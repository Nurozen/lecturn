import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as McpProviderSession from "../mcp/McpProviderSession.ts";
import { codexThreadRuntimeParams } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { cursorMcpServers } from "../orchestration-v2/Adapters/CursorAdapterV2.ts";
import type * as ProcessRunner from "../processRunner.ts";
import { CodexSettings } from "@lecturn/contracts";
import type { StaveMemoryResolution } from "../stave/StaveMemoryWiring.ts";
import {
  codexStaveMemoryMcpServers,
  makeCodexStaveMemoryMcpResolver,
  staveMemoryAcpMcpServers,
  staveMemoryCursorMcpServers,
  staveMemoryOpenCodeMcpConfig,
} from "./StaveMemoryMcp.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const DEFAULT_CODEX_SETTINGS = Schema.decodeSync(CodexSettings)({});

const configured: StaveMemoryResolution = {
  state: "configured",
  config: {
    command: "/opt/context-marmot",
    args: ["serve", "--space", "/space"],
    env: { MARMOT_HOME: "/space/.marmot" },
  },
};

const runnerOutput = (stdout: string): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

describe("Stave memory MCP servers", () => {
  it("registers nothing unless the space has a configured memory entry", () => {
    for (const resolution of [
      { state: "absent" },
      { state: "unavailable", code: "missing_config" },
    ] as const) {
      assert.deepStrictEqual(staveMemoryAcpMcpServers(resolution), []);
      assert.isUndefined(staveMemoryCursorMcpServers(resolution));
    }
  });

  it("shapes the entry for ACP, Cursor and OpenCode", () => {
    assert.deepStrictEqual(staveMemoryAcpMcpServers(configured), [
      {
        name: "context-marmot",
        command: "/opt/context-marmot",
        args: ["serve", "--space", "/space"],
        env: [{ name: "MARMOT_HOME", value: "/space/.marmot" }],
      },
    ]);
    assert.deepStrictEqual(staveMemoryCursorMcpServers(configured), {
      "context-marmot": {
        type: "stdio",
        command: "/opt/context-marmot",
        args: ["serve", "--space", "/space"],
        env: { MARMOT_HOME: "/space/.marmot" },
      },
    });
    assert.deepStrictEqual(
      staveMemoryOpenCodeMcpConfig(configured.state === "configured" ? configured.config : never()),
      {
        type: "local",
        command: ["/opt/context-marmot", "serve", "--space", "/space"],
        environment: { MARMOT_HOME: "/space/.marmot" },
        enabled: true,
      },
    );
  });

  it("disables the canonical Codex entry and runs memory under a session-local name", () => {
    const config = configured.state === "configured" ? configured.config : never();
    assert.deepStrictEqual(
      codexStaveMemoryMcpServers({ config, canonicalExists: false, sessionServerName: "sm_abc" }),
      {
        "context-marmot": { enabled: false, command: "/opt/context-marmot" },
        sm_abc: {
          command: "/opt/context-marmot",
          args: ["serve", "--space", "/space"],
          env: { MARMOT_HOME: "/space/.marmot" },
        },
      },
    );
    // A user's canonical entry keeps its own transport; only `enabled` is overridden.
    assert.deepStrictEqual(
      codexStaveMemoryMcpServers({ config, canonicalExists: true, sessionServerName: "sm_abc" })[
        "context-marmot"
      ],
      { enabled: false },
    );
  });

  it.effect("asks Codex about its canonical entry with the session's launch settings", () =>
    Effect.gen(function* () {
      const runs: Array<ProcessRunner.ProcessRunInput> = [];
      const resolve = makeCodexStaveMemoryMcpResolver({
        resolve: () => Effect.succeed(configured),
        runner: {
          run: (input) =>
            Effect.sync(() => {
              runs.push(input);
              return runnerOutput(encodeJson([{ name: "context-marmot" }]));
            }),
        },
        randomUuid: Effect.succeed("12345678-9abc-def0-1234-56789abcdef0"),
      });
      const servers = yield* resolve({
        settings: {
          ...DEFAULT_CODEX_SETTINGS,
          binaryPath: "/selected/codex",
          homePath: "/selected/home",
        },
        environment: { PATH: "/bin" },
        cwd: "/space/root",
      });
      assert.strictEqual(runs[0]?.command, "/selected/codex");
      assert.deepStrictEqual(runs[0]?.args.slice(-3), ["mcp", "list", "--json"]);
      assert.strictEqual(runs[0]?.cwd, "/space/root");
      assert.deepStrictEqual(Object.keys(servers ?? {}).toSorted(), [
        "context-marmot",
        "sm_123456789abc",
      ]);
      assert.deepStrictEqual(servers?.["context-marmot"], { enabled: false });

      const absent = yield* makeCodexStaveMemoryMcpResolver({
        resolve: () => Effect.succeed({ state: "absent" }),
        runner: { run: () => Effect.die("an absent space never lists Codex MCP servers") },
        randomUuid: Effect.succeed("unused"),
      })({ settings: DEFAULT_CODEX_SETTINGS, environment: {}, cwd: "/project" });
      assert.isUndefined(absent);
    }),
  );
});

describe("adapter MCP registration with Stave memory", () => {
  const threadId = ThreadId.make("thread-stave-memory");
  const memoryForCodex = { sm_abc: { command: "/opt/context-marmot" } } as const;

  it("adds memory next to the lecturn server, and alone without an MCP session", () => {
    assert.deepStrictEqual(
      codexThreadRuntimeParams({ threadId, extraMcpServers: memoryForCodex }).config.mcp_servers,
      memoryForCodex,
    );
    const cursorMemory = staveMemoryCursorMcpServers(configured);
    assert.deepStrictEqual(cursorMcpServers(threadId, cursorMemory), cursorMemory);

    McpProviderSession.setMcpProviderSession({
      environmentId: EnvironmentId.make("environment-stave-memory"),
      threadId,
      providerSessionId: "mcp-session-stave-memory",
      providerInstanceId: ProviderInstanceId.make("codex"),
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer stave-memory-token",
      browserToolsAvailable: false,
    });
    try {
      const codexServers = codexThreadRuntimeParams({ threadId, extraMcpServers: memoryForCodex })
        .config.mcp_servers as Record<string, unknown>;
      assert.deepStrictEqual(Object.keys(codexServers).toSorted(), ["lecturn", "sm_abc"]);
      assert.deepStrictEqual(
        Object.keys(cursorMcpServers(threadId, cursorMemory) ?? {}).toSorted(),
        ["context-marmot", "lecturn"],
      );
    } finally {
      McpProviderSession.clearMcpProviderSession(threadId);
    }
  });
});

function never(): never {
  throw new Error("unreachable");
}

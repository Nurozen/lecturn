import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ClaudeSettings, ProviderInstanceId } from "@t3tools/contracts";
import { isHostWindows } from "@t3tools/shared/hostProcess";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import {
  SYNTHETIC_CLAUDE_CAPABLE_MODEL,
  SYNTHETIC_CLAUDE_COLLIDING_ALIAS,
  SYNTHETIC_CLAUDE_MODEL_CATALOG,
  SYNTHETIC_CLAUDE_STANDARD_MODEL,
  SYNTHETIC_CLAUDE_THINKING_MODEL,
} from "../provider/ClaudeModelCatalog.testFixtures.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { sanitizeThreadTitle } from "./TextGenerationUtils.ts";
import { makeClaudeTextGeneration } from "./ClaudeTextGeneration.ts";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const ClaudeTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-claude-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeFakeClaudeBinary(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const isWindows = yield* isHostWindows;
    const binDir = path.join(dir, "bin");
    const stubPath = path.join(binDir, "claude-stub.mjs");
    yield* fs.makeDirectory(binDir, { recursive: true });

    // The stub behaviour lives in Node rather than a `#!/bin/sh` script so the
    // same implementation is usable on Windows, where a shebang file is not
    // executable and would fall through to the real Claude CLI on PATH.
    yield* fs.writeFileString(
      stubPath,
      [
        'const args = process.argv.slice(2).join(" ");',
        "",
        "function fail(message, code) {",
        '  process.stderr.write(message + "\\n");',
        "  process.exit(code);",
        "}",
        "",
        'if (process.argv.includes("--safe-mode")) {',
        '  const fs = await import("node:fs");',
        '  const path = await import("node:path");',
        '  if (!path.basename(process.cwd()).startsWith("lecturn-workflow-inference-") || fs.readdirSync(process.cwd()).length !== 0) fail("workflow cwd was not isolated", 12);',
        '  if (process.argv[process.argv.indexOf("--tools") + 1] !== "") fail("workflow tools were not disabled", 13);',
        '  if (process.argv.includes("--dangerously-skip-permissions") || process.argv.includes("--bare")) fail("workflow lost safe OAuth mode", 14);',
        "}",
        'let stdinContent = "";',
        "if (!process.stdin.isTTY) {",
        "  const chunks = [];",
        "  for await (const chunk of process.stdin) {",
        "    chunks.push(chunk);",
        "  }",
        '  stdinContent = Buffer.concat(chunks).toString("utf8");',
        "}",
        "",
        "const argsMustContain = process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN;",
        "if (argsMustContain && !args.includes(argsMustContain)) {",
        '  fail("args missing expected content", 2);',
        "}",
        "",
        "const argsMustNotContain = process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;",
        "if (argsMustNotContain && args.includes(argsMustNotContain)) {",
        '  fail("args contained forbidden content", 3);',
        "}",
        "",
        "const stdinMustContain = process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN;",
        "if (stdinMustContain && !stdinContent.includes(stdinMustContain)) {",
        '  fail("stdin missing expected content", 4);',
        "}",
        "",
        "const configDirMustBe = process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE;",
        "if (configDirMustBe && process.env.CLAUDE_CONFIG_DIR !== configDirMustBe) {",
        '  fail("CLAUDE_CONFIG_DIR was " + (process.env.CLAUDE_CONFIG_DIR ?? ""), 5);',
        "}",
        "",
        "const stderrText = process.env.T3_FAKE_CLAUDE_STDERR;",
        "if (stderrText) {",
        '  process.stderr.write(stderrText + "\\n");',
        "}",
        "",
        'process.stdout.write(process.env.T3_FAKE_CLAUDE_OUTPUT ?? "");',
        "process.exitCode = Number(process.env.T3_FAKE_CLAUDE_EXIT_CODE ?? 0);",
        "",
      ].join("\n"),
    );

    if (isWindows) {
      // Windows resolves executables through PATHEXT, so the entry point has to
      // carry a real extension. `resolveSpawnCommand` spawns `.cmd` via a shell.
      yield* fs.writeFileString(
        path.join(binDir, "claude.cmd"),
        ["@echo off", 'node "%~dp0claude-stub.mjs" %*', "exit /b %ERRORLEVEL%", ""].join("\r\n"),
      );
    } else {
      const claudePath = path.join(binDir, "claude");
      yield* fs.writeFileString(
        claudePath,
        ["#!/bin/sh", 'exec node "$(dirname "$0")/claude-stub.mjs" "$@"', ""].join("\n"),
      );
      yield* fs.chmod(claudePath, 0o755);
    }

    return binDir;
  });
}

function withFakeClaudeEnv<A, E, R>(
  input: {
    output: string;
    exitCode?: number;
    stderr?: string;
    argsMustContain?: string;
    argsMustNotContain?: string;
    stdinMustContain?: string;
    configDirMustBe?: string;
    claudeConfig?: Partial<ClaudeSettings>;
  },
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-claude-text-" });
    const binDir = yield* makeFakeClaudeBinary(tempDir);
    const pathDelimiter = (yield* isHostWindows) ? ";" : ":";
    const previousPath = process.env.PATH;
    const previousOutput = process.env.T3_FAKE_CLAUDE_OUTPUT;
    const previousExitCode = process.env.T3_FAKE_CLAUDE_EXIT_CODE;
    const previousStderr = process.env.T3_FAKE_CLAUDE_STDERR;
    const previousArgsMustContain = process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
    const previousArgsMustNotContain = process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
    const previousStdinMustContain = process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
    const previousConfigDirMustBe = process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE;

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.env.PATH = `${binDir}${pathDelimiter}${previousPath ?? ""}`;
        process.env.T3_FAKE_CLAUDE_OUTPUT = input.output;

        if (input.exitCode !== undefined) {
          process.env.T3_FAKE_CLAUDE_EXIT_CODE = String(input.exitCode);
        } else {
          delete process.env.T3_FAKE_CLAUDE_EXIT_CODE;
        }

        if (input.stderr !== undefined) {
          process.env.T3_FAKE_CLAUDE_STDERR = input.stderr;
        } else {
          delete process.env.T3_FAKE_CLAUDE_STDERR;
        }

        if (input.argsMustContain !== undefined) {
          process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN = input.argsMustContain;
        } else {
          delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
        }

        if (input.argsMustNotContain !== undefined) {
          process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN = input.argsMustNotContain;
        } else {
          delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
        }

        if (input.stdinMustContain !== undefined) {
          process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN = input.stdinMustContain;
        } else {
          delete process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
        }

        if (input.configDirMustBe !== undefined) {
          process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE = input.configDirMustBe;
        } else {
          delete process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE;
        }
      }),
      () =>
        Effect.sync(() => {
          process.env.PATH = previousPath;

          if (previousOutput === undefined) {
            delete process.env.T3_FAKE_CLAUDE_OUTPUT;
          } else {
            process.env.T3_FAKE_CLAUDE_OUTPUT = previousOutput;
          }

          if (previousExitCode === undefined) {
            delete process.env.T3_FAKE_CLAUDE_EXIT_CODE;
          } else {
            process.env.T3_FAKE_CLAUDE_EXIT_CODE = previousExitCode;
          }

          if (previousStderr === undefined) {
            delete process.env.T3_FAKE_CLAUDE_STDERR;
          } else {
            process.env.T3_FAKE_CLAUDE_STDERR = previousStderr;
          }

          if (previousArgsMustContain === undefined) {
            delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
          } else {
            process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN = previousArgsMustContain;
          }

          if (previousArgsMustNotContain === undefined) {
            delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
          } else {
            process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN = previousArgsMustNotContain;
          }

          if (previousStdinMustContain === undefined) {
            delete process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
          } else {
            process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN = previousStdinMustContain;
          }

          if (previousConfigDirMustBe === undefined) {
            delete process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE;
          } else {
            process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE = previousConfigDirMustBe;
          }
        }),
    );

    const config = decodeClaudeSettings(input.claudeConfig ?? {});
    const textGeneration = yield* makeClaudeTextGeneration(
      config,
      undefined,
      Effect.succeed(SYNTHETIC_CLAUDE_MODEL_CATALOG),
    );
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

it.layer(ClaudeTextGenerationTestLayer)("ClaudeTextGeneration", (it) => {
  for (const [label, output] of [
    ["malformed JSON", "not JSON"],
    ["missing stage", JSON.stringify({ summary: "Working", confidence: 0.8 })],
    ["missing confidence", JSON.stringify({ summary: "Working", stage: "build" })],
    ["invalid stage", JSON.stringify({ summary: "Working", stage: "completed", confidence: 0.8 })],
    [
      "confidence above one",
      JSON.stringify({ summary: "Working", stage: "build", confidence: 1.1 }),
    ],
    [
      "negative confidence",
      JSON.stringify({ summary: "Working", stage: "build", confidence: -0.1 }),
    ],
  ]) {
    it.effect(`rejects workflow inference with ${label}`, () =>
      withFakeClaudeEnv(
        {
          output:
            output === "not JSON"
              ? output
              : JSON.stringify({ structured_output: JSON.parse(output!) }),
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const failure = yield* textGeneration
              .generateWorkflowSummary({
                cwd: process.cwd(),
                message:
                  '{"priorSummary":null,"turns":[{"question":"Implement the API","response":"API implemented; CI pending; approval absent."}]}',
                modelSelection: {
                  instanceId: ProviderInstanceId.make("claudeAgent"),
                  model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
                },
              })
              .pipe(Effect.flip);
            expect(failure.operation).toBe("generateWorkflowSummary");
          }),
      ),
    );
  }
  it.effect("generates an evidence summary without title truncation", () =>
    withFakeClaudeEnv(
      {
        argsMustContain: "--safe-mode --tools  --strict-mcp-config",
        argsMustNotContain: "--dangerously-skip-permissions",
        output: JSON.stringify({
          structured_output: {
            summary: " API complete.\n CI remains pending. ",
            stage: "accept",
            confidence: 0.8,
          },
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const result = yield* textGeneration.generateWorkflowSummary({
            cwd: process.cwd(),
            message:
              '{"priorSummary":null,"turns":[{"question":"Implement the API","response":"API implemented; CI pending; approval absent."}]}',
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          });
          expect(result).toEqual({
            summary: "API complete. CI remains pending.",
            stage: "accept",
            confidence: 0.8,
          });
        }),
    ),
  );

  it.effect("forwards Claude thinking settings without passing unsupported effort", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            subject: "Add important change",
            body: "",
          },
        }),
        argsMustContain: '--settings {"alwaysThinkingEnabled":false}',
        argsMustNotContain: "--effort",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/claude-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: {
              ...createModelSelection(
                ProviderInstanceId.make("claudeAgent"),
                SYNTHETIC_CLAUDE_THINKING_MODEL,
                [
                  { id: "thinking", value: false },
                  { id: "effort", value: "high" },
                ],
              ),
            },
          });

          expect(generated.subject).toBe("Add important change");
        }),
    ),
  );

  it.effect("keeps a configured custom alias opaque to the Claude CLI", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title: "Keep custom model",
            body: "",
          },
        }),
        argsMustContain: `--model ${SYNTHETIC_CLAUDE_COLLIDING_ALIAS} --dangerously-skip-permissions`,
        claudeConfig: { customModels: [SYNTHETIC_CLAUDE_COLLIDING_ALIAS] },
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generatePrContent({
            cwd: process.cwd(),
            baseBranch: "main",
            headBranch: "feature/custom-model",
            commitSummary: "Keep custom model",
            diffSummary: "1 file changed",
            diffPatch: "diff --git a/README.md b/README.md",
            modelSelection: createModelSelection(
              ProviderInstanceId.make("claudeAgent"),
              SYNTHETIC_CLAUDE_COLLIDING_ALIAS,
              [
                { id: "effort", value: "max" },
                { id: "fastMode", value: true },
                { id: "contextWindow", value: "expanded" },
              ],
            ),
          });

          expect(generated.title).toBe("Keep custom model");
        }),
    ),
  );

  it.effect(
    "keeps canonical built-in capabilities when a custom model collides with its alias",
    () =>
      withFakeClaudeEnv(
        {
          output: JSON.stringify({
            structured_output: {
              title: "Improve orchestration flow",
              body: "Body",
            },
          }),
          argsMustContain: `--model ${SYNTHETIC_CLAUDE_CAPABLE_MODEL}[expanded] --effort max --settings {"fastMode":true} --dangerously-skip-permissions`,
          claudeConfig: { customModels: [SYNTHETIC_CLAUDE_COLLIDING_ALIAS] },
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generatePrContent({
              cwd: process.cwd(),
              baseBranch: "main",
              headBranch: "feature/claude-effect",
              commitSummary: "Improve orchestration",
              diffSummary: "1 file changed",
              diffPatch: "diff --git a/README.md b/README.md",
              modelSelection: {
                ...createModelSelection(
                  ProviderInstanceId.make("claudeAgent"),
                  SYNTHETIC_CLAUDE_CAPABLE_MODEL,
                  [
                    { id: "effort", value: "max" },
                    { id: "fastMode", value: true },
                  ],
                ),
              },
            });

            expect(generated.title).toBe("Improve orchestration flow");
          }),
      ),
  );

  it.effect("generates thread titles through the Claude provider", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title:
              '  "Reconnect failures after restart because the session state does not recover"  ',
          },
        }),
        stdinMustContain: "Please investigate reconnect failures after restarting the session.",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Please investigate reconnect failures after restarting the session.",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          });

          expect(generated.title).toBe(
            sanitizeThreadTitle(
              '"Reconnect failures after restart because the session state does not recover"',
            ),
          );
        }),
    ),
  );

  it.effect("runs Claude text generation with the configured CLAUDE_CONFIG_DIR", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const claudeConfigDir = path.join(process.cwd(), ".claude-work-test");
      return yield* withFakeClaudeEnv(
        {
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          output: JSON.stringify({
            structured_output: {
              title: "Use Claude home",
            },
          }),
          configDirMustBe: claudeConfigDir,
          claudeConfig: { homePath: claudeConfigDir },
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "thread title",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
              },
            });

            expect(generated.title).toBe(sanitizeThreadTitle("Use Claude home"));
          }),
      );
    }),
  );

  it.effect("falls back when Claude thread title normalization becomes whitespace-only", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title: '  """   """  ',
          },
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread.",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          });

          expect(generated.title).toBe("New thread");
        }),
    ),
  );
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@lecturn/shared/model";
import { expect } from "vite-plus/test";

import { CodexSettings, ProviderInstanceId, TextGenerationError } from "@lecturn/contracts";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  decisionWriterInputFixture,
  decisionWriterOutputFixture,
} from "./decisionWriterTestFixtures.ts";
import { makeCodexTextGeneration } from "./CodexTextGeneration.ts";
import { writeFakeCli } from "../testUtils/fakeCli.ts";
const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const encodeTestJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const DEFAULT_TEST_MODEL_SELECTION = createModelSelection(
  ProviderInstanceId.make("codex"),
  "gpt-5.4-mini",
);

const CodexTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "lecturn-codex-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

interface FakeCodexInput {
  output: string;
  exitCode?: number;
  stderr?: string;
  requireImage?: boolean;
  requireServiceTier?: string;
  requireReasoningEffort?: string;
  forbidReasoningEffort?: boolean;
  requireArg?: string;
  forbidArg?: string;
  stdinMustContain?: string;
  stdinMustNotContain?: string;
  requireAccountRouting?: boolean;
  configSnapshot?: object;
  codexVersion?: string;
}

// The stub walks argv the way the shell script it replaced did: `--image`,
// `--config key=value`, and `--output-last-message <path>` are consumed, the
// prompt arrives on stdin, and each check exits with its own code so a
// failing test names the assertion that tripped.
function makeFakeCodexBinary(dir: string, input: FakeCodexInput) {
  const check = JSON.stringify({
    requireImage: input.requireImage ?? false,
    requireServiceTier: input.requireServiceTier ?? null,
    requireReasoningEffort: input.requireReasoningEffort ?? null,
    forbidReasoningEffort: input.forbidReasoningEffort ?? false,
    requireArg: input.requireArg ?? null,
    forbidArg: input.forbidArg ?? null,
    stdinMustContain: input.stdinMustContain ?? null,
    stdinMustNotContain: input.stdinMustNotContain ?? null,
    stderr: input.stderr ?? null,
    output: input.output,
    exitCode: input.exitCode ?? 0,
    requireAccountRouting: input.requireAccountRouting ?? false,
    initialize: {
      userAgent: `lecturn-inference-config/${input.codexVersion ?? "0.155.1"} (test)`,
      codexHome: "/test",
      platformFamily: "unix",
      platformOs: "macos",
    },
    configSnapshot: input.configSnapshot ?? {
      config: { mcp_servers: { sentinel: { enabled: true } } },
      layers: [],
    },
    models: {
      models: ["gpt-5.4-mini", "gpt-5.4", "gpt-6-sol"].map((slug) => ({
        slug,
        shell_type: "unified_exec",
        apply_patch_tool_type: "freeform",
      })),
    },
  });
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    return writeFakeCli({
      directory: path.join(dir, "bin"),
      name: "codex",
      source: [
        'import * as NodeFS from "node:fs";',
        `const check = ${check};`,
        "const args = process.argv.slice(2);",
        'const originalArgs = ` ${args.join(" ")} `;',
        // The app-server and model-catalog probes answer and exit before any
        // exec argument is inspected, as the shell script's early cases did.
        'if (originalArgs.includes(" app-server ")) {',
        '  const { createInterface } = await import("node:readline");',
        "  const lines = createInterface({ input: process.stdin });",
        '  lines.on("line", (line) => {',
        "    const message = JSON.parse(line);",
        '    const result = message.method === "initialize" ? check.initialize : check.configSnapshot;',
        '    process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");',
        "  });",
        '  await new Promise((resolve) => lines.on("close", resolve));',
        '} else if (originalArgs.includes(" debug models ")) {',
        '  process.stdout.write(JSON.stringify(check.models) + "\\n");',
        "} else {",
        "let outputPath = null;",
        "let seenImage = false;",
        'let seenServiceTier = "";',
        'let seenReasoningEffort = "";',
        'let instructionsPath = "";',
        'let developerInstructions = "";',
        "for (let index = 0; index < args.length; index += 1) {",
        '  if (args[index] === "--image") {',
        "    index += 1;",
        "    if (args[index]) seenImage = true;",
        '  } else if (args[index] === "--config") {',
        "    index += 1;",
        '    const value = args[index] ?? "";',
        '    if (value.startsWith("service_tier=")) seenServiceTier = value;',
        '    if (value.startsWith("model_reasoning_effort=")) seenReasoningEffort = value;',
        '    if (value.startsWith("model_instructions_file=")) {',
        '      instructionsPath = value.slice("model_instructions_file=".length);',
        "    }",
        '    if (value.startsWith("developer_instructions=")) developerInstructions = value;',
        '  } else if (args[index] === "--output-last-message") {',
        "    index += 1;",
        "    outputPath = args[index] ?? null;",
        "  }",
        "}",
        'if (originalArgs.includes(" --ignore-rules ")) {',
        '  if (!originalArgs.includes("mcp_servers.sentinel.enabled=false")) {',
        '    fail("MCP not disabled", 23);',
        "  }",
        '  if (!process.cwd().includes("lecturn-workflow-inference-")) {',
        '    fail("workflow cwd not isolated", 14);',
        "  }",
        '  if (!originalArgs.includes(" project_doc_max_bytes=0 ")) fail("workspace docs enabled", 15);',
        '  if (!originalArgs.includes(" features.memories=false ")) fail("memory enabled", 16);',
        '  const instructionsFile = instructionsPath.replace(/^"/, "").replace(/"$/, "");',
        "  if (!NodeFS.statSync(instructionsFile, { throwIfNoEntry: false })?.isFile()) {",
        '    fail("inference instructions missing", 17);',
        "  }",
        "  if (",
        '    !NodeFS.readFileSync(instructionsFile, "utf8").includes(',
        '      "Classify only the supplied conversation",',
        "    )",
        "  ) {",
        "    process.exit(18);",
        "  }",
        "  if (developerInstructions !== 'developer_instructions=\"\"') {",
        '    fail("developer instructions not overridden", 19);',
        "  }",
        "}",
        "if (check.requireAccountRouting) {",
        '  if (process.env.CODEX_HOME !== "/test/codex-account") fail("account home changed", 20);',
        '  if (!originalArgs.includes(" --profile work ")) fail("account profile missing", 21);',
        "  if (!originalArgs.includes(' model_provider=\"company\" ')) {",
        '    fail("account provider missing", 22);',
        "  }",
        "}",
        "const chunks = [];",
        "for await (const chunk of process.stdin) chunks.push(chunk);",
        'const stdinContent = Buffer.concat(chunks).toString("utf8");',
        "function fail(message, code) {",
        '  process.stderr.write(message + "\\n");',
        "  process.exit(code);",
        "}",
        "if (check.requireArg !== null && !originalArgs.includes(` ${check.requireArg} `)) {",
        '  fail("missing arg: " + check.requireArg, 8);',
        "}",
        "if (check.forbidArg !== null && originalArgs.includes(` ${check.forbidArg} `)) {",
        '  fail("forbidden arg: " + check.forbidArg, 9);',
        "}",
        'if (check.requireImage && !seenImage) fail("missing --image input", 2);',
        "if (",
        "  check.requireServiceTier !== null &&",
        '  seenServiceTier !== `service_tier="${check.requireServiceTier}"`',
        ") {",
        '  fail("unexpected service tier config: " + seenServiceTier, 5);',
        "}",
        "if (",
        "  check.requireReasoningEffort !== null &&",
        '  seenReasoningEffort !== `model_reasoning_effort="${check.requireReasoningEffort}"`',
        ") {",
        '  fail("unexpected reasoning effort config: " + seenReasoningEffort, 6);',
        "}",
        "if (check.forbidReasoningEffort && seenReasoningEffort.length > 0) {",
        '  fail("reasoning effort config should be omitted: " + seenReasoningEffort, 7);',
        "}",
        "if (check.stdinMustContain !== null && !stdinContent.includes(check.stdinMustContain)) {",
        '  fail("stdin missing expected content", 3);',
        "}",
        "if (check.stdinMustNotContain !== null && stdinContent.includes(check.stdinMustNotContain)) {",
        '  fail("stdin contained forbidden content", 4);',
        "}",
        'if (check.stderr !== null) process.stderr.write(check.stderr + "\\n");',
        'if (outputPath !== null) NodeFS.writeFileSync(outputPath, check.output + "\\n");',
        "process.exitCode = check.exitCode;",
        "}",
        "",
      ].join("\n"),
    });
  });
}

function withFakeCodexEnv<A, E, R>(
  input: FakeCodexInput & {
    launchArgs?: string;
    homePath?: string;
    environment?: NodeJS.ProcessEnv;
  },
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "lecturn-codex-text-" });
    const codexPath = yield* makeFakeCodexBinary(tempDir, input);
    const config = decodeCodexSettings({
      binaryPath: codexPath,
      launchArgs: input.launchArgs,
      homePath: input.homePath,
    });
    const textGeneration = yield* makeCodexTextGeneration(config, input.environment);
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

it.layer(CodexTextGenerationTestLayer)("CodexTextGeneration", (it) => {
  for (const [version, supported] of [
    ["0.156.1", true],
    ["0.157.0", false],
  ] as const) {
    it.effect(`isolated writer capability for Codex ${version}`, () =>
      withFakeCodexEnv({ output: "must not be parsed", codexVersion: version }, (service) =>
        Effect.gen(function* () {
          const result = yield* service.checkDecisionWriter!({
            cwd: process.cwd(),
            modelSelection: decisionWriterInputFixture.modelSelection,
          });
          expect(result.supported).toBe(supported);
          if (!supported) expect(result.reason).toContain("requires verification");
        }),
      ),
    );
  }
  it.effect("preflights Decisions without generating text", () =>
    withFakeCodexEnv({ output: "must not be parsed" }, (service) =>
      Effect.gen(function* () {
        expect(
          yield* service.checkDecisionWriter!({
            cwd: process.cwd(),
            modelSelection: decisionWriterInputFixture.modelSelection,
          }),
        ).toEqual({ supported: true, reason: null });
      }),
    ),
  );
  it.effect(
    "writes Decisions with the exact selected model options and isolated configuration",
    () =>
      withFakeCodexEnv(
        {
          output: encodeTestJson(decisionWriterOutputFixture),
          requireArg: "gpt-6-sol",
          requireReasoningEffort: "high",
          requireServiceTier: "priority",
          stdinMustContain: "BEGIN DECISION DATA",
        },
        (service) =>
          Effect.gen(function* () {
            expect(
              yield* service.generateDecisionNotes!({
                ...decisionWriterInputFixture,
                cwd: process.cwd(),
              }),
            ).toEqual(decisionWriterOutputFixture);
          }),
      ),
  );
  it.effect("does not substitute an effort setting when a decision binding omits it", () =>
    withFakeCodexEnv(
      { output: encodeTestJson(decisionWriterOutputFixture), forbidReasoningEffort: true },
      (service) =>
        service.generateDecisionNotes!({
          ...decisionWriterInputFixture,
          cwd: process.cwd(),
          modelSelection: createModelSelection(
            decisionWriterInputFixture.modelSelection.instanceId,
            decisionWriterInputFixture.modelSelection.model,
          ),
        }),
    ),
  );
  for (const [label, output] of [
    [
      "too many notes",
      {
        ...decisionWriterOutputFixture,
        actions: Array.from({ length: 9 }, () => decisionWriterOutputFixture.actions[0]),
      },
    ],
    [
      "inconsistent completion",
      { ...decisionWriterOutputFixture, unresolvedCandidateIds: ["candidate-1"] },
    ],
    [
      "unsolicited review authorization",
      { ...decisionWriterOutputFixture, reviewState: "confirmed" },
    ],
  ]) {
    it.effect(`rejects Decisions output with ${label}`, () =>
      withFakeCodexEnv({ output: encodeTestJson(output) }, (service) =>
        Effect.gen(function* () {
          const failure = yield* service.generateDecisionNotes!({
            ...decisionWriterInputFixture,
            cwd: process.cwd(),
          }).pipe(Effect.flip);
          expect(failure.detail).toBe("Codex returned invalid structured output.");
          expect(failure.cause).toBeUndefined();
        }),
      ),
    );
  }
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
      withFakeCodexEnv({ output: output! }, (textGeneration) =>
        Effect.gen(function* () {
          const failure = yield* textGeneration
            .generateWorkflowSummary({
              cwd: process.cwd(),
              message:
                '{"priorSummary":null,"turns":[{"question":"Implement the API","response":"API implemented; CI pending; approval absent."}]}',
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            })
            .pipe(Effect.flip);
          expect(failure.operation).toBe("generateWorkflowSummary");
        }),
      ),
    );
  }
  for (const [label, configSnapshot] of [
    ["unreadable effective configuration", { unexpected: true }],
    [
      "managed config without file fingerprints",
      { config: {}, layers: [{ name: { type: "mdm" } }] },
    ],
    ["unrepresentable MCP key", { config: { mcp_servers: { "nested.name": {} } }, layers: [] }],
  ] as const) {
    it.effect(`fails closed for ${label}`, () =>
      withFakeCodexEnv({ output: "{}", configSnapshot }, (textGeneration) =>
        Effect.gen(function* () {
          const failure = yield* textGeneration
            .generateWorkflowSummary({
              cwd: process.cwd(),
              message: '{"priorSummary":null,"turns":[{"question":"Work","response":"Done"}]}',
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            })
            .pipe(Effect.flip);
          expect(failure.operation).toBe("generateWorkflowSummary");
          expect(failure.detail).toMatch(/isolat/);
          expect(failure.cause).toBeUndefined();
        }),
      ),
    );
  }
  for (const [label, fixture] of [
    ["provider stderr", { output: "", exitCode: 1, stderr: "PRIVATE_CONVERSATION_SENTINEL" }],
    [
      "invalid structured response",
      {
        output: JSON.stringify({
          summary: "PRIVATE_CONVERSATION_SENTINEL",
          stage: "build",
          confidence: 5,
        }),
      },
    ],
  ] as const) {
    it.effect(`redacts ${label} before the auxiliary failure escapes`, () =>
      withFakeCodexEnv(fixture, (textGeneration) =>
        Effect.gen(function* () {
          const failure = yield* textGeneration
            .generateWorkflowSummary({
              cwd: process.cwd(),
              message: encodeTestJson({
                priorSummary: null,
                turns: [{ question: "PRIVATE_CONVERSATION_SENTINEL", response: "Working" }],
              }),
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            })
            .pipe(Effect.flip);
          expect(encodeTestJson(failure)).not.toContain("PRIVATE_CONVERSATION_SENTINEL");
          expect(failure.cause).toBeUndefined();
        }),
      ),
    );
  }
  it.effect(
    "isolates workflow instructions while preserving the account profile and provider",
    () =>
      withFakeCodexEnv(
        {
          requireArg: "--ignore-rules",
          forbidArg: "--ignore-user-config",
          requireAccountRouting: true,
          homePath: "/test/codex-account",
          launchArgs:
            "--profile work --config 'model_provider=\"company\"' --config 'developer_instructions=\"Account-specific instructions\"' --config 'model_instructions_file=\"/test/account-instructions\"'",
          output: JSON.stringify({
            summary: " API complete.\n CI remains pending. ",
            stage: "accept",
            confidence: 0.8,
          }),
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const result = yield* textGeneration.generateWorkflowSummary({
              cwd: process.cwd(),
              message:
                '{"priorSummary":null,"turns":[{"question":"Implement the API","response":"API implemented; CI pending; approval absent."}]}',
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            });
            expect(result).toEqual({
              summary: "API complete. CI remains pending.",
              stage: "accept",
              confidence: 0.8,
            });
          }),
      ),
  );

  it.effect("generates display summaries through isolated tool-free Codex inference", () =>
    withFakeCodexEnv(
      {
        requireArg: "--ignore-rules",
        forbidArg: "--ignore-user-config",
        stdinMustContain: "Original Contextual evidence",
        output: JSON.stringify({ text: "  SQLite supports the local cache.  " }),
      },
      (generation) =>
        Effect.gen(function* () {
          const result = yield* generation.generateContextualSummary!({
            cwd: process.cwd(),
            message: "Original Contextual evidence",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });
          expect(result).toEqual({ text: "SQLite supports the local cache." });
        }),
    ),
  );
  it.effect("generates and sanitizes commit messages without branch by default", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject:
            "  Add important change to the system with too much detail and a trailing period.\nsecondary line",
          body: "\n- added migration\n- updated tests\n",
        }),
        stdinMustNotContain: "branch must be a short semantic git branch fragment",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.subject.length).toBeLessThanOrEqual(72);
          expect(generated.subject.endsWith(".")).toBe(false);
          expect(generated.body).toBe("- added migration\n- updated tests");
          expect(generated.branch).toBeUndefined();
        }),
    ),
  );

  it.effect(
    "forwards codex service tier and non-default reasoning effort into codex exec config",
    () =>
      withFakeCodexEnv(
        {
          output: JSON.stringify({
            subject: "Add important change",
            body: "",
          }),
          requireServiceTier: "priority",
          requireReasoningEffort: "xhigh",
          stdinMustNotContain: "branch must be a short semantic git branch fragment",
        },
        (textGeneration) =>
          textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
              { id: "reasoningEffort", value: "xhigh" },
              { id: "serviceTier", value: "priority" },
            ]),
          }),
      ),
  );

  it.effect("passes exec-safe launch args into codex exec", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
        }),
        launchArgs: "--strict-config --listen off",
        requireArg: "--strict-config",
        forbidArg: "--listen",
      },
      (textGeneration) =>
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-effect",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        }),
    ),
  );

  it.effect("uses LECTURN_CODEX_LAUNCH_ARGS for codex exec over settings", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
        }),
        launchArgs: "--enable settings-feature",
        // The explicit environment replaces the inherited one, and the fake CLI's
        // launcher still has to find `node` on PATH.
        environment: {
          ...process.env,
          LECTURN_CODEX_LAUNCH_ARGS: " --strict-config --listen off ",
        },
        requireArg: "--strict-config",
        forbidArg: "settings-feature",
      },
      (textGeneration) =>
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-effect",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        }),
    ),
  );

  it.effect("defaults git text generation codex effort to low", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
        }),
        requireReasoningEffort: "low",
      },
      (textGeneration) =>
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-effect",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        }),
    ),
  );

  it.effect("generates commit message with branch when includeBranch is true", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
          branch: "fix/important-system-change",
        }),
        stdinMustContain: "branch must be a short semantic git branch fragment",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            includeBranch: true,
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.subject).toBe("Add important change");
          expect(generated.branch).toBe("feature/fix/important-system-change");
        }),
    ),
  );

  it.effect("generates PR content and trims markdown body", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title: "  Improve orchestration flow\nwith ignored suffix",
          body: "\n## Summary\n- improve flow\n\n## Testing\n- bun test\n\n",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generatePrContent({
            cwd: process.cwd(),
            baseBranch: "main",
            headBranch: "feature/codex-effect",
            commitSummary: "feat: improve orchestration flow",
            diffSummary: "2 files changed",
            diffPatch: "diff --git a/a.ts b/a.ts",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.title).toBe("Improve orchestration flow");
          expect(generated.body.startsWith("## Summary")).toBe(true);
          expect(generated.body.endsWith("\n\n")).toBe(false);
        }),
    ),
  );

  it.effect("generates branch names and normalizes branch fragments", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "  Feat/Session  ",
        }),
        stdinMustNotContain: "Image attachments supplied to the model",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "Please update session handling.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.branch).toBe("feat/session");
        }),
    ),
  );

  it.effect("generates thread titles and trims them for sidebar use", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title:
            '  "Investigate websocket reconnect regressions after worktree restore"  \nignored line',
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Please investigate websocket reconnect regressions after a worktree restore.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.title).toBe("Investigate websocket reconnect regressions aft...");
        }),
    ),
  );

  it.effect("falls back when thread title normalization becomes whitespace-only", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title: '  """   """  ',
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.title).toBe("New thread");
        }),
    ),
  );

  it.effect("trims whitespace exposed after quote removal in thread titles", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title: `  "' hello world '"  `,
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.title).toBe("hello world");
        }),
    ),
  );

  it.effect("omits attachment metadata section when no attachments are provided", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/session-timeout",
        }),
        stdinMustNotContain: "Attachment metadata:",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "Fix timeout behavior.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.branch).toBe("fix/session-timeout");
        }),
    ),
  );

  it.effect("passes image attachments through as codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
        stdinMustContain: "Attachment metadata:",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { attachmentsDir } = yield* ServerConfig.ServerConfig;
          const attachmentId = "thread-branch-image-attachment";
          const attachmentPath = path.join(attachmentsDir, `${attachmentId}.png`);
          yield* fs.makeDirectory(attachmentsDir, { recursive: true });
          yield* fs.writeFile(attachmentPath, Buffer.from("hello"));

          const generated = yield* textGeneration.generateBranchName({
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            cwd: process.cwd(),
            message: "Fix layout bug from screenshot.",
            attachments: [
              {
                type: "image",
                id: attachmentId,
                name: "bug.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
          });

          expect(generated.branch).toBe("fix/ui-regression");
        }),
    ),
  );

  it.effect("resolves persisted attachment ids to files for codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { attachmentsDir } = yield* ServerConfig.ServerConfig;
          const attachmentId = "thread-1-attachment";
          const imagePath = path.join(attachmentsDir, `${attachmentId}.png`);
          yield* fs.makeDirectory(attachmentsDir, { recursive: true });
          yield* fs.writeFile(imagePath, Buffer.from("hello"));

          const generated = yield* textGeneration
            .generateBranchName({
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
              cwd: process.cwd(),
              message: "Fix layout bug from screenshot.",
              attachments: [
                {
                  type: "image",
                  id: attachmentId,
                  name: "bug.png",
                  mimeType: "image/png",
                  sizeBytes: 5,
                },
              ],
            })
            .pipe(
              Effect.tap(() =>
                fs.stat(imagePath).pipe(
                  Effect.map((fileInfo) => {
                    expect(fileInfo.type).toBe("File");
                  }),
                ),
              ),
              Effect.ensuring(fs.remove(imagePath).pipe(Effect.catch(() => Effect.void))),
            );

          expect(generated.branch).toBe("fix/ui-regression");
        }),
    ),
  );

  it.effect("ignores missing attachment ids for codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { attachmentsDir } = yield* ServerConfig.ServerConfig;
          const missingAttachmentId = "thread-missing-attachment";
          const missingPath = path.join(attachmentsDir, `${missingAttachmentId}.png`);
          yield* fs.remove(missingPath).pipe(Effect.catch(() => Effect.void));

          const result = yield* textGeneration
            .generateBranchName({
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
              cwd: process.cwd(),
              message: "Fix layout bug from screenshot.",
              attachments: [
                {
                  type: "image",
                  id: missingAttachmentId,
                  name: "outside.png",
                  mimeType: "image/png",
                  sizeBytes: 5,
                },
              ],
            })
            .pipe(Effect.result);

          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure).toBeInstanceOf(TextGenerationError);
            expect(result.failure.message).toContain("missing --image input");
          }
        }),
    ),
  );

  it.effect(
    "fails with typed TextGenerationError when codex returns wrong branch payload shape",
    () =>
      withFakeCodexEnv(
        {
          output: JSON.stringify({
            title: "This is not a branch payload",
          }),
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const result = yield* textGeneration
              .generateBranchName({
                cwd: process.cwd(),
                message: "Fix websocket reconnect flake",
                modelSelection: DEFAULT_TEST_MODEL_SELECTION,
              })
              .pipe(Effect.result);

            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result)) {
              expect(result.failure).toBeInstanceOf(TextGenerationError);
              expect(result.failure.message).toContain("Codex returned invalid structured output");
            }
          }),
      ),
  );

  it.effect("returns typed TextGenerationError when codex exits non-zero", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ subject: "ignored", body: "" }),
        exitCode: 1,
        stderr: "codex execution failed",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const result = yield* textGeneration
            .generateCommitMessage({
              cwd: process.cwd(),
              branch: "feature/codex-error",
              stagedSummary: "M README.md",
              stagedPatch: "diff --git a/README.md b/README.md",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            })
            .pipe(Effect.result);

          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure).toBeInstanceOf(TextGenerationError);
            expect(result.failure.message).toContain(
              "Codex CLI command failed: codex execution failed",
            );
          }
        }),
    ),
  );
});

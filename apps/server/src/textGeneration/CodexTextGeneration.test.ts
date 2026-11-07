import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { createModelSelection } from "@lecturn/shared/model";
import { expect } from "vite-plus/test";

import { CodexSettings, ProviderInstanceId } from "@lecturn/contracts";

import * as ServerConfig from "../config.ts";
import { makeProcessProbe, processProbeSource } from "../testUtils/processProbe.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  decisionWriterInputFixture,
  decisionWriterOutputFixture,
} from "./decisionWriterTestFixtures.ts";
import {
  squireSummaryExpectedFixture,
  squireSummaryInputFixture,
  squireSummaryReplyFixture,
} from "./squireSummaryTestFixtures.ts";
import { makeCodexTextGeneration } from "./CodexTextGeneration.ts";
import { writeFakeCli } from "@lecturn/provider-testing/fakeCli";
const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const encodeTestJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const DEFAULT_TEST_MODEL_SELECTION = createModelSelection(
  ProviderInstanceId.make("codex"),
  "gpt-5.4-mini",
);

const layerCodexTextGenerationTest = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "lecturn-codex-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

interface FakeCodexInput {
  output: string;
  lifecycle?: { port: number; command: "exec" | "mcp list" };
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
  requireSquireHome?: boolean;
  configSnapshot?: object;
  codexVersion?: string;
  mcpServers?: ReadonlyArray<{ name: string; enabled: boolean }> | number;
}

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
    mcpServers: input.mcpServers ?? [],
    stderr: input.stderr ?? null,
    output: input.output,
    exitCode: input.exitCode ?? 0,
    requireAccountRouting: input.requireAccountRouting ?? false,
    requireSquireHome: input.requireSquireHome ?? false,
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
        'const isMcpList = args.includes("mcp") && args.includes("list");',
        ...(input.lifecycle === undefined
          ? []
          : [
              `if (isMcpList === ${input.lifecycle.command === "mcp list"}) {`,
              'process.on("SIGTERM", () => {});',
              processProbeSource(input.lifecycle.port),
              "await new Promise(() => {});",
              "}",
            ]),
        "if (isMcpList) {",
        '  if (typeof check.mcpServers === "number") process.exit(check.mcpServers);',
        "  process.stdout.write(JSON.stringify(check.mcpServers));",
        "  process.exit(0);",
        "}",
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
        "if (check.requireSquireHome) {",
        '  const home = process.env.CODEX_HOME ?? "";',
        '  if (!home.endsWith("/squire-home")) fail("not the Squire home: " + home, 24);',
        '  if (!NodeFS.existsSync(home + "/auth.json")) fail("Squire home has no login", 25);',
        '  if (NodeFS.existsSync(home + "/AGENTS.md")) fail("user AGENTS.md reached", 26);',
        '  if (!originalArgs.includes(` cli_auth_credentials_store="file" `)) {',
        '    fail("file credential store not pinned", 27);',
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
    /** A temp source CODEX_HOME holding a user AGENTS.md, with or without a file login. */
    squireSource?: { readonly fileLogin: boolean };
    environment?: NodeJS.ProcessEnv;
    models?: ReadonlyArray<string>;
    managedRuntime?: boolean;
  },
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "lecturn-codex-text-" });
    const codexPath = yield* makeFakeCodexBinary(tempDir, input);
    let homePath = input.homePath;
    if (input.squireSource) {
      homePath = `${tempDir}/source-home`;
      yield* fs.makeDirectory(homePath);
      yield* fs.writeFileString(`${homePath}/AGENTS.md`, "USER_AGENTS_SENTINEL");
      if (input.squireSource.fileLogin) yield* fs.writeFileString(`${homePath}/auth.json`, "{}");
    }
    const config = decodeCodexSettings({
      binaryPath: codexPath,
      launchArgs: input.launchArgs,
      homePath,
    });
    const textGeneration = yield* makeCodexTextGeneration(
      config,
      input.environment === undefined ? undefined : { ...process.env, ...input.environment },
      Effect.succeed(
        (input.models ?? []).map((slug) => ({
          slug,
          name: slug,
          isCustom: false,
          capabilities: null,
        })),
      ),
      input.managedRuntime
        ? Effect.succeed({
            config,
            environment: input.environment ?? process.env,
            revision: "test",
          })
        : undefined,
      input.squireSource ? ProviderInstanceId.make("codex") : undefined,
    );
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

it.layer(layerCodexTextGenerationTest)("CodexTextGeneration", (it) => {
  it.effect.each(["exec", "mcp list"] as const)(
    "kills a stalled %s CLI when its request is interrupted",
    (command) =>
      Effect.gen(function* () {
        const probe = yield* makeProcessProbe;
        yield* withFakeCodexEnv(
          { output: "", lifecycle: { port: probe.port, command } },
          (textGeneration) =>
            Effect.gen(function* () {
              const fiber = yield* textGeneration
                .generateThreadTitle({
                  cwd: process.cwd(),
                  message: "Name this thread",
                  modelSelection: DEFAULT_TEST_MODEL_SELECTION,
                })
                .pipe(Effect.forkScoped);
              yield* probe.started;

              const interrupted = yield* Fiber.interrupt(fiber).pipe(Effect.forkScoped);
              yield* probe.exited;
              yield* Fiber.join(interrupted);
              const exit = yield* Fiber.await(fiber);
              expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
            }),
        );
      }),
  );

  it.effect.each([
    { version: "0.156.1", supported: true },
    { version: "0.157.0", supported: false },
    { version: "0.165.0", supported: true },
    { version: "0.165.1", supported: false },
  ] as const)("isolated writer capability for Codex $version", ({ version, supported }) =>
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
  it.effect.each([
    {
      label: "too many notes",
      output: {
        ...decisionWriterOutputFixture,
        actions: Array.from({ length: 9 }, () => decisionWriterOutputFixture.actions[0]),
      },
    },
    {
      label: "inconsistent completion",
      output: { ...decisionWriterOutputFixture, unresolvedCandidateIds: ["candidate-1"] },
    },
    {
      label: "unsolicited review authorization",
      output: { ...decisionWriterOutputFixture, reviewState: "confirmed" },
    },
  ])("rejects Decisions output with $label", ({ output }) =>
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
  it.effect.each([
    { label: "malformed JSON", output: "not JSON" },
    { label: "missing stage", output: JSON.stringify({ summary: "Working", confidence: 0.8 }) },
    { label: "missing confidence", output: JSON.stringify({ summary: "Working", stage: "build" }) },
    {
      label: "invalid stage",
      output: JSON.stringify({ summary: "Working", stage: "completed", confidence: 0.8 }),
    },
    {
      label: "confidence above one",
      output: JSON.stringify({ summary: "Working", stage: "build", confidence: 1.1 }),
    },
    {
      label: "negative confidence",
      output: JSON.stringify({ summary: "Working", stage: "build", confidence: -0.1 }),
    },
  ])("rejects workflow inference with $label", ({ output }) =>
    withFakeCodexEnv({ output }, (textGeneration) =>
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
  it.effect.each([
    { label: "unreadable effective configuration", configSnapshot: { unexpected: true } },
    {
      label: "managed config without file fingerprints",
      configSnapshot: { config: {}, layers: [{ name: { type: "mdm" } }] },
    },
    {
      label: "unrepresentable MCP key",
      configSnapshot: { config: { mcp_servers: { "nested.name": {} } }, layers: [] },
    },
  ] as const)("fails closed for $label", ({ configSnapshot }) =>
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
  it.effect.each([
    {
      label: "provider stderr",
      fixture: { output: "", exitCode: 1, stderr: "PRIVATE_CONVERSATION_SENTINEL" },
    },
    {
      label: "invalid structured response",
      fixture: {
        output: JSON.stringify({
          summary: "PRIVATE_CONVERSATION_SENTINEL",
          stage: "build",
          confidence: 5,
        }),
      },
    },
  ] as const)("redacts $label before the auxiliary failure escapes", ({ fixture }) =>
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
  it.effect("generates Squire turn summaries through isolated tool-free Codex inference", () =>
    withFakeCodexEnv(
      {
        squireSource: { fileLogin: true },
        requireSquireHome: true,
        requireArg: "--ignore-rules",
        forbidArg: "--ignore-user-config",
        stdinMustContain: "BEGIN RUN EVIDENCE",
        output: JSON.stringify(squireSummaryReplyFixture),
      },
      (generation) =>
        Effect.gen(function* () {
          const result = yield* generation.generateSquireTurnSummary!({
            cwd: process.cwd(),
            summaryInput: squireSummaryInputFixture,
            outcome: "finished",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });
          expect(result).toEqual(squireSummaryExpectedFixture);
        }),
    ),
  );
  it.effect("names a keyring-only login instead of running Codex outside the Squire home", () =>
    withFakeCodexEnv(
      { squireSource: { fileLogin: false }, output: JSON.stringify(squireSummaryReplyFixture) },
      (generation) =>
        Effect.gen(function* () {
          const error = yield* generation.generateSquireTurnSummary!({
            cwd: process.cwd(),
            summaryInput: squireSummaryInputFixture,
            outcome: "finished",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          }).pipe(Effect.flip);
          expect(error.detail).toContain("keyring");
          expect(error.detail).toContain("codex login");
        }),
    ),
  );
  it.effect("refuses Squire summaries when no Squire home is named", () =>
    withFakeCodexEnv({ output: JSON.stringify(squireSummaryReplyFixture) }, (generation) =>
      Effect.gen(function* () {
        const error = yield* generation.generateSquireTurnSummary!({
          cwd: process.cwd(),
          summaryInput: squireSummaryInputFixture,
          outcome: "finished",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        }).pipe(Effect.flip);
        expect(error.detail).toContain("Squire Codex home");
      }),
    ),
  );
  it.effect("hides Codex failures behind the stable Squire summary error", () =>
    withFakeCodexEnv(
      {
        squireSource: { fileLogin: true },
        requireArg: "--ignore-rules",
        output: "",
        stderr: "PRIVATE_CONVERSATION_SENTINEL",
        exitCode: 1,
      },
      (generation) =>
        Effect.gen(function* () {
          const error = yield* generation.generateSquireTurnSummary!({
            cwd: process.cwd(),
            summaryInput: squireSummaryInputFixture,
            outcome: "finished",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          }).pipe(Effect.flip);
          expect(error.detail).toBe("Squire turn summary generation is unavailable.");
          expect(error.cause).toBeUndefined();
          expect(JSON.stringify(error)).not.toContain("PRIVATE_CONVERSATION_SENTINEL");
        }),
    ),
  );

  it.effect.each(["gpt-5.6-luna", "openai.gpt-5.6-luna"])(
    "dispatches the qualified live model for %s",
    (selectedModel) =>
      withFakeCodexEnv(
        {
          output: JSON.stringify({ title: "Bedrock title" }),
          models: ["openai.gpt-5.6-luna"],
          requireArg: "--model openai.gpt-5.6-luna",
          forbidArg: "--model gpt-5.6-luna",
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const result = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "Describe this change",
              modelSelection: createModelSelection(ProviderInstanceId.make("codex"), selectedModel),
            });
            expect(result.title).toBe("Bedrock title");
          }),
      ),
  );

  it.effect("omits a persisted service tier for managed ChatGPT text generation", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ subject: "Update project", body: "" }),
        managedRuntime: true,
        forbidArg: 'service_tier="priority"',
      },
      (textGeneration) =>
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/chatgpt",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
            { id: "serviceTier", value: "priority" },
          ]),
        }),
    ),
  );

  it.effect("generates titles with the user's MCP servers and plugins off", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ title: "Remove default shapes" }),
        mcpServers: [
          { name: "augmenter", enabled: true },
          { name: "my.server", enabled: true },
          { name: "already-off", enabled: false },
        ],
        requireArg:
          '--config features.plugins=false --config features.apps=false --config mcp_servers={"augmenter"={enabled=false},"my.server"={enabled=false}}',
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const result = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Augmenter task 1. Use the Augmenter MCP: link_thread when you start.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });
          expect(result.title).toBe("Remove default shapes");
        }),
    ),
  );

  it.effect("still generates when Codex cannot list its MCP servers", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ branch: "remove-default-shapes" }),
        mcpServers: 2,
        requireArg: "--config features.plugins=false --config features.apps=false --ephemeral",
        forbidArg: "mcp_servers=",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const result = yield* textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "Remove default shapes from characters",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });
          expect(result.branch).toBe("remove-default-shapes");
        }),
    ),
  );

  it.effect("keeps plugins and apps off over launch args that turn them on", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ title: "Remove default shapes" }),
        launchArgs: "--config features.plugins=true --config features.apps=true",
        requireArg:
          "--config features.plugins=true --config features.apps=true --config features.plugins=false --config features.apps=false --ephemeral",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const result = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Remove default shapes from characters",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });
          expect(result.title).toBe("Remove default shapes");
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

  it.effect("generates branch names even when the ambient scope is already closed", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "feat/background-generation",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          // Background fibers (e.g. the worktree branch rename fork) can run
          // after their launching request's scope has closed; temp files must
          // not be tied to that ambient scope or they are reaped on creation.
          const closedScope = yield* Scope.make();
          yield* Scope.close(closedScope, Exit.void);

          const generated = yield* textGeneration
            .generateBranchName({
              cwd: process.cwd(),
              message: "Please update session handling.",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            })
            .pipe(Effect.provideService(Scope.Scope, closedScope));

          expect(generated.branch).toBe("feat/background-generation");
        }),
    ),
  );

  it.effect("returns the refinement signal for an unresolved subject", () =>
    withFakeCodexEnv(
      { output: JSON.stringify({ title: "Investigate issue", needsRefinement: true }) },
      (textGeneration) =>
        Effect.gen(function* () {
          expect(
            yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "Fix this",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            }),
          ).toEqual({ title: "Investigate issue", needsRefinement: true });
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
              Effect.ensuring(fs.remove(imagePath).pipe(Effect.ignore)),
            );

          expect(generated.branch).toBe("fix/ui-regression");
        }),
    ),
  );
});

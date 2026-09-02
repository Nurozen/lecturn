import { describe, expect, it } from "@effect/vitest";
import type { ModelCapabilities } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  isCommandMissingCause,
  providerModelsFromSettings,
  spawnAndCollect,
} from "./providerSnapshot.ts";
import { CLAUDE_ADAPTER_CAPABILITIES } from "./Layers/ClaudeAdapter.ts";
import { CLAUDE_PRESENTATION } from "./Layers/ClaudeProvider.ts";
import { CODEX_ADAPTER_CAPABILITIES } from "./Layers/CodexAdapter.ts";
import { CODEX_PRESENTATION } from "./Layers/CodexProvider.ts";
import { CURSOR_ADAPTER_CAPABILITIES } from "./Layers/CursorAdapter.ts";
import { CURSOR_PRESENTATION } from "./Layers/CursorProvider.ts";
import { GROK_ADAPTER_CAPABILITIES } from "./Layers/GrokAdapter.ts";
import { GROK_PRESENTATION } from "./Layers/GrokProvider.ts";
import { OPENCODE_ADAPTER_CAPABILITIES } from "./Layers/OpenCodeAdapter.ts";
import { OPENCODE_PRESENTATION } from "./Layers/OpenCodeProvider.ts";

const OPENCODE_CUSTOM_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "variant",
      label: "Reasoning",
      type: "select",
      options: [{ id: "medium", label: "Medium", isDefault: true }],
      currentValue: "medium",
    },
    {
      id: "agent",
      label: "Agent",
      type: "select",
      options: [{ id: "build", label: "Build", isDefault: true }],
      currentValue: "build",
    },
  ],
});

describe("providerModelsFromSettings", () => {
  it("applies the provided capabilities to custom models", () => {
    const models = providerModelsFromSettings(
      [],
      ["openai/gpt-5"],
      OPENCODE_CUSTOM_MODEL_CAPABILITIES,
    );

    expect(models).toEqual([
      {
        slug: "openai/gpt-5",
        name: "openai/gpt-5",
        isCustom: true,
        capabilities: OPENCODE_CUSTOM_MODEL_CAPABILITIES,
      },
    ]);
  });

  it("preserves a custom slug that collides with a provider alias", () => {
    const capabilities = createModelCapabilities({ optionDescriptors: [] });
    const models = providerModelsFromSettings(
      [
        {
          slug: "claude-opus-4-8",
          name: "Claude Opus 4.8",
          isCustom: false,
          capabilities,
        },
      ],
      [" opus "],
      capabilities,
    );

    expect(models.map((model) => model.slug)).toEqual(["claude-opus-4-8", "opus"]);
    expect(models[1]?.isCustom).toBe(true);
  });
});

describe("ProviderCommandNotFoundError", () => {
  it("classifies normalized platform failures without parsing messages", () => {
    expect(
      isCommandMissingCause(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: "arbitrary host detail",
        }),
      ),
    ).toBe(true);
    expect(isCommandMissingCause(new Error("spawn provider ENOENT"))).toBe(false);
  });

  it.effect("retains safe failed-command diagnostics without process output", () => {
    const stderr = "'codex' is not recognized: secret-token-value";
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(9009)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.encodeText(Stream.make(stderr)),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    );
    return Effect.gen(function* () {
      const error = yield* spawnAndCollect(
        "C:\\tools\\codex.cmd",
        ChildProcess.make("codex", ["--version"]),
      ).pipe(
        Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.flip,
      );

      if (error._tag !== "ProviderCommandNotFoundError") {
        throw new Error(`Unexpected error: ${error._tag}`);
      }

      expect(error.binaryPath).toBe("C:\\tools\\codex.cmd");
      expect(error.exitCode).toBe(9009);
      expect(error.stdoutLength).toBe(0);
      expect(error.stderrLength).toBe(stderr.length);
      expect(error.message).toBe(
        "Provider command C:\\tools\\codex.cmd was not found (exit code 9009).",
      );
      expect(isCommandMissingCause(error)).toBe(true);
      expect(error).not.toHaveProperty("stdout");
      expect(error).not.toHaveProperty("stderr");
      expect(error.message).not.toContain("secret-token-value");
    });
  });
});

describe("conversationFork capability/presentation parity", () => {
  const drivers = [
    {
      driver: "codex",
      capabilities: CODEX_ADAPTER_CAPABILITIES,
      presentation: CODEX_PRESENTATION,
    },
    {
      driver: "claudeAgent",
      capabilities: CLAUDE_ADAPTER_CAPABILITIES,
      presentation: CLAUDE_PRESENTATION,
    },
    {
      driver: "opencode",
      capabilities: OPENCODE_ADAPTER_CAPABILITIES,
      presentation: OPENCODE_PRESENTATION,
    },
    {
      driver: "cursor",
      capabilities: CURSOR_ADAPTER_CAPABILITIES,
      presentation: CURSOR_PRESENTATION,
    },
    {
      driver: "grok",
      capabilities: GROK_ADAPTER_CAPABILITIES,
      presentation: GROK_PRESENTATION,
    },
  ] as const;

  it.each(drivers)(
    "$driver presentation matches the adapter capability",
    ({ capabilities, presentation }) => {
      expect(presentation.conversationFork).toBe(capabilities.conversationFork);
    },
  );

  it.each(drivers)("$driver snapshot carries conversationFork", ({ presentation }) => {
    const snapshot = buildServerProvider({
      presentation,
      enabled: true,
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [],
      probe: {
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "unknown" },
      },
    });
    expect(snapshot.conversationFork).toBe(presentation.conversationFork);
  });

  // Claude is the only provider without a positional fallback for anchor-less
  // turns, so it alone rejects mid-thread forks of pre-anchor history.
  it.each(drivers)("$driver declares its fork anchor requirement", ({ driver, capabilities }) => {
    expect(capabilities.conversationForkRequiresAnchor).toBe(driver === "claudeAgent");
  });

  it.each(drivers)(
    "$driver keeps the anchor requirement off the presentation",
    ({ presentation }) => {
      expect(presentation).not.toHaveProperty("conversationForkRequiresAnchor");
    },
  );
});

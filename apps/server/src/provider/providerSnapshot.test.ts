import { describe, expect, it } from "@effect/vitest";
import type { ModelCapabilities } from "@lecturn/contracts";
import { HostProcessPlatform } from "@lecturn/shared/hostProcess";
import { createModelCapabilities } from "@lecturn/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "./providerSnapshot.ts";
import { AntigravityProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/AntigravityAdapterV2.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { CopilotProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CopilotAdapterV2.ts";
import { CursorProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CursorAdapterV2.ts";
import { GrokProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/GrokAdapterV2.ts";
import { OpenCodeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/OpenCodeAdapterV2.ts";
import { ANTIGRAVITY_PRESENTATION } from "./AntigravityProvider.ts";
import { CLAUDE_PRESENTATION } from "./ClaudeProvider.ts";
import { CODEX_PRESENTATION } from "./CodexProvider.ts";
import { COPILOT_PRESENTATION } from "./CopilotProvider.ts";
import { CURSOR_PRESENTATION } from "./CursorProvider.ts";
import { GROK_PRESENTATION } from "./GrokProvider.ts";
import { OPENCODE_PRESENTATION } from "./OpenCodeProvider.ts";

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

  it("keeps an entry's own name and capabilities over the driver default", () => {
    const capabilities = createModelCapabilities({
      optionDescriptors: [{ id: "fastMode", label: "Fast Mode", type: "boolean" }],
    });
    const models = providerModelsFromSettings(
      [],
      ["bare", { slug: "named", name: "Named", capabilities }],
      OPENCODE_CUSTOM_MODEL_CAPABILITIES,
    );

    expect(models).toEqual([
      {
        slug: "bare",
        name: "bare",
        isCustom: true,
        capabilities: OPENCODE_CUSTOM_MODEL_CAPABILITIES,
      },
      { slug: "named", name: "Named", isCustom: true, capabilities },
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

describe("parseGenericCliVersion", () => {
  it("parses a bare version", () => {
    expect(parseGenericCliVersion("1.14.19")).toBe("1.14.19");
  });

  it("parses a v-prefixed version", () => {
    expect(parseGenericCliVersion("opencode v2.0.3")).toBe("2.0.3");
    expect(parseGenericCliVersion("v22.19.0")).toBe("22.19.0");
  });

  it("parses a version embedded in other output", () => {
    expect(parseGenericCliVersion("codex-cli 0.53.0 (build abc)")).toBe("0.53.0");
  });

  it("returns null when no version is present", () => {
    expect(parseGenericCliVersion("no version here")).toBeNull();
  });

  it("ignores versions glued to other word characters", () => {
    expect(parseGenericCliVersion("build2.0.3artifact")).toBeNull();
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
  // Presentation says "native" exactly when the orchestration adapter forks the
  // provider thread itself; every other provider forks through a portable handoff.
  const drivers = [
    {
      driver: "antigravity",
      capabilities: AntigravityProviderCapabilitiesV2,
      presentation: ANTIGRAVITY_PRESENTATION,
    },
    {
      driver: "codex",
      capabilities: CodexProviderCapabilitiesV2,
      presentation: CODEX_PRESENTATION,
    },
    {
      driver: "claudeAgent",
      capabilities: ClaudeProviderCapabilitiesV2,
      presentation: CLAUDE_PRESENTATION,
    },
    {
      driver: "opencode",
      capabilities: OpenCodeProviderCapabilitiesV2,
      presentation: OPENCODE_PRESENTATION,
    },
    {
      driver: "cursor",
      capabilities: CursorProviderCapabilitiesV2,
      presentation: CURSOR_PRESENTATION,
    },
    { driver: "grok", capabilities: GrokProviderCapabilitiesV2, presentation: GROK_PRESENTATION },
    {
      driver: "githubCopilot",
      capabilities: CopilotProviderCapabilitiesV2,
      presentation: COPILOT_PRESENTATION,
    },
  ] as const;

  it.each(drivers)(
    "$driver presentation matches the adapter capability",
    ({ capabilities, presentation }) => {
      expect(presentation.conversationFork === "native").toBe(capabilities.threads.canForkThread);
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
    expect(snapshot.externalSessions).toBe(presentation.externalSessions);
    expect(snapshot.conversationForkRequiresAnchor ?? false).toBe(
      "conversationForkRequiresAnchor" in presentation &&
        presentation.conversationForkRequiresAnchor,
    );
  });

  // Claude is the only provider without a positional fallback for anchor-less
  // turns, so it alone rejects mid-thread forks of pre-anchor history.
  it.each(drivers)("$driver declares its fork anchor requirement", ({ driver, presentation }) => {
    expect(
      "conversationForkRequiresAnchor" in presentation &&
        presentation.conversationForkRequiresAnchor,
    ).toBe(driver === "claudeAgent");
  });
});

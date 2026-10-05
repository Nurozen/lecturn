// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  applyCopilotModelSelection,
  buildCopilotAcpSpawnInput,
  COPILOT_TEXT_GENERATION_SPAWN_ARGS,
  copilotAcpSpawnArgs,
  copilotActionableErrorDetail,
  copilotSessionStateDir,
  isCopilotSessionStateEdit,
  resolveCopilotModeId,
} from "./CopilotAcpSupport.ts";

const MODE_URL = "https://agentclientprotocol.com/protocol/session-modes";
const MODE_IDS = [`${MODE_URL}#agent`, `${MODE_URL}#plan`, `${MODE_URL}#autopilot`];

describe("copilotAcpSpawnArgs", () => {
  it("surfaces approvals in Supervised and Auto", () => {
    expect(copilotAcpSpawnArgs("approval-required")).toEqual(["--acp", "--no-ask-user"]);
    expect(copilotAcpSpawnArgs("auto")).toEqual(["--acp", "--no-ask-user"]);
  });

  it("pre-approves writes for Auto-accept edits", () => {
    expect(copilotAcpSpawnArgs("auto-accept-edits")).toEqual([
      "--acp",
      "--no-ask-user",
      "--allow-tool",
      "write",
    ]);
  });

  it("allows everything for Full access", () => {
    expect(copilotAcpSpawnArgs("full-access")).toEqual(["--acp", "--no-ask-user", "--allow-all"]);
  });

  it("uses explicit args verbatim for text generation", () => {
    const spawn = buildCopilotAcpSpawnInput({
      copilotSettings: { binaryPath: "/opt/bin/copilot" },
      cwd: "/tmp/project",
      runtimeMode: "full-access",
      args: COPILOT_TEXT_GENERATION_SPAWN_ARGS,
    });
    expect(spawn.command).toBe("/opt/bin/copilot");
    expect(spawn.args).toEqual(["--acp", "--no-ask-user", "--disable-builtin-mcps"]);
  });
});

describe("applyCopilotModelSelection", () => {
  const recordingRuntime = () => {
    const calls: Array<string> = [];
    return {
      calls,
      runtime: {
        setSessionModel: (modelId: string) =>
          Effect.sync(() => {
            calls.push(modelId);
            return {};
          }),
      },
    };
  };

  it.effect("sends auto like any other model, including switching back to it", () =>
    Effect.gen(function* () {
      const { calls, runtime } = recordingRuntime();
      let current: string | undefined;
      for (const requestedModelId of ["auto", "gpt-5-mini", "auto"]) {
        current = yield* applyCopilotModelSelection({
          runtime,
          currentModelId: current,
          requestedModelId,
          mapError: (cause) => cause,
        });
      }
      expect(calls).toEqual(["auto", "gpt-5-mini", "auto"]);
      expect(current).toBe("auto");
    }),
  );

  it.effect("sends a different model once and skips the unchanged one", () =>
    Effect.gen(function* () {
      const { calls, runtime } = recordingRuntime();
      const first = yield* applyCopilotModelSelection({
        runtime,
        currentModelId: undefined,
        requestedModelId: "gpt-5-mini",
        mapError: (cause) => cause,
      });
      const second = yield* applyCopilotModelSelection({
        runtime,
        currentModelId: first,
        requestedModelId: "gpt-5-mini",
        mapError: (cause) => cause,
      });
      expect(calls).toEqual(["gpt-5-mini"]);
      expect(second).toBe("gpt-5-mini");
    }),
  );
});

describe("isCopilotSessionStateEdit", () => {
  const stateDir = copilotSessionStateDir(NodePath, { COPILOT_HOME: "/tmp/ch" }, "/home/me", "s1");

  it("resolves COPILOT_HOME first, then ~/.copilot", () => {
    expect(stateDir).toBe("/tmp/ch/session-state/s1");
    expect(copilotSessionStateDir(NodePath, {}, "/home/me", "s1")).toBe(
      "/home/me/.copilot/session-state/s1",
    );
  });

  it("matches an apply_patch that only writes the session plan", () => {
    const rawInput = `*** Begin Patch\n*** Add File: ${stateDir}/plan.md\n+# Plan\n*** End Patch`;
    expect(
      isCopilotSessionStateEdit(NodePath, { kind: "edit", data: { rawInput } }, stateDir),
    ).toBe(true);
  });

  it("keeps project edits, mixed patches, and non-edit tools", () => {
    const mixed = `*** Add File: ${stateDir}/plan.md\n*** Update File: /repo/src/a.ts`;
    expect(
      isCopilotSessionStateEdit(NodePath, { kind: "edit", data: { rawInput: mixed } }, stateDir),
    ).toBe(false);
    expect(
      isCopilotSessionStateEdit(
        NodePath,
        { kind: "edit", data: { locations: [{ path: "/tmp/ch/session-state/s10/plan.md" }] } },
        stateDir,
      ),
    ).toBe(false);
    expect(
      isCopilotSessionStateEdit(
        NodePath,
        { kind: "read", data: { locations: [{ path: `${stateDir}/plan.md` }] } },
        stateDir,
      ),
    ).toBe(false);
  });
});

describe("resolveCopilotModeId", () => {
  it("maps plan to #plan and everything else to #agent, never #autopilot", () => {
    expect(resolveCopilotModeId(MODE_IDS, "plan")).toBe(`${MODE_URL}#plan`);
    expect(resolveCopilotModeId(MODE_IDS, "default")).toBe(`${MODE_URL}#agent`);
    expect(resolveCopilotModeId(MODE_IDS, undefined)).toBe(`${MODE_URL}#agent`);
    expect(resolveCopilotModeId([`${MODE_URL}#autopilot`], undefined)).toBeUndefined();
  });
});

describe("copilotActionableErrorDetail", () => {
  it("points signed-out users at copilot login", () => {
    expect(copilotActionableErrorDetail("Error: Not authenticated. Please log in.")).toContain(
      "copilot login",
    );
  });

  it("points policy-blocked users at their org admin", () => {
    expect(
      copilotActionableErrorDetail("Copilot CLI is disabled by your organization's policy"),
    ).toContain("org admin");
  });

  it("keeps unrelated failures unchanged", () => {
    expect(copilotActionableErrorDetail("Internal error: model overloaded")).toBeUndefined();
  });
});

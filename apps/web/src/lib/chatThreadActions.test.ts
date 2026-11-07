import { ProviderInstanceId, type ModelSelection } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  resolveCarriedThreadModes,
  resolveNewThreadEnvModeSources,
  resolveNewThreadModelSelectionOverride,
} from "./chatThreadActions";

const PROJECT_DEFAULT_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "project-default",
};
const CARRIED_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "carried-model",
};

describe("chatThreadActions", () => {
  it("does not carry a non-explicit model from the destination draft back into itself", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: null,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-a",
      }),
    ).toBeNull();
  });

  it("keeps the project default above any carried selection", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: PROJECT_DEFAULT_SELECTION,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-b",
      }),
    ).toEqual(PROJECT_DEFAULT_SELECTION);
  });
});

describe("resolveNewThreadEnvModeSources", () => {
  const staveInfo = {
    spaceId: "space-1",
    isSaga: false,
    repos: [],
    memories: [],
    primaryRepoPath: "/spaces/space-1/repo",
  };

  it("forces local for a Stave space and skips the lecturn.json read", () => {
    expect(
      resolveNewThreadEnvModeSources({
        workspaceRoot: "/spaces/space-1",
        defaultThreadEnvMode: "worktree",
        stave: staveInfo,
      }),
    ).toEqual({ forcedMode: "local", projectSetting: "worktree", consultProjectFile: false });
  });

  it("skips the lecturn.json read when the per-project setting decides", () => {
    expect(
      resolveNewThreadEnvModeSources({
        workspaceRoot: "/repo",
        defaultThreadEnvMode: "worktree",
        stave: null,
      }),
    ).toEqual({ forcedMode: undefined, projectSetting: "worktree", consultProjectFile: false });
  });

  it("consults lecturn.json only for a known project with no higher-priority source", () => {
    expect(
      resolveNewThreadEnvModeSources({ workspaceRoot: "/repo", defaultThreadEnvMode: null }),
    ).toEqual({
      forcedMode: undefined,
      projectSetting: null,
      consultProjectFile: true,
    });
    expect(resolveNewThreadEnvModeSources(undefined)).toEqual({
      forcedMode: undefined,
      projectSetting: undefined,
      consultProjectFile: false,
    });
  });
});

describe("resolveCarriedThreadModes", () => {
  it("prefers the composer override, then the thread, then the draft, per mode", () => {
    expect(
      resolveCarriedThreadModes({
        composer: { runtimeMode: "approval-required", interactionMode: null },
        shell: { runtimeMode: "full-access", interactionMode: "plan" },
        draft: null,
      }),
    ).toEqual({ runtimeMode: "approval-required", interactionMode: "plan" });
    expect(
      resolveCarriedThreadModes({
        composer: null,
        shell: null,
        draft: { runtimeMode: "approval-required", interactionMode: "plan" },
      }),
    ).toEqual({ runtimeMode: "approval-required", interactionMode: "plan" });
  });

  it("carries nothing when no thread is being viewed, leaving the default to the caller", () => {
    expect(resolveCarriedThreadModes({ composer: null, shell: null, draft: null })).toEqual({
      runtimeMode: null,
      interactionMode: null,
    });
  });
});

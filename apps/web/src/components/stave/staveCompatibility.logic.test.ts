import type { StaveStatus } from "@lecturn/contracts";
import { ProjectId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  staveMemoryConfigurationText,
  staveOperationUnavailableReason,
  staveProviderSupportText,
} from "./staveCompatibility.logic";

const status: StaveStatus = {
  runnable: { path: "/bin/stave", source: "settings", version: "0.4.0", commit: null },
  runnableError: null,
  configPath: "/config.yaml",
  configExists: true,
  roots: null,
  marmot: { available: true, version: null },
  lastFailure: null,
  pendingCleanups: [],
  features: {
    source: "help",
    commands: [],
    unsupportedOperations: ["createSaga", "lifecycleAction", "destroySpace"],
  },
};

describe("Stave compatibility", () => {
  it("preserves actions for an older server and gates only reported unsupported operations", () => {
    expect(staveOperationUnavailableReason(undefined, "createSaga")).toBeNull();
    const { features, ...olderStatus } = status;
    expect(features).toBeDefined();
    expect(staveOperationUnavailableReason(olderStatus, "createSaga")).toBeNull();
    expect(staveOperationUnavailableReason(status, "createSpace")).toBeNull();
    expect(staveOperationUnavailableReason(status, "createSaga")).toContain(
      "Create saga is unavailable",
    );
  });
  it("always permits metadata recovery while gating disk cleanup", () => {
    const operation = {
      kind: "lifecycleAction",
      projectId: ProjectId.make("project"),
      workspaceRoot: "/space",
      force: false,
      memory: "keep",
    } as const;
    expect(staveOperationUnavailableReason(status, { ...operation, action: "keep" })).toBeNull();
    expect(staveOperationUnavailableReason(status, { ...operation, action: "dismiss" })).toBeNull();
    expect(
      staveOperationUnavailableReason(
        status,
        { ...operation, action: "retry", target: "destroy" },
        false,
      ),
    ).not.toBeNull();
  });
  it("uses the actual saga kind for lifecycle compatibility and leaves unknown roots to preview", () => {
    const operation = {
      kind: "lifecycleAction",
      projectId: ProjectId.make("project"),
      workspaceRoot: "/space",
      force: false,
      memory: "keep",
      action: "archiveNow",
    } as const;
    const sagaMissing = {
      ...status,
      features: { source: "help", commands: [], unsupportedOperations: ["sagaArchive"] },
    } as const;
    expect(staveOperationUnavailableReason(sagaMissing, operation, true)).toContain("Archive saga");
    expect(staveOperationUnavailableReason(sagaMissing, operation, false)).toBeNull();
    expect(staveOperationUnavailableReason(sagaMissing, operation)).toBeNull();
    const spaceMissing = {
      ...status,
      features: { ...sagaMissing.features, unsupportedOperations: ["archiveSpace"] },
    };
    expect(staveOperationUnavailableReason(spaceMissing, operation, true)).toBeNull();
    expect(staveOperationUnavailableReason(spaceMissing, operation, false)).toContain(
      "Archive space",
    );
  });
  it("distinguishes project configuration from adapter support and connection proof", () => {
    expect(staveMemoryConfigurationText({ state: "configured" })).toContain(
      "has not been verified",
    );
    expect(
      staveMemoryConfigurationText({ state: "unavailable", code: "missing_config" }),
    ).toContain("missing");
    expect(staveMemoryConfigurationText({ state: "unavailable", code: "future_code" })).toContain(
      "could not be loaded",
    );
    expect(staveMemoryConfigurationText({})).toContain("has not reported");
    expect(
      staveProviderSupportText({ supported: true, limitation: "external_server_unsupported" }),
    ).toBe("Local servers only");
    expect(staveProviderSupportText({ supported: false })).toBe("Unavailable");
  });
});

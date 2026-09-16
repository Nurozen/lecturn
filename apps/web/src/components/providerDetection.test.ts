import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  isProviderExecutableError,
  providerDetectionLabel,
  providerDetectionSendBlock,
  shouldShowProviderDetection,
} from "./providerDetection";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  displayName: "Codex",
  enabled: true,
  installed: false,
  version: null,
  status: "warning",
  auth: { status: "unknown" },
  checkedAt: "2026-09-14T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  discovery: { status: "detecting", phase: "shell" },
};

describe("provider discovery recovery", () => {
  it("gates a new turn while its unavailable provider discovers the shell, then releases it", () => {
    expect(providerDetectionSendBlock(provider)).toBe("Loading shell environment…");
    expect(
      providerDetectionSendBlock({
        ...provider,
        discovery: { status: "detecting", phase: "provider" },
      }),
    ).toBe("Detecting Codex…");
    expect(
      providerDetectionSendBlock({
        ...provider,
        installed: true,
        discovery: { status: "ready", phase: "provider" },
      }),
    ).toBeNull();
  });
  it("does not trust a cached installed flag until discovery finishes", () => {
    expect(providerDetectionSendBlock({ ...provider, installed: true })).toBe(
      "Loading shell environment…",
    );
    expect(providerDetectionSendBlock({ ...provider, discovery: undefined })).toBeNull();
  });
  it("turns a timeout into a provider-specific warning rather than an indefinite spinner", () => {
    expect(
      providerDetectionLabel({ ...provider, discovery: { status: "timed-out", phase: "shell" } }),
    ).toBe("Codex detection timed out");
  });
  it("recognizes the reported spawn stack while leaving unrelated missing-file failures alone", () => {
    expect(
      isProviderExecutableError(
        "ProviderAdapterProcessError: Failed to spawn Codex App Server process for command: codex app-server\n[cause]: Error: spawn codex ENOENT",
      ),
    ).toBe(true);
    expect(isProviderExecutableError("Error: spawn /opt/homebrew/bin/claude ENOENT")).toBe(true);
    expect(
      isProviderExecutableError("ENOENT: no such file or directory, open '/project/file.txt'"),
    ).toBe(false);
    expect(isProviderExecutableError("Codex authentication failed")).toBe(false);
    expect(isProviderExecutableError("Error: spawn git ENOENT")).toBe(false);
    expect(
      isProviderExecutableError("Provider detection is still running. Retry once it finishes."),
    ).toBe(true);
  });
});

describe("provider discovery visibility", () => {
  it("does not replay cached discovery work while an environment reconnects", () => {
    expect(shouldShowProviderDetection(provider, true)).toBe(true);
    expect(shouldShowProviderDetection(provider, false)).toBe(false);
    const ready = { ...provider, discovery: { status: "ready", phase: "provider" } } as const;
    expect(shouldShowProviderDetection(ready, true)).toBe(false);
    expect(providerDetectionLabel(ready)).toBe("Codex detection is ready");
    expect(providerDetectionSendBlock(ready)).toBeNull();
  });

  it("only offers failed detection recovery for connected environments", () => {
    const timedOut = { ...provider, discovery: { status: "timed-out", phase: "shell" } } as const;
    expect(shouldShowProviderDetection(timedOut, true)).toBe(true);
    expect(shouldShowProviderDetection(timedOut, false)).toBe(false);
    const failed = {
      ...provider,
      installed: true,
      discovery: { status: "error", phase: "provider" },
    } as const;
    expect(shouldShowProviderDetection(failed, true)).toBe(true);
    expect(shouldShowProviderDetection(failed, false)).toBe(false);
    expect(shouldShowProviderDetection({ ...failed, installed: false }, true)).toBe(false);
  });
});

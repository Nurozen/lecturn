import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@lecturn/contracts";
import { chooseLoadBalancedEnvironment } from "@lecturn/client-runtime/load-balancing";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { contextualDraftKey, useContextualDrafts } from "../state/contextualDrafts";

import {
  canAutomaticallyRetargetDraft,
  canAutomaticallyRouteToEnvironment,
} from "./automaticEnvironment";

describe("automatic draft retargeting", () => {
  const input = {
    draftId: DraftId.make("routing-context-test"),
    environmentId: EnvironmentId.make("source"),
    projectId: ProjectId.make("project"),
  };
  const key = contextualDraftKey(input.environmentId, input.projectId, input.draftId);
  afterEach(() => {
    useContextualDrafts.getState().set(key, null);
    useComposerDraftStore.getState().clearComposerContent(input.draftId);
  });

  it.each([false, true])("keeps an explicit Contextual choice on its machine (%s)", (enabled) => {
    useContextualDrafts.getState().set(key, { enabled, sourceIds: [] });
    expect(canAutomaticallyRetargetDraft(input)).toBe(false);
    expect(canAutomaticallyRetargetDraft({ ...input, projectId: ProjectId.make("other") })).toBe(
      true,
    );
  });

  it("reads a Contextual choice added while machine telemetry was pending", () => {
    expect(canAutomaticallyRetargetDraft(input)).toBe(true);
    useContextualDrafts.getState().set(key, { enabled: false, sourceIds: ["source-only"] });
    expect(canAutomaticallyRetargetDraft(input)).toBe(false);
    useContextualDrafts.getState().set(key, null);
    expect(canAutomaticallyRetargetDraft(input)).toBe(true);
  });

  it("allows prompt-only drafts but keeps terminal context on its machine", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(
      { environmentId: input.environmentId, projectId: input.projectId },
      input.draftId,
    );
    store.setPrompt(input.draftId, "Review this repository");
    expect(canAutomaticallyRetargetDraft(input)).toBe(true);
    store.setTerminalContexts(input.draftId, [
      {
        id: "terminal-context",
        threadId: ThreadId.make("source-thread"),
        terminalId: "terminal",
        terminalLabel: "Shell",
        lineStart: 1,
        lineEnd: 1,
        text: "source output",
        createdAt: "2026-10-12T00:00:00.000Z",
      },
    ]);
    expect(canAutomaticallyRetargetDraft(input)).toBe(false);
  });
});

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex_work"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated", email: "work@example.com" },
  checkedAt: "2026-09-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

describe("automatic environment routing", () => {
  it("chooses a same-account machine even when another Connect account has more capacity", () => {
    const owners = new Map([
      ["source", "work"],
      ["remote", "work"],
      ["personal", "personal"],
    ]);
    const candidates = ["remote", "personal"]
      .filter((targetEnvironmentId) =>
        canAutomaticallyRouteToEnvironment({
          sourceEnvironmentId: "source",
          targetEnvironmentId,
          accountByEnvironmentId: owners,
          selectedProvider: provider,
          providers: [provider],
        }),
      )
      .map((environmentId) => ({
        environmentId: EnvironmentId.make(environmentId),
        weight: 50,
        receivedAt: 1000,
        resources: {
          sampledAt: 1000,
          cpuUtilization: 0.1,
          cpuCount: environmentId === "personal" ? 64 : 4,
          totalMemoryBytes: 1000,
          availableMemoryBytes: 900,
        },
      }));
    expect(chooseLoadBalancedEnvironment(candidates, 1000)).toBe("remote");
  });

  it.each([
    { ...provider, auth: { status: "authenticated" as const, email: "personal@example.com" } },
    { ...provider, instanceId: ProviderInstanceId.make("codex_personal") },
    { ...provider, driver: ProviderDriverKind.make("claudeAgent") },
    { ...provider, auth: { status: "unauthenticated" as const } },
  ])("does not substitute a different provider account or instance", (target) => {
    expect(
      canAutomaticallyRouteToEnvironment({
        sourceEnvironmentId: "source",
        targetEnvironmentId: "remote",
        accountByEnvironmentId: new Map(),
        selectedProvider: provider,
        providers: [target],
      }),
    ).toBe(false);
  });

  it("accepts the same provider account with differently cased email", () => {
    expect(
      canAutomaticallyRouteToEnvironment({
        sourceEnvironmentId: "source",
        targetEnvironmentId: "remote",
        accountByEnvironmentId: new Map(),
        selectedProvider: provider,
        providers: [{ ...provider, auth: { status: "authenticated", email: "WORK@example.com" } }],
      }),
    ).toBe(true);
  });

  it("rejects another Connect owner's machine even with the same provider login", () => {
    expect(
      canAutomaticallyRouteToEnvironment({
        sourceEnvironmentId: "source",
        targetEnvironmentId: "remote",
        accountByEnvironmentId: new Map([
          ["source", "work"],
          ["remote", "personal"],
        ]),
        selectedProvider: provider,
        providers: [provider],
      }),
    ).toBe(false);
  });

  it("keeps an unidentified provider on its current machine", () => {
    const unidentified = { ...provider, auth: { status: "unknown" as const } };
    const input = {
      sourceEnvironmentId: "source",
      accountByEnvironmentId: new Map(),
      selectedProvider: unidentified,
      providers: [unidentified],
    };
    expect(canAutomaticallyRouteToEnvironment({ ...input, targetEnvironmentId: "source" })).toBe(
      true,
    );
    expect(canAutomaticallyRouteToEnvironment({ ...input, targetEnvironmentId: "remote" })).toBe(
      false,
    );
  });

  it.each([
    { ...provider, enabled: false },
    { ...provider, installed: false },
    { ...provider, status: "error" as const },
    { ...provider, availability: "unavailable" as const },
    { ...provider, auth: { status: "unknown" as const, email: "work@example.com" } },
    { ...provider, auth: { status: "authenticated" as const } },
  ])("rejects an unavailable or unidentified peer", (target) => {
    expect(
      canAutomaticallyRouteToEnvironment({
        sourceEnvironmentId: "source",
        targetEnvironmentId: "remote",
        accountByEnvironmentId: new Map(),
        selectedProvider: provider,
        providers: [target],
      }),
    ).toBe(false);
  });
});

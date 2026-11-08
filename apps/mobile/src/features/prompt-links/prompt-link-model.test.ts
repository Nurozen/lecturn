import type { EnvironmentProject } from "@lecturn/client-runtime/state/shell";
import { AppId, EnvironmentId, ProjectId, ThreadId } from "@lecturn/contracts";
import { parseNewThreadLink } from "@lecturn/shared/promptLinks";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import {
  promptLinkProjects,
  promptLinkSearchFromParams,
  stepPendingPromptLink,
  withoutPromptLinkParams,
} from "./prompt-link-model";

describe("promptLinkSearchFromParams", () => {
  it("round-trips decoded route params into the shared parser", () => {
    const search = promptLinkSearchFromParams({
      prompt: "Fix the bug & add tests = done?",
      repo: ["Nurozen/lecturn", "ignored/second"],
      provider: "codex",
      screen: "NewTask",
    });

    expect(parseNewThreadLink(search ?? "")).toEqual({
      ok: true,
      value: {
        kind: "new",
        prompt: { text: "Fix the bug & add tests = done?", hiddenCharacters: 0 },
        repository: { owner: "Nurozen", name: "lecturn" },
        provider: "codex",
        model: null,
      },
    });
  });
});

describe("stepPendingPromptLink", () => {
  const waiting = "repo=nurozen%2Flecturn";

  it("drops a link whose screen is missing from the first state after it was parsed", () => {
    expect(stepPendingPromptLink(waiting, { screenOnStack: false, ready: true })).toEqual({
      pending: null,
      resolve: null,
    });
  });

  it("holds a link on its screen until its target is ready, then resolves it once", () => {
    expect(stepPendingPromptLink(waiting, { screenOnStack: true, ready: false })).toEqual({
      pending: waiting,
      resolve: null,
    });
    expect(stepPendingPromptLink(waiting, { screenOnStack: true, ready: true })).toEqual({
      pending: null,
      resolve: waiting,
    });
  });

  it("drops a link whose screen was left before its target was ready", () => {
    expect(stepPendingPromptLink(waiting, { screenOnStack: false, ready: false })).toEqual({
      pending: null,
      resolve: null,
    });
  });
});

describe("withoutPromptLinkParams", () => {
  it("keeps the route's other params", () => {
    expect(withoutPromptLinkParams({ prompt: "hi", repo: "a/b", incomingShareId: "1" })).toEqual({
      incomingShareId: "1",
    });
  });
});

describe("promptLinkProjects", () => {
  const project = (id: string, extra: Partial<EnvironmentProject> = {}): EnvironmentProject => ({
    environmentId: EnvironmentId.make("mac"),
    id: ProjectId.make(id),
    title: id,
    workspaceRoot: `/work/${id}`,
    repositoryIdentity: {
      canonicalKey: "github.com/nurozen/lecturn",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/nurozen/lecturn",
      },
    },
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...extra,
  });
  const activeAt = (target: EnvironmentProject, updatedAt: string) =>
    makeThreadShellFixture({
      environmentId: target.environmentId,
      id: ThreadId.make(`t-${target.id}`),
      projectId: target.id,
      title: target.id,
      updatedAt,
    });

  it("offers only the picker's projects, most recently active first", () => {
    const older = project("older");
    const recent = project("recent");
    const app = project("app", {
      appBinding: { appId: AppId.make("com.example.rocket"), workspaceRoot: "/work/app" },
    });
    const archived = project("archived", {
      stave: { spaceId: "archived", isSaga: false, state: "archived", repos: [], memories: [] },
    });
    const threads = [
      activeAt(older, "2026-06-02T00:00:00.000Z"),
      activeAt(recent, "2026-06-03T00:00:00.000Z"),
      activeAt(app, "2026-06-04T00:00:00.000Z"),
      activeAt(archived, "2026-06-05T00:00:00.000Z"),
    ];

    expect(
      promptLinkProjects([older, app, archived, recent], threads, {
        owner: "Nurozen",
        name: "lecturn",
      }).map((match) => match.id),
    ).toEqual(["recent", "older"]);
  });
});

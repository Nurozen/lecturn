import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentProject } from "@lecturn/client-runtime/state/models";
import { pullRequestFallbackEnvironment } from "./pullRequestEnvironmentFallback";

const project = (environmentId: string, id: string, canonicalKey: string) =>
  ({
    environmentId,
    id,
    repositoryIdentity: { canonicalKey },
  }) as unknown as EnvironmentProject;

const projects = [
  project("laptop", "lecturn", "github.com/Nurozen/lecturn"),
  project("desktop", "other", "github.com/Nurozen/other"),
  project("server", "lecturn-copy", "github.com/Nurozen/lecturn"),
];
const target = {
  environmentId: "laptop",
  projectId: "lecturn",
  repository: "Nurozen/lecturn",
  host: "github.com",
};

describe("pullRequestFallbackEnvironment", () => {
  it("moves to a connected copy of the repository when the original is down", () => {
    expect(
      pullRequestFallbackEnvironment(target, projects, new Set(["desktop", "server"])),
    ).toEqual({ environmentId: "server", projectId: "lecturn-copy" });
  });

  it("stays put while the original is connected or nothing else holds the repository", () => {
    expect(pullRequestFallbackEnvironment(target, projects, new Set(["laptop", "server"]))).toBe(
      null,
    );
    expect(pullRequestFallbackEnvironment(target, projects, new Set(["desktop"]))).toBe(null);
  });

  it("derives the host from the original project when the route has none", () => {
    const { host: _host, ...hostless } = target;
    expect(pullRequestFallbackEnvironment(hostless, projects, new Set(["server"]))).toEqual({
      environmentId: "server",
      projectId: "lecturn-copy",
    });
  });
});

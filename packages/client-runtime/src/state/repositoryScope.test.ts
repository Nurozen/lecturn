import { EnvironmentId, ProjectId } from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  isRepositoryWatchManagerEligible,
  resolveRepositoryScope,
  type RepositoryScopeProject,
} from "./repositoryScope.ts";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const identity = {
  canonicalKey: "github.com/acme/app",
  rootPath: "/work/app",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/acme/app",
  },
};
function space(
  id: string,
  options: {
    saga?: boolean;
    parent?: string;
    repos?: string[];
    environmentId?: EnvironmentId;
  } = {},
): RepositoryScopeProject {
  return {
    id: ProjectId.make(id),
    environmentId: options.environmentId ?? local,
    workspaceRoot: `/work/${id}`,
    stave: {
      spaceId: id,
      isSaga: options.saga ?? false,
      ...(options.parent ? { memberOf: options.parent } : {}),
      createdAt: "2026-01-01T00:00:00.000Z",
      memories: [],
      repos: (options.repos ?? []).map((name) => ({ name, path: name, mode: "edit" })),
    },
  };
}
const ref = (project: RepositoryScopeProject) => ({
  environmentId: project.environmentId,
  projectId: project.id,
});

describe("repository scope", () => {
  it("unions a saga's own checkouts and all nested member spaces without targeting container roots", () => {
    const saga = space("saga", { saga: true, repos: ["control"] });
    const nested = space("nested", { saga: true, parent: "saga" });
    const member = space("member", { parent: "nested", repos: ["apps/web", "services/api"] });
    const unrelated = space("other", { repos: ["private"] });
    expect(
      resolveRepositoryScope({
        projects: [saga, nested, member, unrelated],
        roots: [ref(saga)],
      }).map((target) => target.cwd),
    ).toEqual(["/work/saga/control", "/work/member/apps/web", "/work/member/services/api"]);
  });

  it("unions group roots and preserves separate worktrees and environments for the same remote", () => {
    const first = {
      id: ProjectId.make("app"),
      environmentId: local,
      workspaceRoot: "/work/app",
      repositoryIdentity: identity,
    };
    const alias = { ...first, id: ProjectId.make("alias") };
    const checkout = { ...first, id: ProjectId.make("checkout"), workspaceRoot: "/work/checkout" };
    const otherEnvironment = { ...first, environmentId: remote };
    const projects = [first, alias, checkout, otherEnvironment];
    const targets = resolveRepositoryScope({ projects, roots: projects.map(ref) });
    expect(targets).toHaveLength(3);
    expect(targets[0]?.projectIds).toEqual([first.id, alias.id]);
    expect(new Set(targets.map((target) => target.key)).size).toBe(3);
    expect(targets.map((target) => target.environmentId)).toEqual([local, local, remote]);
  });

  it("retains reference precedence across projects before filtering in either root order", () => {
    const editable = space("edit", { repos: ["/shared/app"] });
    const reference = space("reference");
    const readOnly = {
      ...reference,
      stave: {
        ...reference.stave!,
        repos: [{ name: "context", mode: "reference" as const, path: "/shared/app" }],
      },
    };
    for (const projects of [
      [editable, readOnly],
      [readOnly, editable],
    ]) {
      expect(resolveRepositoryScope({ projects, roots: projects.map(ref) })).toEqual([]);
      expect(
        resolveRepositoryScope({ projects, roots: projects.map(ref), includeReferences: true }),
      ).toMatchObject([
        {
          cwd: "/shared/app",
          mode: "reference",
          projectIds: projects.map((project) => project.id),
        },
      ]);
    }
  });

  it("uses the ordinary thread checkout while a space thread sees every manifest repo", () => {
    const ordinary = {
      id: ProjectId.make("app"),
      environmentId: local,
      workspaceRoot: "/work/app",
      repositoryIdentity: identity,
    };
    expect(
      resolveRepositoryScope({
        projects: [ordinary],
        roots: [ref(ordinary)],
        thread: { ...ref(ordinary), worktreePath: "/work/feature", branch: "feature" },
      }),
    ).toMatchObject([{ cwd: "/work/feature", branch: "feature", repositoryIdentity: identity }]);
    const multi = space("multi", { repos: ["web", "api"] });
    expect(
      resolveRepositoryScope({
        projects: [multi],
        roots: [ref(multi)],
        thread: { ...ref(multi), worktreePath: "/legacy", branch: "legacy" },
      }).map((target) => target.cwd),
    ).toEqual(["/work/multi/web", "/work/multi/api"]);
  });

  it("does not manufacture repositories for ordinary containers or empty spaces", () => {
    const container = {
      id: ProjectId.make("container"),
      environmentId: local,
      workspaceRoot: "/work",
    };
    const empty = space("empty");
    expect(
      resolveRepositoryScope({ projects: [container, empty], roots: [ref(container), ref(empty)] }),
    ).toEqual([]);
  });

  it("does not cross environment boundaries or attach a child to ambiguous saga names", () => {
    const saga = space("saga", { saga: true });
    const remoteMember = space("remote-member", {
      parent: "saga",
      repos: ["app"],
      environmentId: remote,
    });
    expect(resolveRepositoryScope({ projects: [saga, remoteMember], roots: [ref(saga)] })).toEqual(
      [],
    );
    const duplicate = {
      ...saga,
      id: ProjectId.make("duplicate"),
      workspaceRoot: "/elsewhere/saga",
    };
    const member = space("member", { parent: "saga", repos: ["app"] });
    expect(
      resolveRepositoryScope({ projects: [saga, duplicate, member], roots: [ref(saga)] }),
    ).toEqual([]);
  });

  it("terminates cyclic saga membership and repeated group roots", () => {
    const a = space("a", { saga: true, parent: "b", repos: ["app"] });
    const b = space("b", { saga: true, parent: "a", repos: ["api"] });
    expect(
      resolveRepositoryScope({ projects: [a, b], roots: [ref(a), ref(b), ref(a)] }).map(
        (target) => target.cwd,
      ),
    ).toEqual(["/work/a/app", "/work/b/api"]);
  });

  it("uses physical roster identity to reject stale incarnations and resolve same-name saga ambiguity", () => {
    const saga = space("saga", { saga: true });
    const duplicate = {
      ...saga,
      id: ProjectId.make("duplicate"),
      workspaceRoot: "/elsewhere/saga",
    };
    const member = space("member", { parent: "saga", repos: ["app"] });
    const entry = {
      environmentId: local,
      sagaRoot: saga.workspaceRoot,
      status: {
        sagaId: "saga",
        sagaCreatedAt: saga.stave!.createdAt!,
        notes: [],
        members: [
          {
            id: "member",
            workspaceRoot: member.workspaceRoot,
            createdAt: member.stave!.createdAt!,
            after: [],
            state: "live" as const,
            dirty: false,
            repos: [],
            prs: [],
          },
        ],
      },
    };
    const input = { projects: [saga, duplicate, member], roots: [ref(saga)], sagaIndex: [entry] };
    expect(resolveRepositoryScope(input).map((target) => target.cwd)).toEqual(["/work/member/app"]);
    expect(
      resolveRepositoryScope({
        ...input,
        sagaIndex: [
          { ...entry, status: { ...entry.status, sagaCreatedAt: "2025-01-01T00:00:00.000Z" } },
        ],
      }),
    ).toEqual([]);
    expect(
      resolveRepositoryScope({
        ...input,
        sagaIndex: [
          {
            ...entry,
            status: {
              ...entry.status,
              members: [{ ...entry.status.members[0]!, workspaceRoot: "/wrong/member" }],
            },
          },
        ],
      }),
    ).toEqual([]);
  });
});

describe("watch manager eligibility", () => {
  const repoIdentity = { ...identity, displayName: "acme/app" };
  const member = {
    ...space("member", { parent: "saga" }),
    stave: {
      ...space("member", { parent: "saga" }).stave!,
      repos: [
        {
          name: "app",
          path: "app",
          resolvedPath: "/work/member/app",
          mode: "edit" as const,
          repositoryIdentity: repoIdentity,
        },
      ],
    },
  };
  const standalone = {
    id: ProjectId.make("standalone"),
    environmentId: local,
    workspaceRoot: "/work/member/app",
    repositoryIdentity: repoIdentity,
  };
  const watch = { reference: { projectId: member.id, repository: "acme/app", host: "github.com" } };
  const eligible = (
    projects: readonly RepositoryScopeProject[],
    thread = ref(standalone),
    candidate = watch,
  ) =>
    isRepositoryWatchManagerEligible({ projects, environmentId: local, thread, watch: candidate });

  it("accepts a standalone project for an editable Stave checkout", () => {
    expect(eligible([standalone, member])).toBe(true);
    expect(eligible([standalone, member], ref(member))).toBe(true);
    expect(
      eligible([standalone, member], ref(standalone), {
        reference: { ...watch.reference, repository: "ACME/APP", host: "GITHUB.COM" },
      }),
    ).toBe(true);
  });

  it("uses the manager thread worktree when matching an alias", () => {
    const main = { ...standalone, workspaceRoot: "/work/main" };
    expect(eligible([main, member])).toBe(false);
    expect(
      isRepositoryWatchManagerEligible({
        projects: [main, member],
        environmentId: local,
        thread: { ...ref(main), worktreePath: "/work/member/app", branch: "feature" },
        watch,
      }),
    ).toBe(true);
  });

  it("rejects reference aliases even when another row advertises editing", () => {
    const reference = {
      ...member,
      stave: {
        ...member.stave,
        repos: [
          ...member.stave.repos,
          { ...member.stave.repos[0]!, name: "context", mode: "reference" as const },
        ],
      },
    };
    expect(eligible([standalone, reference])).toBe(false);
    expect(eligible([standalone, reference], ref(reference))).toBe(false);
  });

  it("rejects other environments, different clones, identities, and watched repositories", () => {
    expect(eligible([standalone, member], { ...ref(standalone), environmentId: remote })).toBe(
      false,
    );
    expect(eligible([{ ...standalone, environmentId: remote }, member])).toBe(false);
    expect(eligible([{ ...standalone, workspaceRoot: "/different/clone" }, member])).toBe(false);
    expect(
      eligible([
        {
          ...standalone,
          repositoryIdentity: { ...repoIdentity, canonicalKey: "github.com/elsewhere/app" },
        },
        member,
      ]),
    ).toBe(false);
    expect(
      eligible([standalone, member], ref(standalone), {
        reference: { ...watch.reference, repository: "acme/other" },
      }),
    ).toBe(false);
    expect(
      eligible([standalone, member], ref(standalone), {
        reference: { ...watch.reference, host: "git.example.com" },
      }),
    ).toBe(false);
  });

  it("accepts saga ancestors and ordinary same-project worktree managers", () => {
    const base = space("saga", { saga: true });
    const saga = { ...base, stave: { ...base.stave!, state: "live" as const } };
    expect(eligible([saga, member], ref(saga))).toBe(true);
    expect(
      eligible([{ ...saga, stave: { ...saga.stave, state: "archived" } }, member], ref(saga)),
    ).toBe(false);
    expect(
      isRepositoryWatchManagerEligible({
        projects: [standalone],
        environmentId: local,
        thread: { ...ref(standalone), worktreePath: "/another/worktree" },
        watch: { reference: { ...watch.reference, projectId: standalone.id } },
      }),
    ).toBe(true);
  });

  it("uses the verified physical roster for same-name saga managers and refuses reused members", () => {
    const base = space("saga", { saga: true });
    const saga = { ...base, stave: { ...base.stave!, state: "live" as const } };
    const duplicate = {
      ...saga,
      id: ProjectId.make("duplicate"),
      workspaceRoot: "/elsewhere/saga",
    };
    // The roster is authoritative even when the projected memberOf name has drifted.
    const watched = { ...member, stave: { ...member.stave, memberOf: "old-name" } };
    const entry = {
      environmentId: local,
      sagaRoot: saga.workspaceRoot,
      status: {
        sagaId: saga.stave.spaceId,
        sagaCreatedAt: saga.stave.createdAt!,
        notes: [],
        members: [
          {
            id: watched.stave.spaceId,
            workspaceRoot: watched.workspaceRoot,
            createdAt: watched.stave.createdAt!,
            after: [],
            state: "live" as const,
            dirty: false,
            repos: [],
            prs: [],
          },
        ],
      },
    };
    const input = {
      projects: [saga, duplicate, watched],
      environmentId: local,
      thread: ref(saga),
      watch,
      sagaIndex: [entry],
    };
    expect(isRepositoryWatchManagerEligible(input)).toBe(true);
    expect(isRepositoryWatchManagerEligible({ ...input, thread: ref(duplicate) })).toBe(false);
    expect(isRepositoryWatchManagerEligible({ ...input, sagaIndex: [] })).toBe(false);
    expect(
      isRepositoryWatchManagerEligible({
        ...input,
        sagaIndex: [
          {
            ...entry,
            status: {
              ...entry.status,
              members: [
                {
                  ...entry.status.members[0]!,
                  createdAt: "2025-01-01T00:00:00.000Z",
                },
              ],
            },
          },
        ],
      }),
    ).toBe(false);
    expect(
      resolveRepositoryScope({
        projects: input.projects,
        roots: [ref(saga)],
        sagaIndex: input.sagaIndex,
      }).map((target) => target.cwd),
    ).toEqual(["/work/member/app"]);
    expect(
      resolveRepositoryScope({
        projects: input.projects,
        roots: [ref(saga)],
        sagaIndex: [
          {
            ...entry,
            status: {
              ...entry.status,
              members: [
                {
                  ...entry.status.members[0]!,
                  createdAt: "2025-01-01T00:00:00.000Z",
                },
              ],
            },
          },
        ],
      }),
    ).toEqual([]);
  });
});

describe("watch manager space aliases", () => {
  it("requires matching physical space incarnation", () => {
    const original = space("original", { repos: ["app"] });
    const project = {
      ...original,
      stave: {
        ...original.stave!,
        repos: [
          {
            name: "app",
            path: "app",
            mode: "edit" as const,
            repositoryIdentity: { ...identity, displayName: "acme/app" },
          },
        ],
      },
    };
    const alias = { ...project, id: ProjectId.make("alias") };
    const input = {
      projects: [project, alias],
      environmentId: local,
      thread: ref(alias),
      watch: { reference: { projectId: project.id, repository: "acme/app" } },
    };
    expect(isRepositoryWatchManagerEligible(input)).toBe(true);
    expect(
      isRepositoryWatchManagerEligible({
        ...input,
        projects: [
          project,
          { ...alias, stave: { ...alias.stave, createdAt: "2025-01-01T00:00:00.000Z" } },
        ],
      }),
    ).toBe(false);
  });
});

describe("verified fork watch manager scope", () => {
  const original = space("fork-space", { parent: "saga" });
  const groupedIdentity = {
    ...identity,
    displayName: "acme/upstream",
    canonicalKey: "github.com/acme/upstream",
  };
  const watched = {
    ...original,
    stave: {
      ...original.stave!,
      repos: [
        {
          name: "app",
          path: "app",
          resolvedPath: "/work/fork-space/app",
          mode: "edit" as const,
          repositoryIdentity: groupedIdentity,
        },
      ],
    },
  };
  const bound = [
    watched.id,
    watched.workspaceRoot,
    watched.stave.spaceId,
    watched.stave.createdAt,
    "/work/fork-space/app",
    "github.com/owner/fork",
  ];
  const watch = {
    reference: { projectId: watched.id, repository: "owner/fork", host: "github.com" },
    binding: JSON.stringify(bound),
  };
  const eligible = (
    candidate = watch,
    projects: readonly RepositoryScopeProject[] = [watched],
    thread = ref(watched),
  ) =>
    isRepositoryWatchManagerEligible({ projects, environmentId: local, thread, watch: candidate });

  it("uses a verified fork checkout for its owning space, live saga and standalone worktree", () => {
    expect(eligible()).toBe(true);
    const base = space("saga", { saga: true });
    const saga = { ...base, stave: { ...base.stave!, state: "live" as const } };
    expect(eligible(watch, [saga, watched], ref(saga))).toBe(true);
    const checkout = {
      id: ProjectId.make("checkout"),
      environmentId: local,
      workspaceRoot: "/work/fork-space/app",
      repositoryIdentity: {
        ...identity,
        displayName: "owner/fork",
        canonicalKey: "github.com/owner/fork",
      },
    };
    expect(eligible(watch, [watched, checkout], ref(checkout))).toBe(true);
    expect(
      eligible(watch, [watched, { ...checkout, workspaceRoot: "/other/clone" }], ref(checkout)),
    ).toBe(false);
    expect(eligible(watch, [watched, checkout], { ...ref(checkout), environmentId: remote })).toBe(
      false,
    );
  });

  it("rejects malformed, stale and mismatched receipts instead of falling back to grouping", () => {
    for (const binding of ["not-json", "{}", "[]", JSON.stringify([...bound, "extra"])]) {
      expect(eligible({ ...watch, binding })).toBe(false);
    }
    for (const [index, value] of [
      [0, "wrong-project"],
      [1, "/other/root"],
      [2, "reused-space"],
      [3, "2020-01-01T00:00:00.000Z"],
      [4, "/other/checkout"],
      [5, "github.com/acme/upstream"],
      [5, "other.example.com/owner/fork"],
    ] as const) {
      const stale = [...bound];
      stale[index] = value;
      expect(eligible({ ...watch, binding: JSON.stringify(stale) })).toBe(false);
    }
    expect(
      eligible({ ...watch, reference: { ...watch.reference, host: "other.example.com" } }),
    ).toBe(false);
  });

  it("preserves reference veto, archived-space and incarnation checks for bound fork aliases", () => {
    const reference = {
      ...watched,
      stave: {
        ...watched.stave,
        repos: [
          ...watched.stave.repos,
          { ...watched.stave.repos[0]!, name: "context", mode: "reference" as const },
        ],
      },
    };
    expect(eligible(watch, [reference])).toBe(false);
    expect(eligible(watch, [{ ...watched, stave: { ...watched.stave, state: "archived" } }])).toBe(
      false,
    );
    const alias = { ...watched, id: ProjectId.make("alias") };
    expect(eligible(watch, [watched, alias], ref(alias))).toBe(true);
    expect(
      eligible(
        watch,
        [watched, { ...alias, stave: { ...alias.stave, createdAt: "2020-01-01T00:00:00.000Z" } }],
        ref(alias),
      ),
    ).toBe(false);
  });
});

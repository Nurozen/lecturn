import { assert, it } from "@effect/vitest";
import { Effect, Layer, Path } from "effect";
import {
  GitCommandError,
  ProjectId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type PullRequestListEntry,
  type PullRequestListInput,
  type PullRequestWatchTrackInput,
} from "@lecturn/contracts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { VcsDriverRegistry } from "../vcs/VcsDriverRegistry.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { PullRequestService, pullRequestRepositoryBinding } from "./PullRequestService.ts";
import { PullRequestWatchService } from "./PullRequestWatchService.ts";
import { loadWatchSagaRosters, projectContainsWatch } from "./PullRequestWatchPolicy.ts";
import { StaveRpcRuntime } from "../stave/staveRpcHandlers.ts";
import { Option } from "effect";
import {
  discoveryCandidates,
  make,
  matchesDiscoveredPullRequest,
} from "./PullRequestWatchDiscovery.ts";

const at = "2026-09-13T00:00:00.000Z";
const projectId = ProjectId.make("space");
const identity = (name: string) => ({
  canonicalKey: `github.com/owner/${name}`,
  provider: "github",
  displayName: `owner/${name}`,
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: `https://github.com/owner/${name}.git`,
  },
});
const project = {
  id: projectId,
  title: "Space",
  scripts: [],
  defaultModelSelection: null,
  createdAt: at,
  updatedAt: at,
  workspaceRoot: "/space",
  repositoryIdentity: null,
  stave: {
    spaceId: "space",
    isSaga: false,
    state: "live",
    repos: [
      {
        name: "first",
        mode: "edit",
        path: "first",
        branch: "work/first",
        repositoryIdentity: identity("first"),
      },
      {
        name: "second",
        mode: "edit",
        path: "second",
        branch: "work/second",
        repositoryIdentity: identity("second"),
      },
      {
        name: "docs",
        mode: "reference",
        path: "docs",
        branch: "work/docs",
        repositoryIdentity: identity("docs"),
      },
    ],
    memories: [],
  },
} as OrchestrationProjectShell;
const thread = {
  id: ThreadId.make("thread"),
  projectId,
  branch: "work/first",
  createdAt: at,
  updatedAt: at,
  latestUserMessageAt: at,
  archivedAt: null,
  session: { status: "running" },
} as OrchestrationThreadShell;
const entry = {
  projectId,
  provider: "github",
  host: "github.com",
  repository: "owner/second",
  number: 2,
  headBranch: "work/second",
  baseBranch: "main",
  author: { login: "owner" },
  state: "open",
  createdAt: at,
} as PullRequestListEntry;

it.effect("discovers every editable Stave branch without reusing the primary scalar branch", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const candidates = discoveryCandidates(project, [thread], path, 0);
    assert.deepEqual(
      candidates.map(({ repository, branch }) => [repository, branch]),
      [
        ["owner/first", "work/first"],
        ["owner/second", "work/second"],
      ],
    );
    const second = candidates[1]!;
    assert.isTrue(matchesDiscoveredPullRequest(second, entry, "main", "owner"));
    for (const changed of [
      { host: "enterprise.example" },
      { repository: "other/second" },
      { headBranch: "other" },
      { createdAt: "2026-09-12T00:00:00.000Z" },
      { author: null },
    ]) {
      assert.isFalse(
        matchesDiscoveredPullRequest(second, { ...entry, ...changed }, "main", "owner"),
      );
    }
    assert.isFalse(matchesDiscoveredPullRequest(second, entry, null, "owner"));
    assert.isFalse(matchesDiscoveredPullRequest(second, entry, second.branch, "owner"));
    assert.isFalse(matchesDiscoveredPullRequest(second, entry, "main", undefined));
  }).pipe(Effect.provide(Path.layer)),
);

it.effect("saga conversations discover member PRs using the member project identity", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const saga = {
      ...project,
      id: ProjectId.make("saga"),
      workspaceRoot: "/saga",
      stave: {
        ...project.stave!,
        spaceId: "saga",
        isSaga: true,
        repos: [],
      },
    };
    const member = { ...project, stave: { ...project.stave!, memberOf: "saga" } };
    const sagaThread = { ...thread, projectId: saga.id };
    const candidates = discoveryCandidates(member, [sagaThread], path, 0, [saga, member]);
    assert.equal(candidates.length, 2);
    assert.isTrue(matchesDiscoveredPullRequest(candidates[1]!, entry, "main", "owner"));
    assert.equal(candidates[1]!.thread.projectId, saga.id);
    assert.equal(candidates[1]!.projectId, member.id);
  }).pipe(Effect.provide(Path.layer)),
);

it.effect("verified rosters scope discovery by physical saga and member incarnation", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const member = { ...project, stave: { ...project.stave!, createdAt: at, memberOf: "saga" } };
    const saga = {
      ...project,
      id: ProjectId.make("saga"),
      workspaceRoot: "/saga",
      stave: { ...project.stave!, spaceId: "saga", createdAt: at, isSaga: true, repos: [] },
    };
    const duplicate = { ...saga, id: ProjectId.make("duplicate"), workspaceRoot: "/other-saga" };
    const projects = [member, saga, duplicate];
    const rosters = [
      {
        root: "/saga",
        status: {
          sagaId: "saga",
          sagaCreatedAt: at,
          notes: [],
          members: [
            {
              id: "space",
              workspaceRoot: "/space",
              createdAt: at,
              after: [],
              state: "live" as const,
              dirty: false,
              repos: [],
              prs: [],
            },
          ],
        },
      },
    ];
    const manager = { ...thread, projectId: saga.id };
    assert.equal(discoveryCandidates(member, [manager], path, 0, projects, rosters).length, 2);
    assert.deepEqual(
      discoveryCandidates(
        member,
        [{ ...manager, projectId: duplicate.id }],
        path,
        0,
        projects,
        rosters,
      ),
      [],
    );
    const replaced = {
      ...member,
      stave: { ...member.stave, createdAt: "2026-09-14T00:00:00.000Z" },
    };
    assert.deepEqual(
      discoveryCandidates(replaced, [manager], path, 0, [replaced, saga, duplicate], rosters),
      [],
    );
    const runtime = yield* StaveRpcRuntime;
    const unavailable = yield* loadWatchSagaRosters(projects, Option.some(runtime));
    assert.deepEqual(discoveryCandidates(member, [manager], path, 0, projects, unavailable), []);
  }).pipe(
    Effect.provide(
      Layer.merge(
        Path.layer,
        Layer.mock(StaveRpcRuntime)({
          sagaStatus: () => Effect.succeed({ sagaId: "saga", notes: [], members: [] }),
        }),
      ),
    ),
  ),
);

it.effect(
  "a checkout alias discovers only its own repository inside a multi-repository space",
  () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const member = {
        ...project,
        stave: {
          ...project.stave!,
          repos: project.stave!.repos.map((repo) => ({
            ...repo,
            resolvedPath: path.resolve(project.workspaceRoot, repo.path),
          })),
        },
      };
      const alias = {
        ...project,
        id: ProjectId.make("first-only"),
        workspaceRoot: "/space/first",
        repositoryIdentity: identity("first"),
        stave: undefined,
      };
      const aliasThread = { ...thread, projectId: alias.id, worktreePath: null };
      assert.deepEqual(
        discoveryCandidates(member, [aliasThread], path, 0, [member, alias]).map(
          (candidate) => candidate.repository,
        ),
        ["owner/first"],
      );
    }).pipe(Effect.provide(Path.layer)),
);

it.effect(
  "skips old inactive, archive, reference aliases and missing per-repo branch provenance",
  () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const idle = { ...thread, session: null };
      assert.deepEqual(discoveryCandidates(project, [idle], path, 2_000_000_000_000), []);
      assert.deepEqual(discoveryCandidates(project, [{ ...thread, archivedAt: at }], path, 0), []);
      const ambiguous = {
        ...project,
        stave: {
          ...project.stave!,
          repos: [
            ...project.stave!.repos,
            { name: "alias", mode: "reference" as const, path: "second" },
          ],
        },
      };
      assert.equal(discoveryCandidates(ambiguous, [thread], path, 0).length, 1);
      const missing = {
        ...project,
        stave: {
          ...project.stave!,
          repos: project.stave!.repos.map((repo) => ({
            name: repo.name,
            path: repo.path,
            mode: repo.mode,
            repositoryIdentity: repo.repositoryIdentity!,
          })),
        },
      };
      assert.deepEqual(discoveryCandidates(missing, [thread], path, 0), []);
    }).pipe(Effect.provide(Path.layer)),
);

it.effect(
  "worker bounds provider polling, associates without ownership and does not resume paused watches",
  () =>
    Effect.gen(function* () {
      let reads = 0;
      const tracked: PullRequestWatchTrackInput[] = [];
      const projects = Array.from({ length: 6 }, (_, index) => ({
        ...project,
        id: ProjectId.make(`space-${index}`),
      }));
      const threads = projects.map((p) => ({ ...thread, projectId: p.id }));
      const projections = Layer.succeed(ProjectionSnapshotQuery, {
        getShellSnapshot: () =>
          Effect.succeed({ projects, threads, snapshotSequence: 0, updatedAt: at }),
      } as unknown as ProjectionSnapshotQuery["Service"]);
      const requests = Layer.succeed(PullRequestService, {
        list: (input: PullRequestListInput) =>
          Effect.sync(() => {
            reads++;
            return {
              entries: [{ ...entry, projectId: input.projectId! }],
              viewers: { "github.com": "owner" },
              providers: [],
              errors: [],
              truncated: false,
              nextCursors: {},
            };
          }),
      } as unknown as PullRequestService["Service"]);
      const watches = Layer.succeed(PullRequestWatchService, {
        list: () =>
          Effect.succeed({
            defaultMergeMode: "follow-pr",
            watches: [
              {
                reference: { ...entry, projectId: projects[0]!.id },
                threadIds: [thread.id],
                watching: false,
              },
            ],
          }),
        track: (input: PullRequestWatchTrackInput) =>
          Effect.sync(() => {
            tracked.push(input);
            return {};
          }),
      } as unknown as PullRequestWatchService["Service"]);
      const git = Layer.succeed(GitVcsDriver, {
        resolveDefaultBranchName: () => Effect.succeed("main"),
        execute: ({ cwd }: { cwd: string }) =>
          Effect.succeed({
            exitCode: 0,
            stdout: `work/${cwd.split("/").at(-1)}`,
            stdoutTruncated: false,
          }),
      } as unknown as GitVcsDriver["Service"]);
      const service = yield* make.pipe(
        Effect.provide(Layer.mergeAll(projections, requests, watches, git, Path.layer)),
      );
      yield* service.tick;
      assert.equal(reads, 4);
      assert.equal(tracked.length, 3);
      assert.isTrue(tracked.every((input) => input.manage === undefined));
      yield* service.tick;
      assert.equal(reads, 6);
      yield* service.tick;
      assert.equal(reads, 6);
      threads[0] = { ...threads[0]!, latestUserMessageAt: "2026-09-13T00:01:00.000Z" };
      yield* service.tick;
      assert.equal(reads, 7, "new conversation work bypasses project cooldown");
      assert.equal(tracked.length, 5, "stopped associated watch remains untouched");
    }),
);

it.effect(
  "a thread-created fork PR is automatically associated from a secondary Stave checkout",
  () =>
    Effect.gen(function* () {
      const tracked: PullRequestWatchTrackInput[] = [];
      const forkEntry = {
        ...entry,
        repository: "mine/second",
        number: 31,
        headBranch: "feature/agent-switched",
      };
      const branchReads: string[] = [];
      const service = yield* make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ProjectionSnapshotQuery)({
              getShellSnapshot: () =>
                Effect.succeed({
                  projects: [project],
                  threads: [thread],
                  snapshotSequence: 0,
                  updatedAt: at,
                }),
            }),
            Layer.mock(PullRequestService)({
              list: (_input, options) => {
                assert.isTrue(options?.allRemotes);
                return Effect.succeed({
                  entries: [forkEntry],
                  viewers: { "github.com": "owner" },
                  providers: [],
                  errors: [],
                  truncated: false,
                  nextCursors: {},
                });
              },
            }),
            Layer.mock(PullRequestWatchService)({
              list: () => Effect.succeed({ defaultMergeMode: "follow-pr", watches: [] }),
              track: (input) =>
                Effect.sync(() => {
                  tracked.push(input);
                  return {} as never;
                }),
            }),
            Layer.mock(GitVcsDriver)({
              resolveDefaultBranchName: () => Effect.succeed("main"),
              execute: ({ cwd, args }) =>
                Effect.sync(() => {
                  branchReads.push(cwd);
                  assert.deepEqual(args, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
                  return {
                    exitCode: 0 as never,
                    stdout: cwd.endsWith("second") ? "feature/agent-switched" : "work/first",
                    stderr: "",
                    stdoutTruncated: false,
                    stderrTruncated: false,
                  };
                }),
            }),
            Layer.succeed(VcsDriverRegistry, {
              resolve: ({ cwd }: { cwd: string }) =>
                Effect.succeed({
                  driver: {
                    listRemotes: () =>
                      Effect.succeed({
                        remotes: [
                          {
                            name: "upstream",
                            url: `https://github.com/owner/${cwd.split("/").at(-1)}.git`,
                          },
                          {
                            name: "origin",
                            url: `https://github.com/mine/${cwd.split("/").at(-1)}.git`,
                          },
                        ],
                      }),
                  },
                }),
            } as unknown as VcsDriverRegistry["Service"]),
            Path.layer,
          ),
        ),
      );
      yield* service.tick;
      assert.deepEqual(
        branchReads.sort(),
        ["/space/first", "/space/second"],
        "one branch read per checkout despite two remotes",
      );
      assert.equal(tracked.length, 1);
      assert.deepEqual(tracked[0]!.reference, {
        projectId,
        host: "github.com",
        repository: "mine/second",
        number: 31,
      });
      assert.equal(tracked[0]!.threadId, thread.id);
      assert.isUndefined(tracked[0]!.manage);
    }),
);

it.effect("verified remote binding permits only the matching editable checkout alias", () =>
  Effect.sync(() => {
    const member = {
      ...project,
      stave: {
        ...project.stave!,
        createdAt: at,
        repos: project.stave!.repos.map((repo) => ({
          ...repo,
          resolvedPath: `/space/${repo.path}`,
        })),
      },
    };
    const alias = {
      ...project,
      id: ProjectId.make("alias"),
      workspaceRoot: "/space/second",
      repositoryIdentity: identity("second"),
      stave: undefined,
    };
    const ref = { repository: "mine/second", host: "github.com" };
    const binding = pullRequestRepositoryBinding(member, "/space/second", "github.com/mine/second");
    assert.isTrue(
      projectContainsWatch(alias.id, member.id, [alias, member], null, ref, undefined, binding),
    );
    assert.isFalse(
      projectContainsWatch(
        alias.id,
        member.id,
        [alias, member],
        "/space/first",
        ref,
        undefined,
        binding,
      ),
    );
    assert.isFalse(
      projectContainsWatch(
        alias.id,
        member.id,
        [alias, member],
        null,
        { ...ref, host: "other.example" },
        undefined,
        binding,
      ),
    );
    const replaced = { ...member, stave: { ...member.stave, createdAt: "2026-09-14T00:00:00Z" } };
    assert.isFalse(
      projectContainsWatch(alias.id, member.id, [alias, replaced], null, ref, undefined, binding),
    );
    const referenceAlias = {
      ...member,
      stave: {
        ...member.stave,
        repos: [
          ...member.stave.repos,
          {
            name: "reference",
            path: "second",
            resolvedPath: "/space/second",
            mode: "reference" as const,
          },
        ],
      },
    };
    assert.isFalse(
      projectContainsWatch(
        alias.id,
        member.id,
        [alias, referenceAlias],
        null,
        ref,
        undefined,
        binding,
      ),
    );
  }),
);

it.effect(
  "live branch errors, detached HEAD and default branches never fall back to manifest branches",
  () =>
    Effect.gen(function* () {
      for (const mode of ["error", "detached", "truncated", "default"] as const) {
        let tracked = 0;
        let reads = 0;
        let listings = 0;
        const service = yield* make.pipe(
          Effect.provide(
            Layer.mergeAll(
              Path.layer,
              Layer.mock(ProjectionSnapshotQuery)({
                getShellSnapshot: () =>
                  Effect.succeed({
                    projects: [project],
                    threads: [thread],
                    snapshotSequence: 0,
                    updatedAt: at,
                  }),
              }),
              Layer.mock(PullRequestService)({
                list: () =>
                  Effect.sync(() => {
                    listings++;
                    return {
                      entries: [
                        { ...entry, headBranch: mode === "default" ? "main" : entry.headBranch },
                      ],
                      viewers: { "github.com": "owner" },
                      providers: [],
                      errors: [],
                      truncated: false,
                      nextCursors: {},
                    };
                  }),
              }),
              Layer.mock(PullRequestWatchService)({
                list: () => Effect.succeed({ watches: [], defaultMergeMode: "follow-pr" }),
                track: () =>
                  Effect.sync(() => {
                    tracked++;
                    return {} as never;
                  }),
              }),
              Layer.mock(GitVcsDriver)({
                resolveDefaultBranchName: () => Effect.succeed("main"),
                execute: ({ cwd }) =>
                  Effect.suspend(() => {
                    reads++;
                    if (mode === "error")
                      return Effect.fail(
                        new GitCommandError({
                          operation: "test",
                          command: "git",
                          cwd,
                          detail: "unavailable",
                        }),
                      );
                    return Effect.succeed({
                      exitCode: (mode === "detached" ? 1 : 0) as never,
                      stdout: mode === "default" ? "main" : `work/${cwd.split("/").at(-1)}`,
                      stderr: "",
                      stdoutTruncated: mode === "truncated",
                      stderrTruncated: false,
                    });
                  }),
              }),
            ),
          ),
        );
        yield* service.tick;
        assert.equal(reads, 2, mode);
        assert.equal(tracked, 0, mode);
        assert.equal(listings, mode === "default" ? 1 : 0, mode);
      }
    }),
);

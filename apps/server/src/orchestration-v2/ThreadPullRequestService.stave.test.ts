/**
 * Stave manifest-checkout PR inference on V2 (re-expressed from the V1
 * ThreadPullRequestReactor Stave cases).
 */
import {
  ProjectId,
  ProviderInstanceId,
  SourceControlProviderKind,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type PullRequestRef,
  type PullRequestSummary,
  type ThreadLinkedPullRequest,
} from "@lecturn/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { GitManager, type GitBranchPullRequest } from "../git/GitManager.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import { PullRequestService } from "../pullRequest/PullRequestService.ts";
import { StaveProjectShells } from "../stave/StaveProjectShells.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadPullRequestService from "./ThreadPullRequestService.ts";

const NOW = DateTime.makeUnsafe("2026-09-01T12:00:00.000Z");
const PROJECT_ID = ProjectId.make("project");
const REPOSITORY = "owner/repository";
const REPOSITORY_KEY = `github.com/${REPOSITORY}`;
type SyncCommand = Extract<OrchestrationV2ServerCommand, { type: "thread.pull-request.sync" }>;

const identity = {
  canonicalKey: REPOSITORY_KEY,
  displayName: REPOSITORY,
  rootPath: "/workspace/project",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: `git@github.com:${REPOSITORY}.git`,
  },
};

const plainProject: OrchestrationProjectShell = {
  id: PROJECT_ID,
  title: "Project",
  workspaceRoot: "/workspace/project",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-09-01T12:00:00.000Z",
  updatedAt: "2026-09-01T12:00:00.000Z",
};

const staveProject: OrchestrationProjectShell = {
  ...plainProject,
  stave: {
    spaceId: "space",
    isSaga: false,
    state: "live",
    memories: [],
    repos: [{ name: "repo", path: "repo", mode: "edit", branch: "manifest-old" }],
    primaryRepoPath: "/workspace/project/repo",
    primaryBranch: "primary-old",
    primaryRepositoryIdentity: { ...identity, rootPath: "/workspace/project/repo" },
  },
};

function reference(number: number): ThreadLinkedPullRequest {
  return {
    projectId: PROJECT_ID,
    repository: REPOSITORY,
    number,
    url: `https://github.com/${REPOSITORY}/pull/${number}`,
  };
}

function branchPullRequest(number = 42): GitBranchPullRequest {
  return {
    ...reference(number),
    title: "Branch pull request",
    baseRef: "main",
    headRef: "feature",
    state: "open",
    updatedAt: "2026-09-01T12:00:00.000Z",
    repositoryKey: REPOSITORY_KEY,
  };
}

function summary(input: PullRequestRef, state: PullRequestSummary["state"]): PullRequestSummary {
  return {
    ...input,
    provider: SourceControlProviderKind.make("github"),
    title: "Pull request",
    url: reference(input.number).url,
    state,
    headBranch: "feature",
    baseBranch: "main",
    updatedAt: "2026-09-01T12:00:00.000Z",
  };
}

function localStatus(refName: string | null) {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName,
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
  };
}

function thread(
  id: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    projectId: PROJECT_ID,
    title: id,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feature",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

const run = Effect.fn("ThreadPullRequestService.stave.run")(function* (options: {
  readonly project: OrchestrationProjectShell;
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly existing: ReadonlyArray<string>;
  readonly branchPullRequest: GitManager["Service"]["branchPullRequest"];
  readonly localStatus?: GitManager["Service"]["localStatus"];
  readonly summary?: PullRequestService["Service"]["summary"];
  readonly resolveRepositoryIdentity?: RepositoryIdentityResolver["Service"]["resolve"];
}) {
  const commands = yield* Ref.make<ReadonlyArray<SyncCommand>>([]);
  const branchCalls = yield* Ref.make<ReadonlyArray<{ cwd: string; branch: string }>>([]);
  const localCalls = yield* Ref.make<ReadonlyArray<string>>([]);
  const invalidations = yield* Ref.make<ReadonlyArray<string>>([]);
  const summaryCalls = yield* Ref.make(0);
  const reads = yield* Ref.make<ReadonlyArray<boolean | undefined>>([]);
  const { stave, ...plainShell } = options.project;
  const dependencies = Layer.mergeAll(
    Layer.mock(Orchestrator.OrchestratorV2)({
      streamDomainEvents: Stream.never,
      getShellSnapshot: (input) =>
        Ref.update(reads, (all) => [...all, input?.unsettledOnly]).pipe(
          Effect.as({
            schemaVersion: 2,
            snapshotSequence: 7,
            threads: input?.unsettledOnly
              ? options.threads.filter(
                  (candidate) =>
                    candidate.settledAt === null && candidate.settledOverride !== "settled",
                )
              : options.threads,
            archivedThreads: [],
          }),
        ),
      dispatch: (command) =>
        Ref.update(commands, (all) =>
          command.type === "thread.pull-request.sync" ? [...all, command] : all,
        ).pipe(Effect.as({ sequence: 8, storedEvents: [] })),
    }),
    // The store knows nothing about Stave; the decorator attaches the manifest.
    Layer.mock(ProjectStore.ProjectStoreV2)({
      listShells: () => Effect.succeed([plainShell]),
      getShell: () => Effect.succeed(Option.some(plainShell)),
    }),
    Layer.mock(StaveProjectShells)({
      decorate: (shells) =>
        Effect.succeed(shells.map((shell) => (stave === undefined ? shell : { ...shell, stave }))),
    }),
    Layer.mock(GitManager)({
      branchPullRequest: (input, lookup) =>
        Ref.update(branchCalls, (all) => [...all, { cwd: input.cwd, branch: input.branch }]).pipe(
          Effect.andThen(options.branchPullRequest(input, lookup)),
        ),
      localStatus: (input) =>
        Ref.update(localCalls, (all) => [...all, input.cwd]).pipe(
          Effect.andThen(options.localStatus?.(input) ?? Effect.succeed(localStatus("feature"))),
        ),
      invalidateLocalStatus: (cwd) => Ref.update(invalidations, (all) => [...all, cwd]),
    }),
    Layer.mock(PullRequestService)({
      summary: (input, summaryOptions) =>
        Ref.update(summaryCalls, (count) => count + 1).pipe(
          Effect.andThen(
            options.summary?.(input, summaryOptions) ?? Effect.succeed(summary(input, "open")),
          ),
        ),
    }),
    Layer.mock(RepositoryIdentityResolver)({
      resolve:
        options.resolveRepositoryIdentity ??
        ((root) => Effect.succeed({ ...identity, rootPath: root })),
    }),
    Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size).fill(1),
        digest: (_algorithm, data) => Effect.succeed(data),
      }),
    ),
    FileSystem.layerNoop({
      exists: (path) => Effect.succeed(options.existing.includes(path)),
    }),
  );
  yield* Effect.gen(function* () {
    const service = yield* ThreadPullRequestService.make;
    yield* service.start();
    // The startup backfill is enqueued by a forked root; wait for its read.
    while ((yield* Ref.get(reads)).length === 0) yield* Effect.yieldNow;
    yield* service.drain;
  }).pipe(Effect.provide(dependencies));
  return {
    commands: yield* Ref.get(commands),
    branchCalls: yield* Ref.get(branchCalls),
    localCalls: yield* Ref.get(localCalls),
    invalidations: yield* Ref.get(invalidations),
    summaryCalls: yield* Ref.get(summaryCalls),
    reads: yield* Ref.get(reads),
  };
});

describe("ThreadPullRequestServiceV2 Stave spaces", () => {
  it.effect("discovers the Stave primary checkout while preserving a secondary host link", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const primaryIdentity = {
          ...identity,
          canonicalKey: `github.enterprise.test/${REPOSITORY}`,
          rootPath: "/workspace/project/repo",
        };
        const project: OrchestrationProjectShell = {
          ...staveProject,
          stave: {
            ...staveProject.stave!,
            repos: [{ name: "repo", path: "repo", mode: "edit" }],
            primaryRepositoryIdentity: primaryIdentity,
          },
        };
        const manualLink = {
          ...reference(1),
          repository: "owner/secondary",
          host: "other.enterprise.test",
          url: "https://other.enterprise.test/owner/secondary/pull/1",
        };
        const result = yield* run({
          project,
          existing: [primaryIdentity.rootPath],
          threads: [
            thread("stave", { linkedPullRequest: manualLink }),
            thread("primary", {
              linkedPullRequest: {
                ...reference(2),
                host: "github.enterprise.test",
                url: `https://github.enterprise.test/${REPOSITORY}/pull/2`,
              },
            }),
          ],
          branchPullRequest: () =>
            Effect.succeed({
              ...branchPullRequest(),
              repositoryKey: primaryIdentity.canonicalKey,
              url: `https://github.enterprise.test/${REPOSITORY}/pull/42`,
            }),
          resolveRepositoryIdentity: () => Effect.succeed(primaryIdentity),
          summary: (input) =>
            input.repository === REPOSITORY
              ? Effect.succeed(summary(input, "merged"))
              : Effect.die("primary discovery must not replace the secondary link"),
        });
        const [first, second] = result.commands;
        expect(first?.branchPullRequest).toEqual({
          ...reference(42),
          host: "github.enterprise.test",
          url: `https://github.enterprise.test/${REPOSITORY}/pull/42`,
        });
        expect(first).not.toHaveProperty("linkedPullRequest");
        expect(second?.linkedPullRequest).toEqual(first?.branchPullRequest);
        expect(result.summaryCalls).toBe(1);
        expect(result.branchCalls.every((call) => call.cwd === primaryIdentity.rootPath)).toBe(
          true,
        );
      }),
    ),
  );

  it.effect(
    "follows live Stave HEAD for null and stale saved branches, with references alongside one edit",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* run({
            project: {
              ...staveProject,
              stave: {
                ...staveProject.stave!,
                repos: [
                  ...staveProject.stave!.repos,
                  { name: "reference", path: "reference", mode: "reference" },
                ],
              },
            },
            existing: ["/workspace/project/repo"],
            threads: [
              thread("branchless", { branch: null }),
              thread("stale", { branch: "thread-old", worktreePath: "/workspace/stale" }),
              thread("archived", { branch: null, archivedAt: NOW }),
            ],
            localStatus: () => Effect.succeed(localStatus("live-head")),
            branchPullRequest: ({ branch }) =>
              branch === "live-head"
                ? Effect.succeed({ ...branchPullRequest(), headRef: branch })
                : Effect.die(`Unexpected saved branch lookup: ${branch}`),
          });
          expect(result.commands.map((command) => command.threadId)).toEqual([
            "branchless",
            "stale",
          ]);
          expect(result.commands.map((command) => command.expected.branch)).toEqual([
            null,
            "thread-old",
          ]);
          expect(result.commands[1]?.expected.worktreePath).toBe("/workspace/stale");
          expect(result.commands.map((command) => command.branchPullRequest)).toEqual([
            { ...reference(42), host: "github.com" },
            { ...reference(42), host: "github.com" },
          ]);
          expect(result.branchCalls.every((call) => call.cwd === "/workspace/project/repo")).toBe(
            true,
          );
          expect(result.localCalls.every((cwd) => cwd === "/workspace/project/repo")).toBe(true);
          expect(result.invalidations).toEqual(result.localCalls);
        }),
      ),
  );

  it.effect(
    "drops inferred links from settled threads of a space without a sole edit checkout",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const settledAt = NOW;
          const result = yield* run({
            project: {
              ...staveProject,
              stave: {
                ...staveProject.stave!,
                repos: [
                  { name: "repo", path: "repo", mode: "edit" },
                  { name: "other", path: "other", mode: "edit" },
                ],
              },
            },
            existing: ["/workspace/project/repo", "/workspace/project/other"],
            threads: [
              thread("settled", {
                branch: null,
                settledAt,
                branchPullRequest: { ...reference(7), host: "github.com" },
              }),
            ],
            branchPullRequest: () => Effect.die("no checkout owns this space's PRs"),
          });
          // Every periodic read includes settled threads while such a space exists.
          expect(result.reads.every((unsettledOnly) => unsettledOnly === false)).toBe(true);
          expect(
            result.commands.map((command) => [command.threadId, command.branchPullRequest]),
          ).toEqual([["settled", null]]);
        }),
      ),
  );

  it.effect("does not discover an ordinary project PR without a saved branch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const result = yield* run({
          project: plainProject,
          existing: [],
          threads: [thread("ordinary-null", { branch: null })],
          localStatus: () => Effect.die("ordinary branchless threads must not read HEAD"),
          branchPullRequest: () => Effect.die("ordinary branchless threads must not discover PRs"),
        });
        expect(result.commands).toEqual([]);
      }),
    ),
  );
});

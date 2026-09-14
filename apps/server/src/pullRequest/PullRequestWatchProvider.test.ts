import { VcsDriverRegistry } from "../vcs/VcsDriverRegistry.ts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option, Path } from "effect";
import {
  type ProjectId,
  type OrchestrationProjectShell,
  type RepositoryIdentity,
  type StaveProjectInfo,
  type StaveRepoEntry,
} from "@lecturn/contracts";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { StaveWorkspaceReader } from "../stave/StaveWorkspaceReader.ts";
import * as SourceControlRateLimit from "../sourceControl/SourceControlRateLimit.ts";
import {
  PullRequestProviderError,
  type ProviderAcceptanceEvidence,
  type ProviderChangeRequestDetail,
  type PullRequestProviderApi,
} from "./PullRequestProvider.ts";
import { PullRequestProviderRegistry, fromProviders } from "./PullRequestProviderRegistry.ts";
import { PullRequestService } from "./PullRequestService.ts";
import * as WatchProvider from "./PullRequestWatchProvider.ts";

const createdAt = "2026-09-01T00:00:00Z";
const identity = (repository: string, host = "github.com"): RepositoryIdentity => ({
  canonicalKey: `${host}/${repository}`,
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: `https://${host}/${repository}.git`,
  },
  provider: "github",
  displayName: repository,
});
const repo = (name: string, mode: "edit" | "reference" = "edit"): StaveRepoEntry => ({
  name,
  mode,
  path: name,
  repositoryIdentity: identity(`acme/${name}`),
});
const manifest = (repos: readonly StaveRepoEntry[]): StaveProjectInfo => ({
  spaceId: "task",
  createdAt,
  isSaga: false,
  repos,
  memories: [],
  state: "live",
});
const project = (stave?: StaveProjectInfo): OrchestrationProjectShell => ({
  id: "p1" as ProjectId,
  title: "Task",
  workspaceRoot: "/spaces/task",
  repositoryIdentity: identity("acme/web"),
  defaultModelSelection: null,
  scripts: [],
  createdAt,
  updatedAt: createdAt,
  ...(stave ? { stave } : {}),
});
const detail = (
  overrides: Partial<ProviderChangeRequestDetail> = {},
): ProviderChangeRequestDetail => ({
  number: 42,
  title: "Fresh pull request",
  url: "https://github.com/acme/api/pull/42",
  author: null,
  headBranch: "feature",
  baseBranch: "main",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  createdAt,
  updatedAt: createdAt,
  reviewRequestLogins: [],
  labels: [],
  body: "",
  changedFiles: 1,
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  checks: [],
  autoMergeEnabled: false,
  mergeCapabilities: { merge: true, squash: true, rebase: true },
  viewerPermissions: {
    actions: ["merge", "enable-auto-merge"],
    comment: true,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
  ...overrides,
});
const evidence: ProviderAcceptanceEvidence = {
  headRevision: "head-a",
  baseRevision: "base-a",
  requiredChecks: "passing",
  checksRevision: "head-a",
  merged: false,
  mergedSourceRevision: null,
  blockers: [],
};
const provider = (overrides: Partial<PullRequestProviderApi> = {}): PullRequestProviderApi => ({
  kind: "github",
  capabilities: {
    diff: false,
    comment: false,
    actions: ["merge", "enable-auto-merge"],
    mergeMethods: ["squash"],
    search: false,
    reactions: false,
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
    edit: { changeRequest: false, comment: false },
  },
  getViewer: () => Effect.die("Unexpected viewer read"),
  listChangeRequests: () => Effect.die("Unexpected list read"),
  getChangeRequest: () => Effect.succeed(detail()),
  getChangeRequestActivity: () => Effect.die("Unexpected activity read"),
  getViewerPermissions: () => Effect.die("Unexpected permission read"),
  listReviewerCandidates: () => Effect.die("Unexpected reviewer read"),
  setReviewerRequest: () => Effect.die("Unexpected reviewer request"),
  getDiff: () => Effect.die("Unexpected diff read"),
  runAction: () => Effect.die("Watch writes must use PullRequestService"),
  comment: () => Effect.die("Unexpected comment"),
  submitReview: () => Effect.die("Unexpected review"),
  replyToThread: () => Effect.die("Unexpected reply"),
  setReaction: () => Effect.die("Unexpected reaction"),
  setThreadResolution: () => Effect.die("Unexpected resolution"),
  ...overrides,
});

function make(input: {
  project?: OrchestrationProjectShell;
  vcs?: VcsDriverRegistry["Service"];
  missingProject?: boolean;
  provider?: PullRequestProviderApi;
  load?: StaveWorkspaceReader["Service"]["load"];
  invalidate?: StaveWorkspaceReader["Service"]["invalidate"];
  runAction?: PullRequestService["Service"]["runAction"];
}) {
  const shell = input.project ?? project();
  return WatchProvider.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        input.vcs ? Layer.succeed(VcsDriverRegistry, input.vcs) : Layer.empty,
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShellById: () =>
            Effect.succeed(input.missingProject ? Option.none() : Option.some(shell)),
        }),
        Layer.succeed(PullRequestProviderRegistry, fromProviders([input.provider ?? provider()])),
        Layer.mock(PullRequestService)({
          runAction: input.runAction ?? (() => Effect.die("Unexpected mutation")),
        }),
        Layer.succeed(StaveWorkspaceReader, {
          load:
            input.load ??
            (() => Effect.succeed(shell.stave ? Option.some(shell.stave) : Option.none())),
          invalidate: input.invalidate ?? (() => Effect.void),
          invalidateAll: () => Effect.void,
        }),
        SourceControlRateLimit.layer,
        Path.layer,
      ),
    ),
  );
}
const reference = { projectId: "p1" as ProjectId, repository: "acme/api", number: 42 };

it.effect("observes a secondary editable repository from the freshly reread manifest", () =>
  Effect.gen(function* () {
    const reads: unknown[] = [];
    let invalidated = false;
    const freshManifest = manifest([repo("web"), { ...repo("api"), path: "services/api" }]);
    const service = yield* make({
      project: project(freshManifest),
      invalidate: () =>
        Effect.sync(() => {
          invalidated = true;
        }),
      load: () =>
        Effect.sync(() => {
          assert.isTrue(invalidated);
          return Option.some(freshManifest);
        }),
      provider: provider({
        getChangeRequest: (input) =>
          Effect.sync(() => {
            reads.push(input);
            return detail();
          }),
      }),
    });
    const result = yield* service.observe(reference);
    assert.deepStrictEqual(reads, [
      { cwd: "/spaces/task/services/api", host: "github.com", repository: "acme/api", number: 42 },
    ]);
    assert.deepStrictEqual(result.reference, { ...reference, host: "github.com" });
    assert.strictEqual(result.observation.title, "Fresh pull request");
  }),
);

it.effect("excludes references including a reference alias of an editable checkout", () =>
  Effect.gen(function* () {
    for (const repos of [
      [repo("web"), repo("api", "reference")],
      [repo("api"), { ...repo("context", "reference"), path: "api" }],
    ]) {
      const service = yield* make({
        project: project(manifest(repos)),
        provider: provider({
          getChangeRequest: () => Effect.die("Must refuse reference before provider read"),
        }),
      });
      assert.strictEqual((yield* Effect.flip(service.observe(reference))).code, "invalid");
    }
  }),
);

it.effect("refuses missing, archived, or recreated manifests before reading the provider", () =>
  Effect.gen(function* () {
    for (const current of [
      Option.none<StaveProjectInfo>(),
      Option.some({ ...manifest([repo("api")]), createdAt: "2026-09-02T00:00:00Z" }),
      Option.some({ ...manifest([repo("api")]), spaceId: "replacement" }),
      Option.some({ ...manifest([repo("api")]), state: "archived" as const }),
    ]) {
      const service = yield* make({
        project: project(manifest([repo("api")])),
        load: () => Effect.succeed(current),
        provider: provider({
          getChangeRequest: () => Effect.die("Must refuse stale manifest before provider read"),
        }),
      });
      const failure = yield* Effect.flip(service.observe(reference));
      assert.include(["conflict", "invalid"], failure.code);
    }
  }),
);

it.effect("refines an unknown provider from its public remote URL", () =>
  Effect.gen(function* () {
    const service = yield* make({
      project: {
        ...project(),
        repositoryIdentity: { ...identity("acme/api"), provider: "unknown" },
      },
    });
    assert.strictEqual((yield* service.observe(reference)).observation.provider, "github");
  }),
);

it.effect("refuses changed editable checkout paths until the projection catches up", () =>
  Effect.gen(function* () {
    const service = yield* make({
      project: project(manifest([repo("api")])),
      load: () =>
        Effect.succeed(Option.some(manifest([{ ...repo("api"), path: "replacement/api" }]))),
      provider: provider({
        getChangeRequest: () => Effect.die("Must refuse a changed routing target"),
      }),
    });
    assert.strictEqual((yield* Effect.flip(service.observe(reference))).code, "conflict");
  }),
);

it.effect("requires a host when matching repository names exist on different hosts", () =>
  Effect.gen(function* () {
    const reads: string[] = [];
    const service = yield* make({
      project: project(
        manifest([
          repo("api"),
          { ...repo("private"), repositoryIdentity: identity("acme/api", "github.example.test") },
        ]),
      ),
      provider: provider({
        getChangeRequest: ({ host }) =>
          Effect.sync(() => {
            reads.push(host);
            return detail();
          }),
      }),
    });
    assert.strictEqual((yield* Effect.flip(service.observe(reference))).code, "invalid");
    yield* service.observe({ ...reference, host: "github.example.test" });
    assert.deepStrictEqual(reads, ["github.example.test"]);
  }),
);

it.effect("reads fresh revision evidence through the host rate limiter on every observation", () =>
  Effect.gen(function* () {
    let revision = "head-a";
    const evidenceReads: unknown[] = [];
    const service = yield* make({
      project: project(manifest([repo("api")])),
      provider: provider({
        readAcceptanceEvidence: (input) =>
          Effect.sync(() => {
            evidenceReads.push(input);
            return { ...evidence, headRevision: revision, checksRevision: revision };
          }),
      }),
    });
    assert.strictEqual((yield* service.observe(reference)).observation.headRevision, "head-a");
    revision = "head-b";
    const second = (yield* service.observe(reference)).observation;
    assert.strictEqual(second.headRevision, "head-b");
    assert.strictEqual(second.requiredChecks, "passing");
    assert.strictEqual(second.checksRevision, "head-b");
    assert.isTrue(second.supportsRevisionMerge);
    assert.deepStrictEqual(
      evidenceReads,
      Array.from({ length: 2 }, () => ({
        cwd: "/spaces/task/api",
        host: "github.com",
        repository: "acme/api",
        number: 42,
      })),
    );
  }),
);

it.effect("keeps required CI unknown when acceptance evidence is absent or fails", () =>
  Effect.gen(function* () {
    for (const api of [
      provider(),
      provider({
        readAcceptanceEvidence: () =>
          Effect.fail(
            new PullRequestProviderError({
              provider: "github",
              operation: "readAcceptanceEvidence",
              reason: "failed",
              detail: "Required checks unavailable",
            }),
          ),
      }),
    ]) {
      const service = yield* make({ project: project(manifest([repo("api")])), provider: api });
      const observed = (yield* service.observe(reference)).observation;
      assert.strictEqual(observed.requiredChecks, "unknown");
      assert.isNull(observed.headRevision);
      assert.isNull(observed.checksRevision);
    }
  }),
);

it.effect("blocks subsequent host reads after acceptance evidence reports rate limiting", () =>
  Effect.gen(function* () {
    let reads = 0;
    const service = yield* make({
      project: project(manifest([repo("api")])),
      provider: provider({
        getChangeRequest: () =>
          Effect.sync(() => {
            reads += 1;
            return detail();
          }),
        readAcceptanceEvidence: () =>
          Effect.fail(
            new PullRequestProviderError({
              provider: "github",
              operation: "readAcceptanceEvidence",
              reason: "rate-limited",
              detail: "Slow down",
            }),
          ),
      }),
    });
    assert.strictEqual((yield* service.observe(reference)).observation.requiredChecks, "unknown");
    assert.strictEqual((yield* Effect.flip(service.observe(reference))).code, "unavailable");
    assert.strictEqual(reads, 1);
  }),
);

it.effect("requires viewer merge permission and a non-draft mergeable pull request", () =>
  Effect.gen(function* () {
    for (const current of [
      detail({ isDraft: true }),
      detail({ mergeability: "conflicting" }),
      detail({ viewerPermissions: { ...detail().viewerPermissions, actions: [] } }),
    ]) {
      const service = yield* make({
        project: project(manifest([repo("api")])),
        provider: provider({ getChangeRequest: () => Effect.succeed(current) }),
      });
      assert.isFalse((yield* service.observe(reference)).observation.mergeable);
    }
    const allowed = yield* make({ project: project(manifest([repo("api")])) });
    assert.isTrue((yield* allowed.observe(reference)).observation.mergeable);
  }),
);

it.effect("reports auto-merge support only when both host and viewer allow it", () =>
  Effect.gen(function* () {
    for (const api of [
      provider({ capabilities: { ...provider().capabilities, actions: ["merge"] } }),
      provider({
        getChangeRequest: () =>
          Effect.succeed(
            detail({ viewerPermissions: { ...detail().viewerPermissions, actions: ["merge"] } }),
          ),
      }),
    ]) {
      const service = yield* make({ project: project(manifest([repo("api")])), provider: api });
      assert.isFalse((yield* service.observe(reference)).observation.supportsAutoMerge);
    }
  }),
);

it.effect(
  "preserves revision preconditions when delegating a merge to the existing PR service",
  () =>
    Effect.gen(function* () {
      const writes: unknown[] = [];
      const service = yield* make({
        project: project(manifest([repo("api")])),
        runAction: (input) =>
          Effect.sync(() => {
            writes.push(input);
          }),
      });
      const input = {
        ...reference,
        host: "github.com",
        action: "merge" as const,
        mergeMethod: "squash" as const,
        expectedHeadRevision: "head-a",
      };
      yield* service.runAction(input);
      assert.deepStrictEqual(writes, [input]);
    }),
);

it.effect("refuses a stale binding or target branch before delegating an authorized action", () =>
  Effect.gen(function* () {
    let writes = 0;
    const service = yield* make({
      project: project(manifest([repo("api")])),
      runAction: () =>
        Effect.sync(() => {
          writes += 1;
        }),
    });
    const fresh = yield* service.observe(reference);
    for (const precondition of [
      { expectedBinding: "previous-incarnation", expectedBaseBranch: "main" },
      { expectedBinding: fresh.binding, expectedBaseBranch: "release" },
    ]) {
      const failure = yield* Effect.flip(
        service.runAction({ ...reference, action: "enable-auto-merge", ...precondition }),
      );
      assert.strictEqual(failure.code, "conflict");
    }
    assert.strictEqual(writes, 0);
    yield* service.runAction({
      ...reference,
      action: "enable-auto-merge",
      expectedBinding: fresh.binding,
      expectedBaseBranch: "main",
    });
    assert.strictEqual(writes, 1);
  }),
);

it.effect(
  "rereads the incarnation immediately before an action instead of trusting an earlier observation",
  () =>
    Effect.gen(function* () {
      let current = manifest([repo("api")]);
      const service = yield* make({
        project: project(current),
        load: () => Effect.sync(() => Option.some(current)),
        runAction: () => Effect.die("Must not delegate after recreation"),
      });
      const fresh = yield* service.observe(reference);
      current = { ...current, createdAt: "2026-09-02T00:00:00Z" };
      const failure = yield* Effect.flip(
        service.runAction({
          ...reference,
          action: "merge",
          expectedBinding: fresh.binding,
          expectedBaseBranch: "main",
          expectedHeadRevision: "head-a",
        }),
      );
      assert.strictEqual(failure.code, "conflict");
    }),
);

it.effect(
  "watches the fork remote of a secondary Stave checkout without changing upstream grouping",
  () =>
    Effect.gen(function* () {
      const shell = project(manifest([repo("web"), repo("api"), repo("docs", "reference")]));
      const reads: unknown[] = [];
      const service = yield* make({
        project: shell,
        vcs: {
          resolve: ({ cwd }: { cwd: string }) =>
            Effect.succeed({
              driver: {
                listRemotes: () =>
                  Effect.succeed({
                    remotes: [
                      {
                        name: "upstream",
                        url: `https://github.com/acme/${cwd.split("/").at(-1)}.git`,
                      },
                      {
                        name: "origin",
                        url: `https://github.com/mine/${cwd.split("/").at(-1)}.git`,
                      },
                    ],
                  }),
              },
            }),
        } as unknown as VcsDriverRegistry["Service"],
        provider: provider({
          getChangeRequest: (input) =>
            Effect.sync(() => {
              reads.push(input);
              return detail();
            }),
        }),
      });
      const observed = yield* service.observe({ ...reference, repository: "mine/api" });
      assert.equal(observed.reference.repository, "mine/api");
      assert.include(observed.binding, "github.com/mine/api");
      assert.deepEqual(reads, [
        { cwd: "/spaces/task/api", host: "github.com", repository: "mine/api", number: 42 },
      ]);
      const denied = yield* service
        .observe({ ...reference, repository: "mine/docs" })
        .pipe(Effect.result);
      assert.equal(denied._tag, "Failure");
      assert.equal(reads.length, 1);
      assert.equal(shell.stave!.repos[1]!.repositoryIdentity!.displayName, "acme/api");
    }),
);

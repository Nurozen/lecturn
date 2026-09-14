import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option, Path, Result } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  ProjectId,
  ThreadId,
  PullRequestWatchError,
  type OrchestrationThreadShell,
  type OrchestrationProjectShell,
  type PullRequestActionInput,
  type PullRequestWatchObservation,
  type PullRequestListEntry,
} from "@lecturn/contracts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PullRequestWatchProvider } from "./PullRequestWatchProvider.ts";
import { projectContainsWatch } from "./PullRequestWatchPolicy.ts";
import { make, PullRequestWatchService } from "./PullRequestWatchService.ts";
import { make as makeDiscovery } from "./PullRequestWatchDiscovery.ts";
import { PullRequestService } from "./PullRequestService.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { StaveRpcRuntime } from "../stave/staveRpcHandlers.ts";
const projectId = ProjectId.make("watch-project");
const head = "a".repeat(40);
const reference = { projectId, repository: "owner/repo", host: "github.com", number: 1 };
const initial: PullRequestWatchObservation = {
  provider: "github",
  title: "Watched PR",
  url: "https://github.com/owner/repo/pull/1",
  state: "open",
  headRevision: head,
  baseBranch: "main",
  reviewDecision: null,
  checks: [],
  checksState: "pending",
  requiredChecks: "pending",
  checksRevision: head,
  mergeable: true,
  autoMergeEnabled: false,
  supportsAutoMerge: true,
  supportsRevisionMerge: true,
  observedAt: "2026-09-13T00:00:00.000Z",
};
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM pull_request_watches`;
  yield* sql`DELETE FROM pull_request_watch_receipts`;
  yield* sql`UPDATE pull_request_watch_settings SET mode = 'follow-pr' WHERE id = 1`;
  let observation = { ...initial };
  let binding = "original";
  let observedReference = reference;
  let failRead = false;
  let failAfterWrite = false;
  let failDisable = false;
  const actions: PullRequestActionInput[] = [];
  const threads: OrchestrationThreadShell[] = [];
  const projects: OrchestrationProjectShell[] = [];
  const provider = Layer.succeed(PullRequestWatchProvider, {
    observe: () =>
      Effect.suspend(() =>
        failRead
          ? Effect.fail(new PullRequestWatchError({ code: "unavailable", message: "Read failed" }))
          : Effect.succeed({
              reference: observedReference,
              binding,
              observation: { ...observation },
            }),
      ),
    runAction: (input) =>
      Effect.gen(function* () {
        actions.push(input);
        if (input.action === "enable-auto-merge") observation.autoMergeEnabled = true;
        if (input.action === "disable-auto-merge") {
          if (failDisable)
            return yield* new PullRequestWatchError({
              code: "unavailable",
              message: "Disable failed",
            });
          observation.autoMergeEnabled = false;
        }
        if (input.action === "merge") observation.state = "merged";
        if (failAfterWrite) {
          failAfterWrite = false;
          return yield* new PullRequestWatchError({
            code: "unavailable",
            message: "Lost response",
          });
        }
      }),
  });
  const projections = Layer.succeed(ProjectionSnapshotQuery, {
    getThreadShellById: (id: ThreadId) =>
      Effect.sync(() => Option.fromNullishOr(threads.find((thread) => thread.id === id))),
    getShellSnapshot: () =>
      Effect.sync(() => ({
        threads,
        projects,
        snapshotSequence: 0,
        updatedAt: initial.observedAt,
      })),
  } as unknown as ProjectionSnapshotQuery["Service"]);
  const build = make.pipe(Effect.provide(Layer.merge(provider, projections)));
  const service = yield* build;
  return {
    service,
    restart: build,
    projections,
    actions,
    threads,
    projects,
    change: (value: Partial<PullRequestWatchObservation>) => {
      observation = { ...observation, ...value };
    },
    bind: (value: string) => {
      binding = value;
    },
    changeReference: (value: typeof reference) => {
      observedReference = value;
    },
    readsFail: (value: boolean) => {
      failRead = value;
    },
    loseWriteResponse: () => {
      failAfterWrite = true;
    },
    disableFails: (value: boolean) => {
      failDisable = value;
    },
  };
});
const tracked = Effect.fn(function* () {
  const f = yield* fixture;
  const watch = yield* f.service.track({ requestId: "track", reference }, "user");
  return { ...f, watch };
});

it.layer(SqlitePersistenceMemory)("durable PR watch", (it) => {
  it.effect(
    "runtime rosters resolve duplicate saga names and reject replaced member incarnations",
    () =>
      Effect.gen(function* () {
        const f = yield* tracked();
        const member = {
          id: projectId,
          workspaceRoot: "/member",
          title: "Member",
          scripts: [],
          defaultModelSelection: null,
          createdAt: initial.observedAt,
          updatedAt: initial.observedAt,
          stave: {
            spaceId: "member",
            createdAt: initial.observedAt,
            state: "live",
            isSaga: false,
            repos: [],
            memories: [],
            memberOf: "shared-name",
          },
        } as OrchestrationProjectShell;
        const saga = {
          ...member,
          id: ProjectId.make("saga"),
          workspaceRoot: "/saga",
          stave: {
            isSaga: true,
            spaceId: "shared-name",
            state: "live" as const,
            repos: [],
            memories: [],
            createdAt: initial.observedAt,
          },
        };
        const duplicate = {
          ...saga,
          id: ProjectId.make("duplicate-saga"),
          workspaceRoot: "/other-saga",
        };
        f.projects.push(member, saga, duplicate);
        const managerId = ThreadId.make("roster-manager");
        f.threads.push({
          id: managerId,
          projectId: saga.id,
          session: { status: "running" },
        } as OrchestrationThreadShell);
        let memberCreatedAt = initial.observedAt;
        const service = yield* f.restart.pipe(
          Effect.provide(
            Layer.mock(StaveRpcRuntime)({
              sagaStatus: (root) =>
                Effect.succeed({
                  sagaId: "shared-name",
                  sagaCreatedAt: initial.observedAt,
                  notes: [],
                  members:
                    root === saga.workspaceRoot
                      ? [
                          {
                            id: "member",
                            workspaceRoot: "/member",
                            createdAt: memberCreatedAt,
                            after: [],
                            state: "live",
                            dirty: false,
                            repos: [],
                            prs: [],
                          },
                        ]
                      : [],
                }),
            }),
          ),
        );
        assert.equal(
          (yield* service.command(
            {
              requestId: "roster-manager",
              watchId: f.watch.id,
              action: "set-manager",
              managerThreadId: managerId,
            },
            "user",
          )).managerStatus,
          "working",
        );
        memberCreatedAt = "2026-09-14T00:00:00.000Z";
        assert.equal((yield* service.list({})).watches[0]!.managerStatus, "offline");
        assert.isTrue(
          Result.isFailure(
            yield* Effect.result(
              service.track(
                { requestId: "stale-roster-association", reference, threadId: managerId },
                "user",
              ),
            ),
          ),
        );
      }),
  );
  it.effect(
    "checkout aliases cannot associate with or manage a different repository in the space",
    () =>
      Effect.gen(function* () {
        const f = yield* tracked();
        const identity = (name: string) => ({
          canonicalKey: `github.com/owner/${name}`,
          displayName: `owner/${name}`,
          provider: "github",
          locator: {
            source: "git-remote" as const,
            remoteName: "origin",
            remoteUrl: `https://github.com/owner/${name}.git`,
          },
        });
        const member = {
          id: projectId,
          title: "Space",
          scripts: [],
          defaultModelSelection: null,
          createdAt: initial.observedAt,
          updatedAt: initial.observedAt,
          workspaceRoot: "/space",
          stave: {
            spaceId: "space",
            isSaga: false,
            memories: [],
            createdAt: initial.observedAt,
            state: "live",
            repos: ["repo", "other"].map((name) => ({
              name,
              mode: "edit",
              path: name,
              resolvedPath: `/space/${name}`,
              repositoryIdentity: identity(name),
            })),
          },
        } as OrchestrationProjectShell;
        const alias = {
          id: ProjectId.make("alias"),
          workspaceRoot: "/space/repo",
          repositoryIdentity: identity("repo"),
        } as OrchestrationProjectShell;
        const managerId = ThreadId.make("alias-thread");
        const manager = {
          id: managerId,
          projectId: alias.id,
          worktreePath: null,
          session: { status: "running" },
        } as OrchestrationThreadShell;
        f.projects.push(member, alias);
        f.threads.push(manager);
        const own = yield* f.service.command(
          {
            requestId: "own-manager",
            watchId: f.watch.id,
            action: "set-manager",
            managerThreadId: managerId,
          },
          "user",
        );
        assert.equal(own.managerThreadId, managerId);
        assert.equal(own.managerStatus, "working");
        const otherReference = { ...reference, repository: "owner/other" };
        f.changeReference(otherReference);
        const other = yield* f.service.track(
          { requestId: "other", reference: otherReference },
          "user",
        );
        assert.isTrue(
          Result.isFailure(
            yield* Effect.result(
              f.service.track(
                { requestId: "wrong-association", reference: otherReference, threadId: managerId },
                "user",
              ),
            ),
          ),
        );
        assert.isTrue(
          Result.isFailure(
            yield* Effect.result(
              f.service.command(
                {
                  requestId: "wrong-manager",
                  watchId: other.id,
                  action: "set-manager",
                  managerThreadId: managerId,
                },
                "user",
              ),
            ),
          ),
        );
        // Existing management also becomes unavailable if the alias changes repository.
        f.projects[1] = {
          ...alias,
          workspaceRoot: "/space/other",
          repositoryIdentity: identity("other"),
        };
        assert.equal(
          (yield* f.service.list({})).watches.find((watch) => watch.id === own.id)!.managerStatus,
          "offline",
        );
        f.projects[1] = alias;
        f.threads[0] = {
          ...manager,
          linkedPullRequest: { ...otherReference, url: "https://github.com/owner/other/pull/1" },
        };
        yield* f.service.tick;
        assert.deepEqual(
          (yield* f.service.list({})).watches.find((watch) => watch.id === other.id)!.threadIds,
          [],
        );
      }),
  );
  it.effect(
    "persists watch, settings and receipts across reconstruction and projection reset",
    () =>
      Effect.gen(function* () {
        const f = yield* tracked();
        yield* f.service.configure({ defaultMergeMode: "revision-only" });
        const restarted = yield* f.restart;
        assert.equal((yield* restarted.list({})).defaultMergeMode, "revision-only");
        assert.equal(
          (yield* restarted.track({ requestId: "track", reference }, "user")).id,
          f.watch.id,
        );
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM projection_state`;
        assert.equal((yield* restarted.list({})).watches.length, 1);
        const conflict = yield* restarted
          .track({ requestId: "track", reference: { ...reference, number: 2 } }, "user")
          .pipe(Effect.result);
        assert.equal(Result.isFailure(conflict) && conflict.failure.code, "conflict");
      }),
  );

  it.effect(
    "follow-pr follows fresh heads without native auto-merge and atomically merges after checks",
    () =>
      Effect.gen(function* () {
        const f = yield* tracked();
        const auth = yield* f.service.command(
          { requestId: "auth", watchId: f.watch.id, action: "authorize-merge" },
          "user",
        );
        assert.equal(auth.authorization?.mode, "follow-pr");
        assert.equal(auth.authorization?.status, "waiting");
        assert.equal(f.actions.length, 0);
        const nextHead = "b".repeat(40);
        f.change({ headRevision: nextHead, checksRevision: nextHead, requiredChecks: "passing" });
        const restarted = yield* f.restart;
        yield* restarted.tick;
        assert.equal(f.actions.length, 1);
        assert.equal(f.actions[0]?.action, "merge");
        assert.equal(f.actions[0]?.expectedHeadRevision, nextHead);
        assert.equal((yield* restarted.list({})).watches[0]?.authorization?.status, "merged");
      }),
  );

  it.effect(
    "revision-only blocks unknown or stale check facts and requires a pinned atomic head",
    () =>
      Effect.gen(function* () {
        const f = yield* tracked();
        f.change({ requiredChecks: "unknown" });
        const authorized = yield* f.service.command(
          {
            requestId: "revision",
            watchId: f.watch.id,
            action: "authorize-merge",
            mergeMode: "revision-only",
            expectedHeadRevision: head,
          },
          "user",
        );
        assert.equal(authorized.authorization?.status, "blocked");
        f.change({ requiredChecks: "passing", checksRevision: "b".repeat(40) });
        yield* f.service.tick;
        assert.equal(f.actions.length, 0);
        f.change({ checksRevision: head });
        f.readsFail(true);
        yield* f.service.tick;
        assert.equal((yield* f.service.list({})).watches[0]?.error, "Read failed");
        assert.equal(f.actions.length, 0);
        f.readsFail(false);
        yield* f.service.tick;
        assert.equal(f.actions[0]?.expectedHeadRevision, head);
        assert.equal((yield* f.service.list({})).watches[0]?.authorization?.status, "merged");
      }),
  );

  it.effect("lost merge responses reconcile on restart without replaying the external write", () =>
    Effect.gen(function* () {
      const f = yield* tracked();
      f.change({ requiredChecks: "passing" });
      f.loseWriteResponse();
      const input = { requestId: "merge", watchId: f.watch.id, action: "authorize-merge" as const };
      assert.isTrue(Result.isFailure(yield* f.service.command(input, "user").pipe(Effect.result)));
      const sql = yield* SqlClient.SqlClient;
      const receipts = yield* sql<{
        result_json: string | null;
      }>`SELECT result_json FROM pull_request_watch_receipts WHERE request_id = 'merge'`;
      assert.isNull(receipts[0]?.result_json);
      const restarted = yield* f.restart;
      assert.equal((yield* restarted.command(input, "user")).authorization?.status, "merged");
      assert.equal(f.actions.length, 1);
    }),
  );

  it.effect("both modes disable existing native auto-merge before taking responsibility", () =>
    Effect.gen(function* () {
      for (const mode of ["follow-pr", "revision-only"] as const) {
        const f = yield* tracked();
        f.change({ autoMergeEnabled: true });
        const watch = yield* f.service.command(
          {
            requestId: "auth",
            watchId: f.watch.id,
            action: "authorize-merge",
            mergeMode: mode,
            expectedHeadRevision: head,
          },
          "user",
        );
        assert.equal(watch.authorization?.status, "waiting");
        assert.deepEqual(
          f.actions.map((action) => action.action),
          ["disable-auto-merge"],
        );
        f.change({ requiredChecks: "passing" });
        yield* f.service.tick;
        assert.deepEqual(
          f.actions.map((action) => action.action),
          ["disable-auto-merge", "merge"],
        );
      }
    }),
  );

  it.effect(
    "pause persists revocation intent through failures and never reactivates after restart",
    () =>
      Effect.gen(function* () {
        const f = yield* tracked();
        yield* f.service.command(
          { requestId: "auth", watchId: f.watch.id, action: "authorize-merge" },
          "user",
        );
        f.change({ autoMergeEnabled: true });
        f.disableFails(true);
        const input = { requestId: "pause", watchId: f.watch.id, action: "pause" as const };
        assert.isTrue(
          Result.isFailure(yield* f.service.command(input, "user").pipe(Effect.result)),
        );
        assert.isFalse((yield* f.service.list({})).watches[0]!.watching);
        assert.isNull((yield* f.service.list({})).watches[0]!.authorization);
        f.disableFails(false);
        const restarted = yield* f.restart;
        yield* restarted.tick;
        const watch = yield* restarted.command(input, "user");
        assert.isFalse(watch.watching);
        assert.isFalse(watch.observation!.autoMergeEnabled!);
        assert.isFalse(f.actions.some((action) => action.action === "merge"));
      }),
  );

  it.effect(
    "base changes and revision-only head changes invalidate instead of silently carrying permission",
    () =>
      Effect.gen(function* () {
        for (const changed of [{ baseBranch: "release" }, { headRevision: "b".repeat(40) }]) {
          const f = yield* tracked();
          yield* f.service.command(
            {
              requestId: "auth",
              watchId: f.watch.id,
              action: "authorize-merge",
              mergeMode: "revision-only",
              expectedHeadRevision: head,
            },
            "user",
          );
          f.change({ ...changed, requiredChecks: "passing" });
          yield* f.service.tick;
          assert.equal(
            (yield* f.service.list({})).watches[0]?.authorization?.status,
            "needs-authorization",
          );
          assert.equal(f.actions.length, 0);
        }
        const f = yield* tracked();
        yield* f.service.command(
          { requestId: "auth", watchId: f.watch.id, action: "authorize-merge" },
          "user",
        );
        f.bind("new-incarnation");
        yield* f.service.tick;
        assert.isFalse((yield* f.service.list({})).watches[0]!.watching);
        const conflict = yield* f.service
          .command(
            { requestId: "new-auth", watchId: f.watch.id, action: "authorize-merge" },
            "user",
          )
          .pipe(Effect.result);
        assert.equal(Result.isFailure(conflict) && conflict.failure.code, "conflict");
        assert.equal(f.actions.length, 0);
      }),
  );

  it.effect("follow-pr confirmation fences initial head, base and binding", () =>
    Effect.gen(function* () {
      const f = yield* tracked();
      for (const [index, expectation] of [
        { expectedHeadRevision: "b".repeat(40) },
        { expectedBaseBranch: "other-base" },
        { expectedBinding: "other-incarnation" },
      ].entries()) {
        const result = yield* f.service
          .command(
            {
              requestId: `stale-${index}`,
              watchId: f.watch.id,
              action: "authorize-merge",
              mergeMode: "follow-pr",
              ...expectation,
            },
            "user",
          )
          .pipe(Effect.result);
        assert.equal(Result.isFailure(result) && result.failure.code, "conflict");
      }
      assert.equal(f.actions.length, 0);
    }),
  );

  it.effect(
    "concurrent duplicate commands perform one write and reject changed request payloads",
    () =>
      Effect.gen(function* () {
        const f = yield* tracked();
        f.change({ requiredChecks: "passing" });
        const input = {
          requestId: "concurrent",
          watchId: f.watch.id,
          action: "authorize-merge" as const,
        };
        const results = yield* Effect.all(
          [f.service.command(input, "user"), f.service.command(input, "user")],
          { concurrency: "unbounded" },
        );
        assert.equal(results[0].revision, results[1].revision);
        assert.equal(f.actions.length, 1);
        const changed = yield* f.service
          .command({ ...input, action: "pause" }, "user")
          .pipe(Effect.result);
        assert.equal(Result.isFailure(changed) && changed.failure.code, "conflict");
      }),
  );

  it.effect("unsupported atomic merge providers stay blocked without issuing review or merge", () =>
    Effect.gen(function* () {
      const f = yield* tracked();
      f.change({
        supportsRevisionMerge: false,
        supportsAutoMerge: true,
        requiredChecks: "passing",
      });
      const watch = yield* f.service.command(
        { requestId: "unsupported", watchId: f.watch.id, action: "authorize-merge" },
        "user",
      );
      assert.equal(watch.authorization?.status, "blocked");
      assert.equal(f.actions.length, 0);
    }),
  );

  it.effect(
    "linked and forked associations never transfer the manager, and chat shutdown leaves watch running",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const id = ThreadId.make("thread");
        f.threads.push({
          id,
          projectId,
          linkedPullRequest: { ...reference, url: initial.url },
          session: null,
        } as OrchestrationThreadShell);
        yield* f.service.tick;
        const watch = (yield* f.service.list({})).watches[0]!;
        assert.isNull(watch.managerThreadId);
        yield* f.service.command(
          { requestId: "manager", watchId: watch.id, action: "set-manager", managerThreadId: id },
          "user",
        );
        const forkId = ThreadId.make("fork");
        f.threads.push({
          ...f.threads[0]!,
          id: forkId,
          forkedFrom: { threadId: id },
        } as OrchestrationThreadShell);
        yield* f.service.tick;
        const updated = (yield* f.service.list({})).watches[0]!;
        assert.equal(updated.managerThreadId, id);
        assert.deepEqual(updated.threadIds, [id, forkId]);
        assert.equal(updated.managerStatus, "offline");
        assert.isTrue(updated.watching);
      }),
  );

  it.effect(
    "saga and exact checkout aliases grant scope but ambiguous names and incarnations do not",
    () =>
      Effect.gen(function* () {
        const f = yield* tracked();
        const sagaId = ProjectId.make("saga");
        const saga = {
          id: sagaId,
          workspaceRoot: "/saga",
          stave: {
            spaceId: "saga-name",
            isSaga: true,
            state: "live",
            createdAt: initial.observedAt,
          },
        } as OrchestrationProjectShell;
        const member = {
          title: "Member",
          scripts: [],
          defaultModelSelection: null,
          createdAt: initial.observedAt,
          updatedAt: initial.observedAt,
          id: projectId,
          workspaceRoot: "/member",
          stave: {
            spaceId: "member",
            repos: [],
            memories: [],
            isSaga: false,
            memberOf: "saga-name",
            state: "live",
            createdAt: initial.observedAt,
          },
        } as OrchestrationProjectShell;
        f.projects.push(saga, member);
        const managerId = ThreadId.make("saga-manager");
        f.threads.push({
          id: managerId,
          projectId: sagaId,
          session: null,
        } as OrchestrationThreadShell);
        assert.equal(
          (yield* f.service.command(
            {
              requestId: "saga-manager",
              watchId: f.watch.id,
              action: "set-manager",
              managerThreadId: managerId,
            },
            "user",
          )).managerThreadId,
          managerId,
        );
        f.projects.push({ ...saga, id: ProjectId.make("duplicate"), workspaceRoot: "/other-saga" });
        const rejected = yield* f.service
          .command(
            {
              requestId: "ambiguous",
              watchId: f.watch.id,
              action: "set-manager",
              managerThreadId: managerId,
            },
            "user",
          )
          .pipe(Effect.result);
        assert.equal(Result.isFailure(rejected) && rejected.failure.code, "invalid");
        assert.isFalse(
          projectContainsWatch(ProjectId.make("alias"), projectId, [
            member,
            {
              ...member,
              id: ProjectId.make("alias"),
              stave: { ...member.stave!, createdAt: "2026-09-14T00:00:00.000Z" },
            },
          ]),
        );
        assert.isTrue(
          projectContainsWatch(ProjectId.make("alias"), projectId, [
            member,
            { ...member, id: ProjectId.make("alias") },
          ]),
        );
        const identity = { canonicalKey: "repo" } as NonNullable<
          OrchestrationProjectShell["repositoryIdentity"]
        >;
        const alias = {
          id: ProjectId.make("checkout"),
          workspaceRoot: "/repo-cache",
          repositoryIdentity: identity,
        } as OrchestrationProjectShell;
        const nested = {
          ...member,
          stave: {
            ...member.stave!,
            repos: [
              {
                name: "repo",
                path: "repo",
                resolvedPath: "/member/repo",
                mode: "edit" as const,
                repositoryIdentity: identity,
              },
            ],
          },
        };
        assert.isTrue(projectContainsWatch(alias.id, member.id, [alias, nested], "/member/repo"));
        assert.isFalse(
          projectContainsWatch(
            alias.id,
            member.id,
            [
              alias,
              {
                ...nested,
                stave: {
                  ...nested.stave,
                  repos: [
                    ...nested.stave.repos,
                    {
                      name: "reference-alias",
                      path: "repo",
                      resolvedPath: "/member/repo",
                      mode: "reference",
                    },
                  ],
                },
              },
            ],
            "/member/repo",
          ),
        );
      }),
  );
  it.effect(
    "resume recovers a changed binding without inheriting authorization, manager or pending revocation",
    () =>
      Effect.gen(function* () {
        const f = yield* tracked();
        const manager = ThreadId.make("old-manager");
        f.threads.push({ id: manager, projectId, session: null } as OrchestrationThreadShell);
        yield* f.service.command(
          {
            requestId: "manager",
            watchId: f.watch.id,
            action: "set-manager",
            managerThreadId: manager,
          },
          "user",
        );
        yield* f.service.command(
          { requestId: "authorize", watchId: f.watch.id, action: "authorize-merge" },
          "user",
        );
        f.bind("new-incarnation");
        yield* f.service.tick;
        const failedRevoke = yield* f.service
          .command({ requestId: "revoke", watchId: f.watch.id, action: "revoke-merge" }, "user")
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(failedRevoke));
        const restarted = yield* f.restart;
        const recovered = yield* restarted.command(
          { requestId: "resume", watchId: f.watch.id, action: "resume" },
          "user",
        );
        assert.equal(recovered.binding, "new-incarnation");
        assert.isTrue(recovered.watching);
        assert.isNull(recovered.authorization);
        assert.isNull(recovered.managerThreadId);
        assert.deepEqual(recovered.threadIds, []);
        assert.isNull(recovered.error);
        f.change({ requiredChecks: "passing" });
        yield* restarted.tick;
        assert.equal(f.actions.length, 0);
        f.change({ autoMergeEnabled: true });
        yield* restarted.tick;
        assert.equal(f.actions.length, 0);
      }),
  );

  it.effect(
    "explicit retrack recovers the same PR after a binding failure and failed revocation",
    () =>
      Effect.gen(function* () {
        const f = yield* tracked();
        yield* f.service.command(
          { requestId: "authorize", watchId: f.watch.id, action: "authorize-merge" },
          "user",
        );
        f.bind("replacement");
        yield* f.service.tick;
        yield* f.service
          .command({ requestId: "revoke", watchId: f.watch.id, action: "revoke-merge" }, "user")
          .pipe(Effect.result);
        const recovered = yield* f.service.track({ requestId: "retrack", reference }, "user");
        assert.equal(recovered.id, f.watch.id);
        assert.equal(recovered.binding, "replacement");
        assert.isNull(recovered.authorization);
        assert.isTrue(recovered.watching);
        yield* f.service.tick;
        assert.equal(f.actions.length, 0);
      }),
  );

  it.effect(
    "binding recovery refuses enabled or unknown native automation and can retry the same resume",
    () =>
      Effect.gen(function* () {
        for (const autoMergeEnabled of [true, null]) {
          const f = yield* tracked();
          yield* f.service.command(
            { requestId: "authorize", watchId: f.watch.id, action: "authorize-merge" },
            "user",
          );
          f.bind("replacement");
          f.change({ autoMergeEnabled });
          const input = { requestId: "resume", watchId: f.watch.id, action: "resume" as const };
          const result = yield* f.service.command(input, "user").pipe(Effect.result);
          assert.equal(Result.isFailure(result) && result.failure.code, "conflict");
          assert.isTrue(
            Result.isFailure(result) && result.failure.message.includes("disable auto-merge"),
          );
          assert.isFalse((yield* f.service.list({})).watches[0]!.watching);
          const trackResult = yield* f.service
            .track({ requestId: "retrack", reference }, "user")
            .pipe(Effect.result);
          assert.equal(Result.isFailure(trackResult) && trackResult.failure.code, "conflict");
          assert.equal(f.actions.length, 0);
          f.change({ autoMergeEnabled: false });
          const recovered = yield* f.service.command(input, "user");
          assert.equal(recovered.binding, "replacement");
          assert.isNull(recovered.authorization);
          assert.equal(f.actions.length, 0);
        }
      }),
  );

  it.effect("terminal PRs may recover, but a changed canonical PR identity cannot", () =>
    Effect.gen(function* () {
      const f = yield* tracked();
      f.bind("replacement");
      f.change({ state: "merged", autoMergeEnabled: null });
      const recovered = yield* f.service.command(
        { requestId: "terminal", watchId: f.watch.id, action: "resume" },
        "user",
      );
      assert.equal(recovered.binding, "replacement");
      assert.isFalse(recovered.watching);
      assert.isNull(recovered.authorization);
      f.bind("another-binding");
      f.changeReference({ ...reference, host: "other.example" });
      const result = yield* f.service
        .command({ requestId: "identity", watchId: f.watch.id, action: "resume" }, "user")
        .pipe(Effect.result);
      assert.equal(Result.isFailure(result) && result.failure.code, "conflict");
      assert.equal((yield* f.service.list({})).watches[0]!.binding, "replacement");
      assert.equal(f.actions.length, 0);
    }),
  );
  it.effect(
    "only observed terminal transitions gain a completion timestamp, which survives refresh and restart",
    () =>
      Effect.gen(function* () {
        const historical = yield* fixture;
        historical.change({ state: "merged" });
        const initialTerminal = yield* historical.service.track(
          { requestId: "historical", reference },
          "user",
        );
        assert.isNull(initialTerminal.completedAt);
        assert.isFalse(initialTerminal.watching);
        yield* historical.service.command(
          { requestId: "historical-refresh", watchId: initialTerminal.id, action: "refresh" },
          "user",
        );
        assert.isNull((yield* historical.service.list({})).watches[0]!.completedAt);
        const f = yield* tracked();
        assert.isNull(f.watch.completedAt);
        f.change({ state: "merged" });
        yield* f.service.tick;
        const completed = (yield* f.service.list({})).watches[0]!;
        assert.isString(completed.completedAt);
        const restarted = yield* f.restart;
        const refreshed = yield* restarted.command(
          { requestId: "refresh", watchId: f.watch.id, action: "refresh" },
          "user",
        );
        assert.equal(refreshed.completedAt, completed.completedAt);
        f.bind("replacement");
        const rebound = yield* restarted.command(
          { requestId: "rebind", watchId: f.watch.id, action: "resume" },
          "user",
        );
        assert.isNull(rebound.completedAt);
      }),
  );

  it.effect("successful watch-owned merging records completion on provider confirmation", () =>
    Effect.gen(function* () {
      const f = yield* tracked();
      f.change({ requiredChecks: "passing" });
      const merged = yield* f.service.command(
        { requestId: "merge", watchId: f.watch.id, action: "authorize-merge" },
        "user",
      );
      assert.equal(merged.observation?.state, "merged");
      assert.isString(merged.completedAt);
      assert.isFalse(merged.watching);
    }),
  );
  it.effect(
    "linked associations are restored after repeated binding recovery and restart without resuming or managing",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const id = ThreadId.make("linked-thread");
        f.threads.push({
          id,
          projectId,
          linkedPullRequest: { ...reference, url: initial.url },
          session: null,
        } as OrchestrationThreadShell);
        yield* f.service.tick;
        const watch = (yield* f.service.list({})).watches[0]!;
        for (const [index, binding] of ["next", "original", "next"].entries()) {
          f.bind(binding);
          yield* f.service.tick;
          const resumed = yield* f.service.command(
            { requestId: `resume-${index}`, watchId: watch.id, action: "resume" },
            "user",
          );
          assert.deepEqual(resumed.threadIds, []);
          yield* f.service.command(
            { requestId: `pause-${index}`, watchId: watch.id, action: "pause" },
            "user",
          );
          const restarted = yield* f.restart;
          yield* restarted.tick;
          const associated = (yield* restarted.list({})).watches[0]!;
          assert.deepEqual(associated.threadIds, [id]);
          assert.isFalse(associated.watching);
          assert.isNull(associated.managerThreadId);
          assert.isNull(associated.authorization);
          const again = yield* f.restart;
          yield* again.tick;
          assert.equal((yield* again.list({})).watches[0]!.revision, associated.revision);
        }
        assert.equal(f.actions.length, 0);
      }),
  );

  it.effect(
    "discovered associations get a new receipt after safe recovery and process restart",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const id = ThreadId.make("discovered-thread");
        f.threads.push({
          id,
          projectId,
          branch: "feature",
          worktreePath: null,
          session: null,
          createdAt: initial.observedAt,
          updatedAt: initial.observedAt,
          latestUserMessageAt: initial.observedAt,
          archivedAt: null,
          linkedPullRequest: null,
        } as OrchestrationThreadShell);
        f.projects.push({
          id: projectId,
          title: "Repo",
          workspaceRoot: "/repo",
          defaultModelSelection: null,
          scripts: [],
          createdAt: initial.observedAt,
          updatedAt: initial.observedAt,
          repositoryIdentity: {
            canonicalKey: "github.com/owner/repo",
            displayName: "owner/repo",
            provider: "github",
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: "https://github.com/owner/repo.git",
            },
          },
        });
        const listing = Layer.succeed(PullRequestService, {
          list: () =>
            Effect.succeed({
              entries: [
                {
                  ...reference,
                  provider: "github",
                  headBranch: "feature",
                  baseBranch: "main",
                  state: "open",
                  author: { login: "owner" },
                  createdAt: initial.observedAt,
                } as PullRequestListEntry,
              ],
              viewers: { "github.com": "owner" },
              providers: [],
              errors: [],
              truncated: false,
              nextCursors: {},
            }),
        } as unknown as PullRequestService["Service"]);
        const git = Layer.succeed(GitVcsDriver, {
          resolveDefaultBranchName: () => Effect.succeed("main"),
        } as unknown as GitVcsDriver["Service"]);
        const discovery = (service: PullRequestWatchService["Service"]) =>
          makeDiscovery.pipe(
            Effect.provide(
              Layer.mergeAll(
                f.projections,
                listing,
                git,
                Path.layer,
                Layer.succeed(PullRequestWatchService, service),
              ),
            ),
          );
        yield* (yield* discovery(f.service)).tick;
        const watch = (yield* f.service.list({})).watches[0]!;
        assert.deepEqual(watch.threadIds, [id]);
        for (const [index, binding] of ["next", "original", "next"].entries()) {
          f.bind(binding);
          yield* f.service.tick;
          const recovered = yield* f.service.command(
            { requestId: `resume-${index}`, watchId: watch.id, action: "resume" },
            "user",
          );
          assert.deepEqual(recovered.threadIds, []);
          yield* f.service.command(
            { requestId: `pause-${index}`, watchId: watch.id, action: "pause" },
            "user",
          );
          const restarted = yield* f.restart;
          yield* (yield* discovery(restarted)).tick;
          const associated = (yield* restarted.list({})).watches[0]!;
          assert.deepEqual(associated.threadIds, [id]);
          assert.isFalse(associated.watching);
          assert.isNull(associated.managerThreadId);
          assert.isNull(associated.authorization);
          const again = yield* f.restart;
          yield* (yield* discovery(again)).tick;
          assert.equal((yield* again.list({})).watches[0]!.revision, associated.revision);
        }
        assert.equal(f.actions.length, 0);
      }),
  );
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  EventId,
  MessageId,
  CommandId,
  CorrelationId,
  ThreadId,
  ProviderInstanceId,
  ProviderDriverKind,
  type OrchestrationThreadShell,
  type ModelSelection,
  type ServerProvider,
  type SagaWorkbenchInferenceResult,
  type SagaWorkbenchStage,
  type OrchestrationProjectShell,
  type SagaWorkbenchEvidence as Evidence,
  type SagaWorkbenchIdentity,
  SagaWorkbenchError,
  type SagaWorkbenchRequirement,
} from "@lecturn/contracts";
import { Effect, FileSystem, Layer, Option, Result, Schema } from "effect";
import { ServerConfig } from "../config.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Repository from "../persistence/Layers/SagaWorkbenchRepository.ts";
import { SagaWorkbenchRepository } from "../persistence/Services/SagaWorkbenchRepository.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { SagaWorkbenchEvidence } from "./SagaWorkbenchEvidence.ts";
import {
  approvalBlockers,
  completionBlockers,
  make,
  type PromptInferenceEvent,
} from "./SagaWorkbenchService.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  emptyWorkflow,
  workflowIdentityKey,
} from "../persistence/Services/SagaWorkbenchRepository.ts";
import { StaveWorkspaceReader } from "./StaveWorkspaceReader.ts";
import { StaveRpcRuntime } from "./staveRpcHandlers.ts";
import * as Lock from "./StaveSpaceLock.ts";
const encodeFixture = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const at = "2026-01-01T00:00:00.000Z";
const actor = {
  subject: "authenticated-user",
  sessionId: AuthSessionId.make("session"),
  scopes: [AuthOrchestrationOperateScope],
};
const requirement: SagaWorkbenchRequirement = {
  key: "repo-pr",
  kind: "pull-request",
  provider: "github",
  repoName: "repo",
  checkoutPath: "/repo",
  host: "github.com",
  repository: "owner/repo",
  number: 1,
  url: "https://github.com/owner/repo/pull/1",
  headRevision: "head",
  localHeadRevision: "head",
  baseRevision: "base",
  localChanges: "clean",
  localHeadMatches: true,
  requiredChecks: "pending",
  checksRevision: "head",
  merged: false,
  mergedSourceRevision: null,
  blockers: ["CI pending", "Not merged"],
};
const evidence = (requirements: readonly SagaWorkbenchRequirement[] = [requirement]): Evidence => ({
  sourceRevision: "source",
  manifestRevision: "manifest",
  observedAt: at,
  requirements,
  complete: true,
  blockers: requirements.flatMap((row) =>
    row.blockers.map((message) => `${row.repoName}: ${message}`),
  ),
});
const harness = Effect.fn("harness")(function* (
  options: {
    removeDuringEvidence?: boolean;
    automaticStage?: boolean;
    noTurns?: boolean;
    unavailableAccount?: boolean;
    malformedResult?: boolean;
    generatedStage?: SagaWorkbenchStage;
    changeTitleDuringGeneration?: boolean;
    changeEvidenceDuringGeneration?: Evidence;
    disabledServer?: boolean;
    saga?: boolean;
    unrelatedArchiveParent?: boolean;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();
  const workspaceRoot = yield* fs.realPath(root);
  yield* fs.writeFileString(`${root}/.stave.yaml`, "id: space\nspecPath: spec\n");
  yield* fs.makeDirectory(`${root}/spec`);
  yield* fs.writeFileString(
    `${root}/spec/intent.md`,
    "Implement the blue launch button.\n" + "bounded ".repeat(10000),
  );
  yield* fs.writeFileString(`${root}/spec/plan.md`, "The project needs a blue button.");
  const identity: SagaWorkbenchIdentity = {
    projectId: ProjectId.make(`project-${workspaceRoot}`),
    workspaceRoot,
    spaceId: "space",
    createdAt: at,
  };
  const info = {
    spaceId: "space",
    createdAt: at,
    isSaga: options.saga ?? false,
    state: "live" as const,
    repos: [],
    memories: [],
  };
  let live = true;
  let project: OrchestrationProjectShell = {
    id: identity.projectId,
    title: "Project intent",
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: at,
    updatedAt: at,
    stave: info,
  };
  const memberIdentity: SagaWorkbenchIdentity = {
    ...identity,
    projectId: ProjectId.make(`member-${workspaceRoot}`),
    workspaceRoot: `${workspaceRoot}/member`,
    spaceId: "member",
  };
  yield* fs.makeDirectory(memberIdentity.workspaceRoot);
  const memberInfo = { ...info, isSaga: false, spaceId: "member" };
  let memberProject: OrchestrationProjectShell = {
    ...project,
    id: memberIdentity.projectId,
    workspaceRoot: memberIdentity.workspaceRoot,
    title: "Member",
    stave: memberInfo,
  };
  let memberStale = false;
  let memberArchived = false;
  let memberStamp = at;
  const readProjects: ProjectId[] = [];
  let reads = 0;
  let rechecks = 0;
  let generations = 0;
  let sagaReads = 0;
  let generatedInput = "";
  let generatedModel: ModelSelection | undefined;
  let duringGeneration = Effect.void;
  const modelSelection = { instanceId: ProviderInstanceId.make("codex-work"), model: "gpt-6" };
  const threadFor = (projectId: ProjectId): OrchestrationThreadShell => ({
    id: ThreadId.make(`thread-${projectId}`),
    projectId,
    title: "Conversation",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: at,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  });
  let turns = options.noTurns
    ? []
    : [{ question: "Build the button", response: "I implemented the button." }];
  let currentEvidence = evidence([]);
  const config = yield* ServerConfig.pipe(Effect.provide(ServerConfig.layerTest(root, root)));
  const dependencies = Layer.mergeAll(
    Layer.succeed(ServerConfig, { ...config, staveEnabled: !options.disabledServer }),
    Layer.mock(ProjectionSnapshotQuery)({
      getInferenceTurnPairs: () => Effect.succeed(turns),
      getThreadShellById: (id) =>
        Effect.succeed(
          Option.some(
            [threadFor(identity.projectId), threadFor(memberIdentity.projectId)].find(
              (thread) => thread.id === id,
            ) ?? threadFor(identity.projectId),
          ),
        ),
      getProjectShellById: (id) =>
        Effect.succeed(Option.some(id === memberIdentity.projectId ? memberProject : project)),
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 0,
          projects: options.saga ? [project, memberProject] : [project],
          threads: [threadFor(identity.projectId), threadFor(memberIdentity.projectId)],
          updatedAt: at,
        }),
    }),
    Layer.mock(StaveWorkspaceReader)({
      invalidate: () => Effect.void,
      load: (root) =>
        Effect.succeed(
          live
            ? Option.some(
                root === memberProject.workspaceRoot
                  ? {
                      ...memberInfo,
                      state: memberArchived ? ("archived" as const) : ("live" as const),
                      createdAt: memberStamp,
                    }
                  : info,
              )
            : Option.none(),
        ),
    }),
    Layer.mock(StaveRpcRuntime)({
      sagaStatus: () => {
        sagaReads++;
        return Effect.succeed({
          sagaId: identity.spaceId,
          sagaCreatedAt: at,
          members: [
            {
              id: memberIdentity.spaceId,
              workspaceRoot: memberProject.workspaceRoot,
              createdAt: at,
              after: [],
              state: memberArchived ? "archived" : "live",
              dirty: memberStale,
              repos: [],
              prs: [],
            },
          ],
          notes: [],
        });
      },
    }),
    Layer.mock(ServerSettingsService)({
      getSettings: Effect.succeed({
        ...DEFAULT_SERVER_SETTINGS,
        stave: { ...DEFAULT_SERVER_SETTINGS.stave, enabled: true },
      }),
    }),
    Layer.mock(SagaWorkbenchEvidence)({
      read: (input) =>
        Effect.sync(() => {
          reads++;
          readProjects.push(input.identity.projectId);
          if (options.removeDuringEvidence) live = false;
          return options.saga && input.identity.projectId === identity.projectId
            ? evidence([])
            : currentEvidence;
        }),
      revalidate: (input) =>
        Effect.suspend(() => {
          rechecks++;
          return memberStale && input.identity.projectId === memberIdentity.projectId
            ? Effect.fail(
                new SagaWorkbenchError({ code: "conflict", message: "Member worktree changed." }),
              )
            : Effect.void;
        }),
    }),
    Layer.mock(ProviderInstanceRegistry)({
      getInstance: (instanceId) =>
        Effect.succeed(
          options.unavailableAccount
            ? undefined
            : ({
                instanceId,
                driverKind: ProviderDriverKind.make("codex"),
                enabled: true,
                snapshot: {
                  getSnapshot: Effect.succeed({
                    models: [{ slug: "gpt-5.6-luna" }],
                  } as unknown as ServerProvider),
                },
              } as ProviderInstance),
        ),
    }),
    Layer.mock(TextGeneration)({
      generateWorkflowSummary: (input) =>
        Effect.gen(function* () {
          generations++;
          generatedInput = input.message;
          generatedModel = input.modelSelection;
          yield* duringGeneration;
          if (options.changeTitleDuringGeneration) project = { ...project, title: "Changed" };
          if (options.changeEvidenceDuringGeneration)
            currentEvidence = options.changeEvidenceDuringGeneration;
          return options.malformedResult
            ? ({
                summary: "bad",
                stage: "merged",
                confidence: 2,
              } as unknown as SagaWorkbenchInferenceResult)
            : {
                summary: "The project is ready for its next step.",
                stage: options.generatedStage ?? "build",
                confidence: 0.8,
              };
        }),
    }),
    Lock.layer,
  );
  const service = yield* make.pipe(Effect.provide(dependencies));
  const repo = yield* SagaWorkbenchRepository;
  if (options.automaticStage !== true) {
    const sql = yield* SqlClient.SqlClient;
    for (const seedIdentity of [identity, memberIdentity]) {
      const seeded = yield* encodeFixture({
        ...emptyWorkflow(seedIdentity),
        automaticStage: false,
      });
      yield* sql`INSERT INTO saga_workbench (identity_key, revision, workflow_json) VALUES (${workflowIdentityKey(seedIdentity)}, 0, ${seeded})`;
    }
  }
  return {
    thread: threadFor(identity.projectId),
    turns,
    replaceTurns: () => {
      turns = [{ question: "New question", response: "New response" }];
    },
    setDuringGeneration: (effect: Effect.Effect<void, SagaWorkbenchError>) => {
      duringGeneration = effect.pipe(Effect.orDie);
    },
    remove: () => {
      live = false;
    },
    service,
    repo,
    identity,
    memberIdentity,
    archiveMember: Effect.gen(function* () {
      const archiveParent = options.unrelatedArchiveParent
        ? yield* fs.realPath(yield* fs.makeTempDirectoryScoped())
        : workspaceRoot;
      const archiveRoot = `${archiveParent}/.archive/member`;
      yield* fs.makeDirectory(`${archiveParent}/.archive`);
      yield* fs.rename(memberProject.workspaceRoot, archiveRoot);
      memberArchived = true;
      memberProject = {
        ...memberProject,
        workspaceRoot: archiveRoot,
        stave: { ...memberInfo, state: "archived" },
      };
      return { ...memberIdentity, workspaceRoot: archiveRoot };
    }),
    recreateMember: () => {
      memberStamp = "2026-02-01T00:00:00.000Z";
      memberProject = {
        ...memberProject,
        stave: {
          ...memberInfo,
          state: memberArchived ? "archived" : "live",
          createdAt: memberStamp,
        },
      };
    },
    setMemberStale: () => {
      memberStale = true;
    },
    readProjects,
    setEvidence: (next: Evidence) => {
      currentEvidence = next;
    },
    counts: () => ({ reads, rechecks, generations, generatedInput, generatedModel, sagaReads }),
  };
});
const testLayer = Repository.layer.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);
it.layer(testLayer)("Saga workbench service", (it) => {
  it.effect(
    "never attaches completion to an unrelated archive parent with the same project and manifest identity",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({ saga: true, unrelatedArchiveParent: true });
        const stored = {
          identity: h.memberIdentity,
          revision: 1,
          stage: "accept" as const,
          accepted: null,
          completedAt: at,
          summary: null,
        };
        yield* h.repo.save({
          identity: h.memberIdentity,
          actorKey: "seed",
          requestId: "seed",
          requestHash: "seed",
          expectedRevision: 0,
          workflow: stored,
          activity: {
            revision: 1,
            at,
            action: "complete",
            subject: actor.subject,
            sessionId: actor.sessionId,
            detail: "Completed historical fixture",
          },
        });
        const rebound = yield* h.archiveMember;
        const snapshot = yield* h.service.getSnapshot({ projectId: h.identity.projectId });
        assert.equal(snapshot.members[0]?.workflow, null);
        assert.deepEqual(yield* h.service.getActivity({ identity: rebound }), []);
        const direct = yield* h.service
          .getSnapshot({ projectId: rebound.projectId })
          .pipe(Effect.result);
        assert.equal(Result.isFailure(direct) && direct.failure.code, "unavailable");
        assert.equal((yield* h.repo.get(h.memberIdentity)).completedAt, at);
      }),
  );
  it.effect(
    "preserves archived completion, summary and activity without authorizing writes or reusing a new incarnation",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({ saga: true });
        h.setEvidence(
          evidence([
            {
              ...requirement,
              requiredChecks: "passing",
              merged: true,
              mergedSourceRevision: "head",
              blockers: [],
            },
          ]),
        );
        const input = {
          identity: h.memberIdentity,
          expectedRevision: 0,
          requestId: "member-stage",
        };
        yield* h.service.setStage({ ...input, stage: "accept" }, actor);
        yield* h.service.approve(
          {
            ...input,
            expectedRevision: 1,
            requestId: "member-approve",
            expectedEvidenceRevision: "source",
          },
          actor,
        );
        yield* h.service.complete(
          { ...input, expectedRevision: 2, requestId: "member-complete" },
          actor,
        );
        const saved = yield* h.service.summarize(
          { ...input, expectedRevision: 3, requestId: "member-summary" },
          actor,
        );
        const archived = yield* h.archiveMember;
        const snapshot = yield* h.service.getSnapshot({ projectId: h.identity.projectId });
        const member = snapshot.members[0]!;
        assert.equal(member.state, "archived");
        assert.deepEqual(member.identity, archived);
        assert.equal(member.workflow?.identity.workspaceRoot, h.memberIdentity.workspaceRoot);
        assert.equal(member.workflow?.completedAt, saved.completedAt);
        assert.deepEqual(member.workflow?.summary, saved.summary);
        assert.equal((yield* h.service.getActivity({ identity: archived })).length, 4);
        const direct = yield* h.service.getSnapshot({ projectId: archived.projectId });
        assert.equal(direct.workflow.completedAt, saved.completedAt);
        const next = { identity: archived, expectedRevision: 4, requestId: "archived-denied" };
        const attempts: Effect.Effect<unknown, SagaWorkbenchError>[] = [
          h.service.setStage({ ...next, stage: "build" }, actor),
          h.service.approve({ ...next, expectedEvidenceRevision: "source" }, actor),
          h.service.complete(next, actor),
          h.service.reopen(next, actor),
          h.service.summarize(next, actor),
          h.service.getEvidence({ identity: archived }),
          h.service.setStage({ ...next, identity: h.memberIdentity, stage: "build" }, actor),
        ];
        for (const attempt of attempts)
          assert.isTrue(Result.isFailure(yield* attempt.pipe(Effect.result)));
        assert.equal((yield* h.repo.get(h.memberIdentity)).revision, 4);
        h.recreateMember();
        const recreated = yield* h.service.getSnapshot({ projectId: h.identity.projectId });
        assert.equal(recreated.members[0]?.identity, null);
        assert.equal(recreated.members[0]?.workflow, null);
      }),
  );
  it.effect("requires authenticated operate scope and validates incarnation before writes", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const input = {
        identity: h.identity,
        expectedRevision: 0,
        requestId: "scope",
        stage: "build" as const,
      };
      const denied = yield* h.service
        .setStage(input, { ...actor, scopes: [AuthOrchestrationReadScope] })
        .pipe(Effect.result);
      assert.equal(Result.isFailure(denied) && denied.failure.code, "blocked");
      const wrong = yield* h.service
        .setStage(
          { ...input, identity: { ...h.identity, createdAt: "2026-02-01T00:00:00.000Z" } },
          actor,
        )
        .pipe(Effect.result);
      assert.equal(Result.isFailure(wrong) && wrong.failure.code, "identity");
      assert.equal((yield* h.repo.get(h.identity)).revision, 0);
    }),
  );
  it.effect("server kill switch refuses every workflow path", () =>
    Effect.gen(function* () {
      const h = yield* harness({ disabledServer: true });
      const input = { identity: h.identity, expectedRevision: 0, requestId: "disabled" };
      const attempts: Effect.Effect<unknown, SagaWorkbenchError>[] = [
        h.service.getSnapshot({ projectId: h.identity.projectId }),
        h.service.getEvidence(input),
        h.service.getActivity(input),
        h.service.setStage({ ...input, stage: "build" }, actor),
        h.service.summarize(input, actor),
      ];
      for (const effect of attempts) {
        const result = yield* effect.pipe(Effect.result);
        assert.equal(Result.isFailure(result) && result.failure.code, "unavailable");
      }
      assert.equal(h.counts().reads, 0);
    }),
  );
  it.effect(
    "allows skips and backwards stages, with retry idempotency and no evidence/agent action",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const input = {
          identity: h.identity,
          expectedRevision: 0,
          requestId: "skip",
          stage: "accept" as const,
        };
        const first = yield* h.service.setStage(input, actor);
        assert.deepEqual(yield* h.service.setStage(input, actor), first);
        const back = yield* h.service.setStage(
          { ...input, expectedRevision: 1, requestId: "back", stage: "spec" },
          actor,
        );
        assert.equal(back.stage, "spec");
        assert.equal(h.counts().reads, 0);
        assert.equal((yield* h.repo.activity(h.identity)).length, 2);
      }),
  );
  it.effect("keeps explicit approval independent from CI/merge then completes and reopens", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      h.setEvidence(evidence());
      const input = { identity: h.identity, expectedRevision: 0, requestId: "accept-stage" };
      yield* h.service.setStage({ ...input, stage: "accept" }, actor);
      const accepted = yield* h.service.approve(
        { ...input, expectedRevision: 1, requestId: "approve", expectedEvidenceRevision: "source" },
        actor,
      );
      assert.equal(accepted.accepted?.subject, actor.subject);
      assert.equal(accepted.completedAt, null);
      const blocked = yield* h.service
        .complete({ ...input, expectedRevision: 2, requestId: "complete" }, actor)
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(blocked));
      h.setEvidence(
        evidence([
          {
            ...requirement,
            requiredChecks: "passing",
            merged: true,
            mergedSourceRevision: "head",
            blockers: [],
          },
        ]),
      );
      const completed = yield* h.service.complete(
        { ...input, expectedRevision: 2, requestId: "complete" },
        actor,
      );
      assert.isNotNull(completed.completedAt);
      const reopened = yield* h.service.reopen(
        { ...input, expectedRevision: 3, requestId: "reopen" },
        actor,
      );
      assert.equal(reopened.completedAt, null);
      assert.equal(reopened.accepted, null);
    }),
  );
  it.effect("refuses lifecycle removal while external evidence is read", () =>
    Effect.gen(function* () {
      const h = yield* harness({ removeDuringEvidence: true });
      yield* h.service.setStage(
        { identity: h.identity, expectedRevision: 0, requestId: "stage", stage: "accept" },
        actor,
      );
      const result = yield* h.service
        .approve(
          {
            identity: h.identity,
            expectedRevision: 1,
            requestId: "approve",
            expectedEvidenceRevision: "source",
          },
          actor,
        )
        .pipe(Effect.result);
      assert.equal(Result.isFailure(result) && result.failure.code, "identity");
      assert.equal((yield* h.repo.get(h.identity)).accepted, null);
    }),
  );
  it.effect(
    "prepares only current saga/coordinator members with completed pairs and captures the submitted account",
    () =>
      Effect.gen(function* () {
        const makeEvent = (threadId: ThreadId): PromptInferenceEvent => ({
          sequence: 1,
          eventId: EventId.make("submitted"),
          aggregateKind: "thread",
          aggregateId: threadId,
          type: "thread.turn-start-requested",
          occurredAt: at,
          commandId: CommandId.make("submit"),
          causationEventId: null,
          correlationId: CorrelationId.make("submit"),
          metadata: {},
          payload: {
            threadId,
            messageId: MessageId.make("prompt"),
            createdAt: at,
            runtimeMode: "full-access",
            interactionMode: "default",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claude-personal"),
              model: "sonnet",
            },
          },
        });
        const standalone = yield* harness({ automaticStage: true });
        assert.equal(
          yield* standalone.service.preparePromptInference(makeEvent(standalone.thread.id)),
          null,
        );
        const first = yield* harness({ automaticStage: true, saga: true, noTurns: true });
        assert.equal(yield* first.service.preparePromptInference(makeEvent(first.thread.id)), null);
        const h = yield* harness({ automaticStage: true, saga: true });
        const prepared = yield* h.service.preparePromptInference(makeEvent(h.thread.id));
        assert.equal(prepared?.modelSelection.instanceId, "claude-personal");
        assert.deepEqual(prepared?.turns, h.turns);
        const member = yield* h.service.preparePromptInference(
          makeEvent(ThreadId.make(`thread-${h.memberIdentity.projectId}`)),
        );
        assert.equal(member?.identity.projectId, h.memberIdentity.projectId);
        h.recreateMember();
        assert.equal(
          yield* h.service.preparePromptInference(
            makeEvent(ThreadId.make(`thread-${h.memberIdentity.projectId}`)),
          ),
          null,
        );
        assert.equal(h.counts().generations, 0);
      }),
  );
  it.effect(
    "a completed workflow keeps completion and phase even with automatic inference enabled",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({ automaticStage: true, saga: true });
        yield* h.repo.save({
          identity: h.identity,
          actorKey: "seed",
          requestId: "seed",
          requestHash: "seed",
          expectedRevision: 0,
          workflow: { ...emptyWorkflow(h.identity), revision: 1, stage: "accept", completedAt: at },
          activity: {
            revision: 1,
            at,
            action: "seed",
            subject: "fixture",
            sessionId: "fixture",
            detail: "Completed fixture",
          },
        });
        const updated = yield* h.service.summarize(
          { identity: h.identity, expectedRevision: 1, requestId: "summary" },
          actor,
        );
        assert.equal(updated.stage, "accept");
        assert.equal(updated.completedAt, at);
        assert.equal(updated.summary?.inferredStage, "build");
        assert.isNotNull(updated.summary);
      }),
  );
  it.effect(
    "generates summary and stage once from only prior summary and completed textual pairs",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({ automaticStage: true, saga: true });
        const request = {
          identity: h.identity,
          threadId: h.thread.id,
          modelSelection: h.thread.modelSelection,
          turns: h.turns,
          eventId: "prompt-one",
          sequence: 50,
        };
        const results = yield* Effect.all(
          [h.service.inferFromPrompt(request), h.service.inferFromPrompt(request)],
          { concurrency: 2 },
        );
        assert.deepEqual(results[0], results[1]);
        assert.equal(results[0]?.stage, "build");
        assert.equal(results[0]?.summary?.confidence, 0.8);
        assert.equal(results[0]?.lastInferenceSequence, 50);
        assert.equal(h.counts().generations, 1);
        assert.equal(
          h.counts().generatedInput,
          yield* encodeFixture({
            priorSummary: null,
            turns: h.turns,
          }),
        );
        assert.equal(h.counts().generatedModel?.instanceId, h.thread.modelSelection.instanceId);
        assert.equal(h.counts().generatedModel?.model, "gpt-5.6-luna");
        assert.equal(h.counts().reads, 0);
        const old = yield* h.service.inferFromPrompt({ ...request, eventId: "old", sequence: 49 });
        assert.deepEqual(old, results[0]);
        assert.equal(h.counts().generations, 1);
        const next = yield* h.service.inferFromPrompt({ ...request, eventId: "new", sequence: 51 });
        assert.equal(next.revision, 2);
        assert.equal(h.counts().generations, 2);
        assert.equal(
          h.counts().generatedInput,
          yield* encodeFixture({
            priorSummary: results[0]?.summary?.text,
            turns: h.turns,
          }),
        );
        assert.equal((yield* h.repo.activity(h.identity))[0]?.subject, "system:saga-inference");
      }),
  );
  it.effect("pins and manual mode block inferred stage movement while summaries continue", () =>
    Effect.gen(function* () {
      for (const pinned of [true, false]) {
        const h = yield* harness({ automaticStage: true });
        yield* h.service.configure(
          {
            identity: h.identity,
            expectedRevision: 0,
            requestId: "config",
            ...(pinned ? { stagePinned: true } : { automaticStage: false }),
          },
          actor,
        );
        const updated = yield* h.service.summarize(
          { identity: h.identity, expectedRevision: 1, requestId: "summary" },
          actor,
        );
        assert.equal(updated.stage, "spec");
        assert.equal(updated.summary?.inferredStage, "build");
        assert.equal(h.counts().generations, 1);
        const manual = yield* h.service
          .setStage(
            { identity: h.identity, expectedRevision: 2, requestId: "manual", stage: "plan" },
            actor,
          )
          .pipe(Effect.result);
        assert.equal(Result.isFailure(manual), pinned);
      }
      const h = yield* harness({ automaticStage: true });
      const result = yield* h.service
        .setStage(
          { identity: h.identity, expectedRevision: 0, requestId: "manual", stage: "plan" },
          actor,
        )
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(result));
    }),
  );
  it.effect("preserves concurrent manual/configuration edits but still publishes its summary", () =>
    Effect.gen(function* () {
      const h = yield* harness({ automaticStage: true });
      h.setDuringGeneration(
        Effect.gen(function* () {
          yield* h.service.configure(
            {
              identity: h.identity,
              expectedRevision: 0,
              requestId: "config",
              automaticStage: false,
            },
            actor,
          );
          yield* h.service.setStage(
            { identity: h.identity, expectedRevision: 1, requestId: "manual", stage: "review" },
            actor,
          );
        }),
      );
      const updated = yield* h.service.summarize(
        { identity: h.identity, expectedRevision: 0, requestId: "summary" },
        actor,
      );
      assert.equal(updated.stage, "review");
      assert.equal(updated.automaticStage, false);
      assert.equal(updated.revision, 3);
      assert.isNotNull(updated.summary);
    }),
  );
  it.effect("invalid output and unavailable account leave summary and stage untouched", () =>
    Effect.gen(function* () {
      for (const options of [
        { malformedResult: true },
        { unavailableAccount: true },
        { noTurns: true },
      ]) {
        const h = yield* harness({ ...options, automaticStage: true });
        const result = yield* h.service
          .summarize({ identity: h.identity, expectedRevision: 0, requestId: "invalid" }, actor)
          .pipe(Effect.result);
        assert.equal(Result.isFailure(result) && result.failure.code, "generation");
        assert.equal((yield* h.repo.get(h.identity)).summary, null);
        assert.equal((yield* h.repo.get(h.identity)).stage, "spec");
      }
    }),
  );
  it.effect("records a safe failed-update activity once without changing stage or summary", () =>
    Effect.gen(function* () {
      const h = yield* harness({ automaticStage: true, saga: true, malformedResult: true });
      const request = {
        identity: h.identity,
        threadId: h.thread.id,
        modelSelection: h.thread.modelSelection,
        turns: h.turns,
        eventId: "failed-prompt",
        sequence: 50,
      };
      for (let retry = 0; retry < 2; retry++) {
        const result = yield* h.service.inferFromPrompt(request).pipe(Effect.result);
        assert.equal(Result.isFailure(result) && result.failure.code, "generation");
      }
      const saved = yield* h.repo.get(h.identity);
      assert.equal(saved.stage, "spec");
      assert.equal(saved.summary, null);
      assert.equal(saved.lastInferenceSequence, undefined);
      assert.equal(h.counts().generations, 1);
      const activity = yield* h.repo.activity(h.identity);
      assert.equal(activity.length, 1);
      assert.equal(activity[0]?.action, "inference-failed");
      assert.include(activity[0]!.detail, "provider account");
    }),
  );
  it.effect("does not publish text from conversation history replaced during generation", () =>
    Effect.gen(function* () {
      const h = yield* harness({ automaticStage: true });
      h.setDuringGeneration(Effect.sync(h.replaceTurns));
      const result = yield* h.service
        .summarize(
          { identity: h.identity, expectedRevision: 0, requestId: "changed-history" },
          actor,
        )
        .pipe(Effect.result);
      assert.equal(Result.isFailure(result) && result.failure.code, "conflict");
      assert.equal((yield* h.repo.get(h.identity)).summary, null);
      assert.equal((yield* h.repo.get(h.identity)).stage, "spec");
    }),
  );
  it.effect("fences incarnation changes after generation without querying external evidence", () =>
    Effect.gen(function* () {
      const h = yield* harness({ automaticStage: true });
      h.setDuringGeneration(Effect.sync(h.remove));
      const result = yield* h.service
        .summarize({ identity: h.identity, expectedRevision: 0, requestId: "removed" }, actor)
        .pipe(Effect.result);
      assert.equal(Result.isFailure(result) && result.failure.code, "identity");
      assert.equal((yield* h.repo.get(h.identity)).summary, null);
      assert.equal(h.counts().reads, 0);
    }),
  );
});
describe("revision-bound completion", () => {
  const accepted = {
    at,
    subject: "human",
    sessionId: "session",
    evidenceRevision: "source",
    manifestRevision: "manifest",
    requirements: [requirement],
  };
  it("does not equate unknown CI, wrong revision, or another repo merge with completion", () => {
    for (const patch of [
      { requiredChecks: "unknown" as const },
      { checksRevision: "old" },
      { headRevision: "new" },
      { mergedSourceRevision: "other" },
    ]) {
      assert.isNotEmpty(
        completionBlockers(
          evidence([
            {
              ...requirement,
              requiredChecks: "passing",
              blockers: [],
              merged: true,
              mergedSourceRevision: "head",
              ...patch,
            },
          ]),
          accepted,
        ),
      );
    }
    assert.isNotEmpty(completionBlockers(evidence([]), accepted));
    assert.isNotEmpty(approvalBlockers(evidence([{ ...requirement, kind: "unknown" }])));
  });
  it("approves revisions with flattened delivery blockers, but completion rejects policy uncertainty", () => {
    assert.deepEqual(approvalBlockers(evidence()), []);
    assert.isNotEmpty(
      approvalBlockers({ ...evidence(), blockers: ["Manifest ownership is ambiguous."] }),
    );
    const row = {
      ...requirement,
      requiredChecks: "passing" as const,
      merged: true,
      mergedSourceRevision: "head",
      blockers: ["Required policy discovery was incomplete."],
    };
    assert.isNotEmpty(completionBlockers(evidence([row]), accepted));
  });
  it("allows the merged PR base to advance but preserves immutable no-change base proofs", () => {
    const merged = {
      ...requirement,
      requiredChecks: "passing" as const,
      blockers: [],
      merged: true,
      mergedSourceRevision: "head",
      baseRevision: "advanced-base",
    };
    assert.deepEqual(completionBlockers(evidence([merged]), accepted), []);
    const unchanged = {
      ...requirement,
      kind: "no-changes" as const,
      number: null,
      headRevision: null,
      blockers: [],
    };
    assert.isNotEmpty(
      completionBlockers(evidence([{ ...unchanged, baseRevision: "advanced-base" }]), {
        ...accepted,
        requirements: [unchanged],
      }),
    );
  });
  it("allows verified zero required checks, and proven no-change rows, never empty failure", () => {
    assert.deepEqual(
      completionBlockers(
        evidence([
          {
            ...requirement,
            requiredChecks: "none",
            merged: true,
            mergedSourceRevision: "head",
            blockers: [],
          },
        ]),
        accepted,
      ),
      [],
    );
    const row = {
      ...requirement,
      kind: "no-changes" as const,
      number: null,
      headRevision: null,
      blockers: [],
    };
    assert.deepEqual(completionBlockers(evidence([row]), { ...accepted, requirements: [row] }), []);
    assert.isNotEmpty(approvalBlockers({ ...evidence([]), complete: false }));
  });
});

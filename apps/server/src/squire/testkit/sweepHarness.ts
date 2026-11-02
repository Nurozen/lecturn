/**
 * Digest and sweep tests: the real Squire store, scope, sweep, and digest
 * over in-memory SQLite, with thread shells (the orchestrator's projection,
 * an external dependency here) held in a Ref the test edits.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  type ThreadId,
  type ThreadPullRequestLink,
} from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ServerConfig from "../../config.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as SquireContainers from "../SquireContainers.ts";
import * as SquireDigest from "../SquireDigest.ts";
import * as SquireRepository from "../SquireRepository.ts";
import * as SquireScope from "../SquireScope.ts";
import * as SquireSweep from "../SquireSweep.ts";

export const PROJECT = ProjectId.make("project:work");

/** The thread shells the mocked projection serves; tests set them. */
export class TestShells extends Context.Service<
  TestShells,
  Ref.Ref<ReadonlyArray<OrchestrationV2ThreadShell>>
>()("lecturn/squire/testkit/sweepHarness/TestShells") {}

export const setShells = (shells: ReadonlyArray<OrchestrationV2ThreadShell>) =>
  Effect.flatMap(TestShells, (ref) => Ref.set(ref, shells));

const projectionsLayer = Layer.unwrap(
  Effect.map(TestShells, (shells) =>
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getShellSnapshot: () =>
        Effect.map(Ref.get(shells), (threads) => ({
          schemaVersion: 1,
          snapshotSequence: 0,
          threads,
          archivedThreads: [],
        })),
      getThreadShell: (threadId) =>
        Effect.map(
          Ref.get(shells),
          (threads) => threads.find((entry) => entry.id === threadId) ?? null,
        ),
    }),
  ),
).pipe(
  Layer.provideMerge(
    Layer.effect(TestShells, Ref.make<ReadonlyArray<OrchestrationV2ThreadShell>>([])),
  ),
);

const configLayer = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.map(ServerConfig.ServerConfig, (config) =>
    ServerConfig.make({ ...config, squireEnabled: true }),
  ),
).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "lecturn-squire-sweep-" })),
  Layer.provide(NodeServices.layer),
);

/** A fresh store and shell list per test. */
export const sweepLayer = () =>
  SquireDigest.layer.pipe(
    Layer.provideMerge(SquireSweep.layer),
    Layer.provideMerge(SquireScope.layer),
    Layer.provideMerge(
      Layer.mock(SquireContainers.SquireContainers)({
        ofProject: () => Effect.die("these tests grant projects, never Stave containers"),
      }),
    ),
    Layer.provideMerge(projectionsLayer),
    Layer.provideMerge(SquireRepository.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(configLayer),
  );

export const prLink = (input: {
  readonly number: number;
  readonly headSha: string;
  readonly checks?: "passing" | "failing" | "pending";
  readonly state?: "open" | "closed" | "merged";
  readonly syncedAt?: string;
}): ThreadPullRequestLink => ({
  host: "github.com",
  repository: "acme/app",
  number: input.number,
  url: `https://github.com/acme/app/pull/${input.number}`,
  source: "manual",
  linkedAt: "2026-10-20T00:00:00.000Z",
  stack: null,
  snapshot: {
    state: input.state ?? "open",
    title: `PR ${input.number}`,
    headBranch: `feature-${input.number}`,
    baseBranch: "main",
    isDraft: false,
    updatedAt: null,
    syncedAt: input.syncedAt ?? "2026-10-20T00:00:00.000Z",
    checksState: input.checks ?? "passing",
    headSha: input.headSha,
  },
});

const utc = (iso: string) => DateTime.makeUnsafe(iso);

export const shell = (
  id: ThreadId,
  input: {
    readonly lastRunAt?: string | null;
    readonly pullRequests?: ReadonlyArray<ThreadPullRequestLink>;
    readonly activeRunId?: OrchestrationV2ThreadShell["activeRunId"];
  } = {},
): OrchestrationV2ThreadShell => {
  const lastRunAt = input.lastRunAt ?? null;
  return {
    id,
    projectId: PROJECT,
    title: `Thread ${id}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: input.activeRunId ?? null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    pullRequests: input.pullRequests ?? [],
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: lastRunAt === null ? null : utc(lastRunAt),
    latestRunStartedAt: lastRunAt === null ? null : utc(lastRunAt),
    latestRunCompletedAt: lastRunAt === null ? null : utc(lastRunAt),
    latestUserMessageAt: null,
    latestUserAuthoredMessageAt: null,
    createdAt: utc("2026-10-01T00:00:00.000Z"),
    updatedAt: utc("2026-10-01T00:00:00.000Z"),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
  } as OrchestrationV2ThreadShell;
};

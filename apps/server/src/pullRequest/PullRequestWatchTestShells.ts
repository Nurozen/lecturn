/**
 * Test helpers for the PR watch services: compact thread fixtures in the
 * shape the V1 projection used (`session`, ISO strings) mapped onto V2 thread
 * shells, and read layers serving them through ProjectionStoreV2 and
 * ProjectService.
 */
import {
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  type ThreadId,
} from "@lecturn/contracts";
import { DateTime, Effect, Layer, Option } from "effect";

import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ProjectService } from "../project/ProjectService.ts";

export interface WatchThreadFixture {
  readonly id: ThreadId;
  readonly projectId: OrchestrationV2ThreadShell["projectId"];
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
  readonly linkedPullRequest?: OrchestrationV2ThreadShell["linkedPullRequest"];
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly latestUserMessageAt?: string | null;
  readonly archivedAt?: string | null;
  /** V1 provider session: running work, a bound idle session, or none (offline). */
  readonly session?: { readonly status: string } | null;
  readonly [key: string]: unknown;
}

const FIXTURE_TIME = "2026-09-13T00:00:00.000Z";
const at = (value: string) => DateTime.makeUnsafe(value);

export function toWatchThreadShell(fixture: WatchThreadFixture): OrchestrationV2ThreadShell {
  const running = fixture.session?.status === "running";
  const bound = fixture.session != null;
  const instance = ProviderInstanceId.make("codex");
  return {
    id: fixture.id,
    projectId: fixture.projectId,
    title: "Thread",
    providerInstanceId: instance,
    modelSelection: { instanceId: instance, model: "test-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: (fixture.branch ?? null) as OrchestrationV2ThreadShell["branch"],
    worktreePath: (fixture.worktreePath ?? null) as OrchestrationV2ThreadShell["worktreePath"],
    linkedPullRequest: fixture.linkedPullRequest ?? null,
    lineage: { rootThreadId: fixture.id, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeProviderThreadId: bound ? ProviderThreadId.make(`provider:${fixture.id}`) : null,
    latestRunId: null,
    activeRunId: running ? RunId.make(`run:${fixture.id}`) : null,
    activityRunStatus: running ? "running" : null,
    status: running ? "running" : "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt:
      fixture.latestUserMessageAt === undefined || fixture.latestUserMessageAt === null
        ? null
        : at(fixture.latestUserMessageAt),
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    providerInstanceHistory: [],
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: at(fixture.createdAt ?? FIXTURE_TIME),
    updatedAt: at(fixture.updatedAt ?? FIXTURE_TIME),
    archivedAt: fixture.archivedAt ? at(fixture.archivedAt) : null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  } as OrchestrationV2ThreadShell;
}

const unused = () => Effect.die("unused PR watch read");

/** ProjectionStoreV2 + ProjectService reads over mutable fixture arrays. */
export function watchReadLayer(input: {
  readonly threads: ReadonlyArray<WatchThreadFixture>;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
}): Layer.Layer<ProjectionStoreV2 | ProjectService> {
  const shells = () => input.threads.map(toWatchThreadShell);
  return Layer.merge(
    Layer.succeed(ProjectionStoreV2, {
      getThreadShell: (threadId: ThreadId) =>
        Effect.sync(() => shells().find((thread) => thread.id === threadId) ?? null),
      getShellSnapshot: () =>
        Effect.sync(() => ({
          schemaVersion: 2,
          snapshotSequence: 0,
          threads: shells().filter((thread) => thread.archivedAt === null),
          archivedThreads: shells().filter((thread) => thread.archivedAt !== null),
        })),
    } as unknown as ProjectionStoreV2["Service"]),
    Layer.succeed(ProjectService, {
      listShells: () => Effect.sync(() => [...input.projects]),
      getShell: (projectId: OrchestrationProjectShell["id"]) =>
        Effect.sync(() =>
          Option.fromNullishOr(input.projects.find((project) => project.id === projectId)),
        ),
      getById: unused,
    } as unknown as ProjectService["Service"]),
  );
}

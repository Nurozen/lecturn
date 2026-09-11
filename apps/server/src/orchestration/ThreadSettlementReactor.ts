import { CommandId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { StaveMergeSignal } from "../stave/StaveMergeSignal.ts";
import * as GitManager from "../git/GitManager.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import {
  isAutoSettlementCandidate,
  resolveAutoSettlementAt,
  type SettlementPullRequest,
} from "./ThreadSettlementPolicy.ts";

export class ThreadSettlementReactor extends Context.Service<
  ThreadSettlementReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/ThreadSettlementReactor") {}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const git = yield* GitManager.GitManager;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const staveMergeSignal = yield* Effect.serviceOption(StaveMergeSignal);

  const sweep = Effect.fn("ThreadSettlementReactor.sweep")(function* (
    mergedPullRequest: PullRequestService.PullRequestMergeEvent | null,
  ) {
    const snapshot = yield* snapshots.getShellSnapshot();
    const now = DateTime.formatIso(yield* DateTime.now);
    const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
    const staveMerged =
      mergedPullRequest === null && Option.isSome(staveMergeSignal)
        ? yield* staveMergeSignal.value.candidates(snapshot.projects)
        : new Set();
    const candidates = snapshot.threads.filter(
      (thread) =>
        isAutoSettlementCandidate(thread, now) &&
        (mergedPullRequest === null ||
          (projects.get(thread.projectId)?.stave != null &&
            thread.projectId === mergedPullRequest.projectId) ||
          (thread.linkedPullRequest != null &&
            thread.linkedPullRequest.projectId === mergedPullRequest.projectId &&
            thread.linkedPullRequest.repository.toLowerCase() ===
              mergedPullRequest.repository.toLowerCase() &&
            thread.linkedPullRequest.number === mergedPullRequest.number &&
            (thread.linkedPullRequest.host === undefined ||
              mergedPullRequest.host === undefined ||
              thread.linkedPullRequest.host.toLowerCase() ===
                mergedPullRequest.host.toLowerCase()))),
    );
    const lookupKey = (thread: (typeof candidates)[number]) => {
      if (staveMerged.has(thread.projectId))
        return JSON.stringify(["stave-merged", thread.projectId]);
      if (projects.get(thread.projectId)?.stave)
        return JSON.stringify(["stave-space", thread.projectId, thread.linkedPullRequest ?? null]);
      if (thread.linkedPullRequest != null) {
        return JSON.stringify([
          "linked",
          thread.linkedPullRequest.projectId,
          thread.linkedPullRequest.repository,
          thread.linkedPullRequest.host ?? null,
          thread.linkedPullRequest.number,
        ]);
      }
      const project = projects.get(thread.projectId);
      const branch = thread.branch ?? project?.stave?.primaryBranch;
      if (branch == null) return JSON.stringify(["none", thread.id]);
      return JSON.stringify(
        project === undefined
          ? ["missing-project", thread.id]
          : ["branch", project.stave?.primaryRepoPath ?? project.workspaceRoot, branch],
      );
    };
    const groups = Map.groupBy(candidates, lookupKey);

    const pullRequestFor = Effect.fn("ThreadSettlementReactor.pullRequestFor")(function* (
      thread: (typeof candidates)[number],
    ) {
      const staveProject = projects.get(thread.projectId);
      if (staveProject?.stave) {
        if (staveProject.stave.state !== "live") return null;
        const repos = staveProject.stave.repos.filter((repo) => repo.mode === "edit");
        if (repos.length === 0) return null;
        const repoPullRequests = yield* Effect.forEach(
          repos,
          (repo) =>
            Effect.gen(function* () {
              const cwd = repo.resolvedPath ?? path.resolve(staveProject.workspaceRoot, repo.path);
              const status = yield* git.localStatus({ cwd });
              if (!status.isRepo || !status.refName) return null;
              return yield* git.branchPullRequest({ cwd, branch: status.refName });
            }),
          { concurrency: 4 },
        );
        // An explicitly linked PR may outlive the checkout branch it was opened from.
        // Its completion remains required even when all current checkout PRs have finished.
        if (thread.linkedPullRequest != null) {
          const linked = yield* pullRequests.summary(thread.linkedPullRequest, {
            recoverTransientFailure: false,
          });
          repoPullRequests.push({ state: linked.state, updatedAt: linked.updatedAt });
        }
        // Any open member keeps the whole space active. Unknown/missing members
        // cannot supply evidence for PR-based settlement.
        if (repoPullRequests.some((pr) => pr?.state === "open"))
          return { state: "open" as const, updatedAt: null };
        if (repoPullRequests.some((pr) => pr === null)) return null;
        const completed = repoPullRequests.filter((pr) => pr !== null);
        const timestamps = completed.map((pr) => pr.updatedAt);
        const updatedAt = timestamps.every(
          (value) => value != null && Number.isFinite(Date.parse(value)),
        )
          ? (timestamps.reduce((latest, value) =>
              Date.parse(value!) > Date.parse(latest!) ? value : latest,
            ) ?? null)
          : null;
        return {
          state: completed.every((pr) => pr.state === "closed")
            ? ("closed" as const)
            : ("merged" as const),
          updatedAt,
        };
      }
      if (thread.linkedPullRequest != null) {
        if (
          mergedPullRequest !== null &&
          (!projects.get(thread.linkedPullRequest.projectId)?.stave ||
            (thread.linkedPullRequest.host !== undefined &&
              thread.linkedPullRequest.host.toLowerCase() ===
                mergedPullRequest.host?.toLowerCase()))
        ) {
          return {
            state: "merged",
            updatedAt: mergedPullRequest.mergedAt,
          } satisfies SettlementPullRequest;
        }
        if (!projects.has(thread.linkedPullRequest.projectId)) {
          return yield* Effect.die(new Error("linked pull request project not found"));
        }
        const summary = yield* pullRequests.summary(
          {
            projectId: thread.linkedPullRequest.projectId,
            repository: thread.linkedPullRequest.repository,
            ...(thread.linkedPullRequest.host ? { host: thread.linkedPullRequest.host } : {}),
            number: thread.linkedPullRequest.number,
          },
          { recoverTransientFailure: false },
        );
        return {
          state: summary.state,
          updatedAt: summary.updatedAt,
        } satisfies SettlementPullRequest;
      }
      const project = projects.get(thread.projectId);
      const branch = thread.branch ?? project?.stave?.primaryBranch;
      if (branch == null) return null;
      if (project === undefined) {
        return yield* Effect.die(new Error("thread project not found"));
      }
      if (project.stave && (project.stave.state !== "live" || !project.stave.primaryRepoPath))
        return null;
      return yield* git.branchPullRequest({
        cwd: project.stave?.primaryRepoPath ?? project.workspaceRoot,
        branch,
      });
    });

    yield* Effect.forEach(
      groups.values(),
      (group) =>
        Effect.gen(function* () {
          const sagaMerged = staveMerged.has(group[0]!.projectId);
          const pullRequest = sagaMerged
            ? { state: "merged" as const, updatedAt: now }
            : yield* pullRequestFor(group[0]!);
          yield* Effect.forEach(
            group,
            (thread) =>
              Effect.gen(function* () {
                const settings = yield* settingsService.getSettings;
                if (
                  sagaMerged &&
                  (!settings.stave.enabled || !settings.stave.lifecycle.settleOnSagaMerge)
                )
                  return;
                const decisionNow = DateTime.formatIso(yield* DateTime.now);
                const settledAt = resolveAutoSettlementAt({
                  thread,
                  pullRequest,
                  now: decisionNow,
                  autoSettleAfterDays: settings.sidebarAutoSettleAfterDays,
                  autoSettleOnMerge:
                    (sagaMerged &&
                      settings.stave.enabled &&
                      settings.stave.lifecycle.settleOnSagaMerge) ||
                    settings.sidebarAutoSettleOnMerge,
                });
                if (settledAt === null) {
                  return;
                }
                const uuid = yield* crypto.randomUUIDv4;
                yield* engine.dispatch({
                  type: "thread.auto-settle",
                  commandId: CommandId.make(`server:auto-settle:${thread.id}:${uuid}`),
                  threadId: thread.id,
                  snapshotSequence: snapshot.snapshotSequence,
                  settledAt,
                });
              }).pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.failCause(cause)
                    : Effect.logWarning("automatic thread settlement skipped", {
                        threadId: thread.id,
                        cause: Cause.pretty(cause),
                      }),
                ),
              ),
            { discard: true },
          );
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("automatic thread settlement skipped", {
                  threadIds: group.map((thread) => thread.id),
                  cause: Cause.pretty(cause),
                }),
          ),
        ),
      { concurrency: 8, discard: true },
    );
  });

  const runSweep = (mergedPullRequest: PullRequestService.PullRequestMergeEvent | null) =>
    sweep(mergedPullRequest).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("automatic thread settlement sweep failed", {
              cause: Cause.pretty(cause),
            }),
      ),
    );
  const worker = yield* makeDrainableWorker(() => runSweep(null));

  const start: ThreadSettlementReactor["Service"]["start"] = Effect.fn(
    "ThreadSettlementReactor.start",
  )(function* () {
    const settingsChanges = yield* settingsService.subscribeChanges;
    const mergedPullRequests = yield* pullRequests.subscribeMerges;
    const initialSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
    let lastAfterDays = initialSettings.sidebarAutoSettleAfterDays;
    let lastOnMerge = initialSettings.sidebarAutoSettleOnMerge;
    let lastStaveEnabled = initialSettings.stave.enabled;
    let lastStaveMerge = initialSettings.stave.lifecycle.settleOnSagaMerge;
    yield* forkParked(
      Effect.gen(function* () {
        yield* worker.enqueue(undefined);
        yield* worker.drain;
      }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
    );
    yield* forkParked(
      Stream.runForEach(settingsChanges, (settings) => {
        if (
          settings.sidebarAutoSettleAfterDays === lastAfterDays &&
          settings.sidebarAutoSettleOnMerge === lastOnMerge &&
          settings.stave.enabled === lastStaveEnabled &&
          settings.stave.lifecycle.settleOnSagaMerge === lastStaveMerge
        ) {
          return Effect.void;
        }
        lastAfterDays = settings.sidebarAutoSettleAfterDays;
        lastOnMerge = settings.sidebarAutoSettleOnMerge;
        lastStaveEnabled = settings.stave.enabled;
        lastStaveMerge = settings.stave.lifecycle.settleOnSagaMerge;
        return worker.enqueue(undefined);
      }),
    );
    yield* forkParked(Stream.runForEach(mergedPullRequests, runSweep));
  });

  return { start, drain: worker.drain } satisfies ThreadSettlementReactor["Service"];
});

export const layer = Layer.effect(ThreadSettlementReactor, make);

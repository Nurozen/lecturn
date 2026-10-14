import { CommandId } from "@lecturn/contracts";
import { makeDrainableWorker } from "@lecturn/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
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
import { pullRequestMatchesProject } from "./ThreadPullRequestReactor.ts";
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
>()("lecturn/orchestration/ThreadSettlementReactor") {}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const git = yield* GitManager.GitManager;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const staveMergeSignal = yield* Effect.serviceOption(StaveMergeSignal);
  const fileSystem = yield* FileSystem.FileSystem;

  const sweep = Effect.fn("ThreadSettlementReactor.sweep")(function* (
    mergedPullRequest: PullRequestService.PullRequestMergeEvent | null,
  ) {
    const settings = yield* settingsService.getSettings;
    const ordinarySettlementEnabled =
      settings.sidebarAutoSettleOnMerge || settings.sidebarAutoSettleAfterDays !== null;
    const sagaSettlementEnabled =
      mergedPullRequest === null &&
      Option.isSome(staveMergeSignal) &&
      settings.stave.enabled &&
      settings.stave.lifecycle.settleOnSagaMerge;
    if (!ordinarySettlementEnabled && !sagaSettlementEnabled) {
      return;
    }
    const snapshot = yield* snapshots.getShellSnapshot();
    const now = DateTime.formatIso(yield* DateTime.now);
    const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
    const staveMerged =
      sagaSettlementEnabled && Option.isSome(staveMergeSignal)
        ? yield* staveMergeSignal.value.candidates(snapshot.projects)
        : new Set();
    // A merge rechecks all candidates, including branches that discovery has
    // not linked yet. Those lookups can still have cached the PR as open.
    const candidates = snapshot.threads.filter(
      (thread) =>
        (ordinarySettlementEnabled || staveMerged.has(thread.projectId)) &&
        isAutoSettlementCandidate(thread, now),
    );

    // Return the thread when it still needs a pull request decision. A rejected
    // dispatch skips it for this snapshot instead of retrying through a lookup.
    const settleThread = Effect.fn("ThreadSettlementReactor.settleThread")(
      function* (
        thread: (typeof candidates)[number],
        pullRequest: SettlementPullRequest | null,
        sagaMerged = false,
      ) {
        const settings = yield* settingsService.getSettings;
        if (sagaMerged && (!settings.stave.enabled || !settings.stave.lifecycle.settleOnSagaMerge))
          return null;
        const decisionNow = DateTime.formatIso(yield* DateTime.now);
        const settledAt = resolveAutoSettlementAt({
          thread,
          pullRequest,
          now: decisionNow,
          autoSettleAfterDays: settings.sidebarAutoSettleAfterDays,
          autoSettleOnMerge: sagaMerged || settings.sidebarAutoSettleOnMerge,
        });
        if (settledAt === null) {
          return thread;
        }
        const uuid = yield* crypto.randomUUIDv4;
        yield* engine.dispatch({
          type: "thread.auto-settle",
          commandId: CommandId.make(`server:auto-settle:${thread.id}:${uuid}`),
          threadId: thread.id,
          snapshotSequence: snapshot.snapshotSequence,
          settledAt,
        });
        return null;
      },
      (effect, thread) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("automatic thread settlement skipped", {
                  threadId: thread.id,
                  cause: Cause.pretty(cause),
                }).pipe(Effect.as(null)),
          ),
        ),
    );

    // Inactivity needs no host state. Finish these decisions before any lookup
    // can fail or wait on the network, including lookups shared by recent threads.
    const lookupCandidates = (yield* Effect.forEach(
      candidates,
      (thread) =>
        projects.get(thread.projectId)?.stave ? Effect.succeed(thread) : settleThread(thread, null),
      {
        concurrency: 8,
      },
    )).filter((thread) => thread !== null);

    // Use the same cwd as PR discovery so both paths share GitManager's cache.
    const lookupCwdByThreadId = new Map<string, string>();
    yield* Effect.forEach(
      lookupCandidates,
      (thread) =>
        Effect.gen(function* () {
          const project = projects.get(thread.projectId);
          if (project === undefined || project.stave != null || thread.branch === null) return;
          const worktreeExists =
            thread.worktreePath !== null &&
            (yield* fileSystem.exists(thread.worktreePath).pipe(Effect.orElseSucceed(() => false)));
          lookupCwdByThreadId.set(
            thread.id,
            worktreeExists && thread.worktreePath !== null
              ? thread.worktreePath
              : project.workspaceRoot,
          );
        }),
      { concurrency: 8, discard: true },
    );
    if (mergedPullRequest !== null) {
      // The merge confirmed a state the branch cache can still call open.
      // Recheck those branches now instead of waiting for cache expiry.
      const cwds = [...new Set(lookupCwdByThreadId.values())];
      yield* Effect.forEach(cwds, (cwd) => git.invalidateStatus(cwd), {
        concurrency: 8,
        discard: true,
      });
    }
    const lookupKey = (thread: (typeof candidates)[number]) => {
      if (staveMerged.has(thread.projectId))
        return JSON.stringify(["stave-merged", thread.projectId]);
      if (projects.get(thread.projectId)?.stave)
        return JSON.stringify(["stave-space", thread.projectId, thread.linkedPullRequest ?? null]);
      const reference = thread.linkedPullRequest ?? thread.branchPullRequest;
      if (reference != null) {
        return JSON.stringify([
          "linked",
          reference.projectId,
          reference.repository,
          reference.host ?? null,
          reference.number,
          lookupCwdByThreadId.get(thread.id),
          thread.branch,
        ]);
      }
      if (thread.branch === null) return JSON.stringify(["none", thread.id]);
      const cwd = lookupCwdByThreadId.get(thread.id);
      return JSON.stringify(
        cwd === undefined ? ["missing-project", thread.id] : ["branch", cwd, thread.branch],
      );
    };
    const groups = Map.groupBy(lookupCandidates, lookupKey);

    const pullRequestFor = Effect.fn("ThreadSettlementReactor.pullRequestFor")(function* (
      thread: (typeof candidates)[number],
    ) {
      const staveProject = projects.get(thread.projectId);
      if (staveProject?.stave) {
        if (staveProject.stave.state !== "live") return null;
        const repos = staveProject.stave.repos.filter((repo) => repo.mode === "edit");
        if (repos.length === 0) return null;
        const repoPullRequests: Array<SettlementPullRequest | null> = yield* Effect.forEach(
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
          repoPullRequests.push({
            state: linked.state,
            updatedAt: linked.updatedAt,
            closedAt: linked.closedAt ?? null,
            mergedAt: linked.mergedAt ?? null,
          });
        }
        // Any open member keeps the whole space active. Unknown/missing members
        // cannot supply evidence for PR-based settlement.
        if (repoPullRequests.some((pr) => pr?.state === "open"))
          return { state: "open" as const, updatedAt: null };
        if (repoPullRequests.some((pr) => pr === null)) return null;
        const completed = repoPullRequests.filter((pr) => pr !== null);
        const timestamps = completed.map((pr) =>
          pr.state === "merged" ? pr.mergedAt : pr.closedAt,
        );
        const terminalAt = timestamps.every(
          (value) => value != null && Number.isFinite(Date.parse(value)),
        )
          ? (timestamps.reduce((latest, value) =>
              Date.parse(value!) > Date.parse(latest!) ? value : latest,
            ) ?? null)
          : null;
        return completed.every((pr) => pr.state === "closed")
          ? ({ state: "closed", closedAt: terminalAt } satisfies SettlementPullRequest)
          : ({ state: "merged", mergedAt: terminalAt } satisfies SettlementPullRequest);
      }
      const reference = thread.linkedPullRequest ?? thread.branchPullRequest;
      if (reference != null) {
        const linkedHostMatches =
          mergedPullRequest !== null &&
          (projects.get(reference.projectId)?.stave
            ? reference.host !== undefined &&
              reference.host.toLowerCase() === mergedPullRequest.host?.toLowerCase()
            : reference.host === undefined ||
              mergedPullRequest.host === undefined ||
              reference.host.toLowerCase() === mergedPullRequest.host.toLowerCase());
        const matchesMerge =
          mergedPullRequest !== null &&
          reference.projectId === mergedPullRequest.projectId &&
          reference.repository.toLowerCase() === mergedPullRequest.repository.toLowerCase() &&
          reference.number === mergedPullRequest.number &&
          linkedHostMatches;
        if (!matchesMerge && !projects.has(reference.projectId)) {
          return yield* Effect.die(new Error("linked pull request project not found"));
        }
        const summary = matchesMerge
          ? ({
              state: "merged",
              closedAt: null,
              mergedAt: mergedPullRequest.mergedAt,
            } satisfies SettlementPullRequest)
          : yield* pullRequests.summary(
              {
                projectId: reference.projectId,
                repository: reference.repository,
                ...(reference.host ? { host: reference.host } : {}),
                number: reference.number,
              },
              { recoverTransientFailure: false },
            );
        const cwd = lookupCwdByThreadId.get(thread.id);
        if (summary.state !== "open" && thread.branch !== null && cwd !== undefined) {
          // A reused branch can already have a new open PR while discovery
          // is replacing its old link. Do not let settlement win that race.
          const current = yield* git.branchPullRequest(
            { cwd, branch: thread.branch },
            { refresh: true },
          );
          const project = projects.get(thread.projectId);
          if (
            current?.state === "open" &&
            project !== undefined &&
            pullRequestMatchesProject(current, project)
          ) {
            return current;
          }
        }
        return {
          state: summary.state,
          closedAt: summary.closedAt ?? null,
          mergedAt: summary.mergedAt ?? null,
        } satisfies SettlementPullRequest;
      }
      if (thread.branch === null) return null;
      const cwd = lookupCwdByThreadId.get(thread.id);
      if (cwd === undefined) {
        return yield* Effect.die(new Error("thread project not found"));
      }
      return yield* git.branchPullRequest({ cwd, branch: thread.branch });
    });

    yield* Effect.forEach(
      groups.values(),
      (group) =>
        Effect.gen(function* () {
          const sagaMerged = staveMerged.has(group[0]!.projectId);
          const pullRequest = sagaMerged
            ? { state: "merged" as const, mergedAt: now }
            : yield* pullRequestFor(group[0]!);
          // Ordinary threads with an open pull request still settle by
          // inactivity. A live Stave space does not: settling its threads can
          // schedule the whole space for archive while a member PR is in review.
          if (pullRequest?.state === "open" && projects.get(group[0]!.projectId)?.stave) return;
          yield* Effect.forEach(group, (thread) => settleThread(thread, pullRequest, sagaMerged), {
            discard: true,
          });
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

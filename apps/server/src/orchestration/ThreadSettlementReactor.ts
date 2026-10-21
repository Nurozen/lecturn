import {
  CommandId,
  type OrchestrationEvent,
  type ServerSettings as ServerSettingsValue,
  type ThreadId,
} from "@lecturn/contracts";
import { resolveProjectSettings } from "@lecturn/shared/projectSettings";
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

/** @public Service construction is part of the canonical Effect module API. */
/** Whether any environment default or project override can settle a thread. */
function autoSettlementConfigured(settings: ServerSettingsValue): boolean {
  if (settings.sidebarAutoSettleOnMerge || settings.sidebarAutoSettleAfterDays !== null) {
    return true;
  }
  return Object.values(settings.projectSettingsOverrides).some(
    (entry) =>
      entry.sidebarAutoSettleOnMerge === true ||
      (entry.sidebarAutoSettleAfterDays !== undefined && entry.sidebarAutoSettleAfterDays !== null),
  );
}

/** Identity of every settlement input, so unrelated settings edits do not trigger a sweep. */
/** @internal Exported for tests. */
export function autoSettlementSettingsKey(settings: ServerSettingsValue): string {
  return JSON.stringify([
    settings.sidebarAutoSettleOnMerge,
    settings.sidebarAutoSettleAfterDays,
    // Only entries that touch settlement, in a stable order, so a project
    // override on an unrelated key does not queue a sweep. JSON drops
    // undefined, so inherit (absent) and never (null) need distinct marks.
    Object.entries(settings.projectSettingsOverrides)
      .filter(
        ([, entry]) =>
          entry.sidebarAutoSettleOnMerge !== undefined ||
          entry.sidebarAutoSettleAfterDays !== undefined,
      )
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([projectId, entry]) => [
        projectId,
        entry.sidebarAutoSettleOnMerge ?? "inherit",
        entry.sidebarAutoSettleAfterDays === undefined
          ? "inherit"
          : entry.sidebarAutoSettleAfterDays,
      ]),
  ]);
}

/** Settlement inputs plus the Stave saga-merge toggles that also drive a sweep. */
function settlementSweepKey(settings: ServerSettingsValue): string {
  return JSON.stringify([
    autoSettlementSettingsKey(settings),
    settings.stave.enabled,
    settings.stave.lifecycle.settleOnSagaMerge,
  ]);
}

/** @public Service construction is part of the canonical Effect module API. */
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
    threadId?: ThreadId,
  ) {
    const settings = yield* settingsService.getSettings;
    const ordinarySettlementEnabled = autoSettlementConfigured(settings);
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
        (threadId === undefined || thread.id === threadId) &&
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
        const settings = resolveProjectSettings(
          yield* settingsService.getSettings,
          thread.projectId,
        ).settings;
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
    ))
      .filter((thread) => thread !== null)
      // Linked pull requests already decided above through the policy. Stave
      // spaces still resolve their member checkouts below.
      .filter(
        (thread) =>
          projects.get(thread.projectId)?.stave != null ||
          !thread.pullRequests.some((link) => link.source !== "stack-dismissed"),
      );

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

    const wouldSettle = Effect.fn("ThreadSettlementReactor.wouldSettle")(function* (
      group: ReadonlyArray<(typeof candidates)[number]>,
      pullRequest: SettlementPullRequest,
    ) {
      const currentSettings = yield* settingsService.getSettings;
      const decisionNow = DateTime.formatIso(yield* DateTime.now);
      return group.some((thread) => {
        const { settings } = resolveProjectSettings(currentSettings, thread.projectId);
        return (
          resolveAutoSettlementAt({
            thread,
            pullRequest,
            now: decisionNow,
            autoSettleAfterDays: settings.sidebarAutoSettleAfterDays,
            autoSettleOnMerge: settings.sidebarAutoSettleOnMerge,
          }) !== null
        );
      });
    });

    const pullRequestFor = Effect.fn("ThreadSettlementReactor.pullRequestFor")(function* (
      group: ReadonlyArray<(typeof candidates)[number]>,
    ) {
      const thread = group[0]!;
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
        const terminal = {
          state: summary.state,
          closedAt: summary.closedAt ?? null,
          mergedAt: summary.mergedAt ?? null,
        } satisfies SettlementPullRequest;
        const cwd = lookupCwdByThreadId.get(thread.id);
        if (summary.state !== "open" && thread.branch !== null && cwd !== undefined) {
          // A reused branch can already have a new open PR while discovery
          // is replacing its old link. Do not let settlement win that race.
          // Only pay for the uncached lookup when this sweep would otherwise
          // settle: a terminal link that settles nothing (resumed thread,
          // settle-on-merge off) would re-query the host every minute. A
          // group that becomes eligible after this check waits for the next
          // sweep rather than settling on the unverified link.
          if (!(yield* wouldSettle(group, terminal))) return undefined;
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
        return terminal;
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
            : yield* pullRequestFor(group);
          // A terminal link that would settle nothing skips this sweep.
          if (pullRequest === undefined) return;
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

  const runSweep = (
    mergedPullRequest: PullRequestService.PullRequestMergeEvent | null,
    threadId?: ThreadId,
  ) =>
    sweep(mergedPullRequest, threadId).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("automatic thread settlement sweep failed", {
              cause: Cause.pretty(cause),
            }),
      ),
    );
  const worker = yield* makeDrainableWorker((threadId: ThreadId | undefined) =>
    runSweep(null, threadId),
  );

  const processEvent = (event: OrchestrationEvent) => {
    switch (event.type) {
      case "thread.pull-request-linked":
      case "thread.pull-request-synced":
      case "thread.pull-request-unlinked":
        // Merge notifications can arrive before the linked snapshot is projected.
        // Recheck the persisted state so terminal links settle without the timer.
        return worker.enqueue(event.payload.threadId);
      case "thread.session-set":
        if (
          event.payload.session.status !== "running" &&
          event.payload.session.status !== "starting"
        ) {
          return worker.enqueue(event.payload.threadId);
        }
        break;
    }
    return Effect.void;
  };

  const start: ThreadSettlementReactor["Service"]["start"] = Effect.fn(
    "ThreadSettlementReactor.start",
  )(function* () {
    const settingsChanges = yield* settingsService.subscribeChanges;
    const mergedPullRequests = yield* pullRequests.subscribeMerges;
    const events = yield* engine.subscribeDomainEvents;
    const initialSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
    let lastSettlementSettings = settlementSweepKey(initialSettings);
    yield* forkParked(
      Effect.gen(function* () {
        yield* worker.enqueue(undefined);
        yield* worker.drain;
      }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
    );
    yield* forkParked(
      Stream.runForEach(settingsChanges, (settings) => {
        const key = settlementSweepKey(settings);
        if (key === lastSettlementSettings) {
          return Effect.void;
        }
        lastSettlementSettings = key;
        return worker.enqueue(undefined);
      }),
    );
    yield* forkParked(Stream.runForEach(mergedPullRequests, (event) => runSweep(event)));
    yield* forkParked(Stream.runForEach(events, processEvent));
  });

  return { start, drain: worker.drain } satisfies ThreadSettlementReactor["Service"];
});

export const layer = Layer.effect(ThreadSettlementReactor, make);

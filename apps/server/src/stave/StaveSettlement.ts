/**
 * StaveSettlement - Stave evidence for V2 automatic thread settlement.
 *
 * Re-homed from the V1 ThreadSettlementReactor Stave branches so the V2
 * `ThreadSettlementService` only needs a few calls:
 * - `decorateProjects`: project shells with their Stave fields, so the sweep
 *   knows which projects are spaces;
 * - `sagaMergedProjects`: spaces whose saga merged (settle-on-saga-merge);
 * - `spacePullRequest`: one aggregate pull request decision for a thread in a
 *   live space, read from every editable checkout plus the thread's explicit
 *   link. Any open member keeps the whole space active; missing evidence
 *   decides nothing; terminal members settle at the latest terminal time.
 * Pure helpers (`aggregateSpacePullRequests`, `linkedHostMatchesMerge`) carry
 * the decisions that do not need I/O.
 *
 * @module StaveSettlement
 */
import type {
  GitManagerServiceError,
  OrchestrationProjectShell,
  ProjectId,
  ThreadLinkedPullRequest,
} from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as GitManager from "../git/GitManager.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { StaveMergeSignal } from "./StaveMergeSignal.ts";
import { StaveProjectShells } from "./StaveProjectShells.ts";

/** Structurally the V2 `SettlementPullRequest`. */
export interface StaveSettlementPullRequest {
  readonly state: "open" | "closed" | "merged";
  readonly closedAt?: string | null;
  readonly mergedAt?: string | null;
}

export interface StaveMemberPullRequest {
  readonly state: "open" | "closed" | "merged";
  readonly closedAt?: string | null | undefined;
  readonly mergedAt?: string | null | undefined;
}

/**
 * One decision for a space from its members' pull requests (`null` = a member
 * has no evidence). Any open member keeps the space active.
 */
export function aggregateSpacePullRequests(
  members: ReadonlyArray<StaveMemberPullRequest | null>,
): StaveSettlementPullRequest | null {
  if (members.some((member) => member?.state === "open")) return { state: "open" };
  if (members.length === 0 || members.some((member) => member === null)) return null;
  const completed = members.filter((member): member is StaveMemberPullRequest => member !== null);
  const timestamps = completed.map((member) =>
    member.state === "merged" ? member.mergedAt : member.closedAt,
  );
  const terminalAt = timestamps.every(
    (value) => value != null && Number.isFinite(Date.parse(value)),
  )
    ? (timestamps.reduce((latest, value) =>
        Date.parse(value!) > Date.parse(latest!) ? value : latest,
      ) ?? null)
    : null;
  return completed.every((member) => member.state === "closed")
    ? { state: "closed", closedAt: terminalAt }
    : { state: "merged", mergedAt: terminalAt };
}

/**
 * Whether a merge event's host can settle a saved link. Links in a Stave space
 * always carry their host and must match it; ordinary links match when either
 * side predates hosts.
 */
export function linkedHostMatchesMerge(
  reference: Pick<ThreadLinkedPullRequest, "host">,
  mergeHost: string | undefined,
  referenceProjectIsSpace: boolean,
): boolean {
  return referenceProjectIsSpace
    ? reference.host !== undefined && reference.host.toLowerCase() === mergeHost?.toLowerCase()
    : reference.host === undefined ||
        mergeHost === undefined ||
        reference.host.toLowerCase() === mergeHost.toLowerCase();
}

export interface StaveSettlementShape {
  readonly decorateProjects: (
    projects: ReadonlyArray<OrchestrationProjectShell>,
  ) => Effect.Effect<ReadonlyArray<OrchestrationProjectShell>>;
  /** Spaces whose saga merged; empty unless settle-on-saga-merge is enabled. */
  readonly sagaMergedProjects: (
    projects: ReadonlyArray<OrchestrationProjectShell>,
  ) => Effect.Effect<ReadonlySet<ProjectId>>;
  /** Aggregate evidence for a thread in a live space; `null` decides nothing. */
  readonly spacePullRequest: (input: {
    readonly project: OrchestrationProjectShell;
    readonly linkedPullRequest: ThreadLinkedPullRequest | null | undefined;
  }) => Effect.Effect<
    StaveSettlementPullRequest | null,
    GitManagerServiceError | PullRequestService.PullRequestError
  >;
}

export class StaveSettlement extends Context.Service<StaveSettlement, StaveSettlementShape>()(
  "lecturn/stave/StaveSettlement",
) {}

export const make = Effect.gen(function* () {
  const git = yield* GitManager.GitManager;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const path = yield* Path.Path;
  const shells = yield* Effect.serviceOption(StaveProjectShells);
  const mergeSignal = yield* Effect.serviceOption(StaveMergeSignal);

  const spacePullRequest: StaveSettlementShape["spacePullRequest"] = ({
    project,
    linkedPullRequest,
  }) =>
    Effect.gen(function* () {
      const stave = project.stave;
      if (stave == null || stave.state !== "live") return null;
      const repos = stave.repos.filter((repo) => repo.mode === "edit");
      if (repos.length === 0) return null;
      const members: Array<StaveMemberPullRequest | null> = yield* Effect.forEach(
        repos,
        (repo) =>
          Effect.gen(function* () {
            const cwd = repo.resolvedPath ?? path.resolve(project.workspaceRoot, repo.path);
            const status = yield* git.localStatus({ cwd });
            if (!status.isRepo || !status.refName) return null;
            return yield* git.branchPullRequest({ cwd, branch: status.refName });
          }),
        { concurrency: 4 },
      );
      // An explicitly linked PR may outlive the checkout branch it was opened from.
      // Its completion remains required even when all current checkout PRs have finished.
      if (linkedPullRequest != null) {
        const linked = yield* pullRequests.summary(linkedPullRequest, {
          recoverTransientFailure: false,
        });
        members.push({
          state: linked.state,
          closedAt: linked.closedAt ?? null,
          mergedAt: linked.mergedAt ?? null,
        });
      }
      return aggregateSpacePullRequests(members);
    });

  return StaveSettlement.of({
    decorateProjects: (projects) =>
      Option.isSome(shells) ? shells.value.decorate(projects) : Effect.succeed(projects),
    sagaMergedProjects: (projects) =>
      Option.isSome(mergeSignal)
        ? mergeSignal.value.candidates(projects)
        : Effect.succeed(new Set<ProjectId>()),
    spacePullRequest,
  });
});

export const layer = Layer.effect(StaveSettlement, make);

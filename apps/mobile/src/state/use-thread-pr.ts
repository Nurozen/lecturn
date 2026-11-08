import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@lecturn/client-runtime/state/shell";
import {
  createLinkedPullRequestSummaryAtomFamily,
  pullRequestDetailToVcsStatus,
} from "@lecturn/client-runtime/state/pull-requests";
import type {
  EnvironmentId,
  OrchestrationProjectShell,
  PullRequestSummary,
} from "@lecturn/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { serverEnvironment } from "./server";
import { useEnvironmentQuery } from "./query";
import {
  rememberBounded,
  resolveThreadPrSource,
  presentThreadPr,
  type ThreadPrPresentation,
} from "./thread-pr-presentation";

const MAX_PULL_REQUEST_SNAPSHOTS = 500;

// One bounded cache survives row virtualization (the summary query is dropped once idle) without
// retaining one live atom for every pull request ever seen.
const pullRequestSnapshotsAtom = Atom.make<ReadonlyMap<string, PullRequestSummary>>(new Map()).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-pr-snapshots"),
);

function snapshotKey(
  environmentId: EnvironmentId,
  reference: { readonly projectId: string; readonly repository: string; readonly number: number },
): string {
  return JSON.stringify([
    environmentId,
    reference.projectId,
    reference.repository,
    reference.number,
  ]);
}

const pullRequestSummaryAtom = createLinkedPullRequestSummaryAtomFamily(
  connectionAtomRuntime,
  undefined,
  ({ environmentId, input }, summary, registry) =>
    Effect.sync(() =>
      registry.update(pullRequestSnapshotsAtom, (current) =>
        rememberBounded(
          current,
          snapshotKey(environmentId, input),
          summary,
          MAX_PULL_REQUEST_SNAPSHOTS,
        ),
      ),
    ),
);

export {
  presentThreadPr,
  type ThreadPr,
  type ThreadPrPresentation,
} from "./thread-pr-presentation";

export type ThreadPrProject = Pick<OrchestrationProjectShell, "workspaceRoot" | "stave">;

/**
 * Stave spaces with several editable repos keep explicit links without showing
 * one inferred repo as the whole space.
 */
export function useThreadPr(
  thread: EnvironmentThreadShell,
  project: ThreadPrProject | null,
): ThreadPrPresentation | null {
  const supportsLinks = useAtomValue(
    serverEnvironment.configValueAtom(thread.environmentId),
    (config) => config?.environment.capabilities.threadPullRequests === true,
  );
  const { linkedPresentation, pullRequestRef } = useMemo(
    () =>
      resolveThreadPrSource(
        {
          pullRequests: thread.pullRequests,
          linkedPullRequest: thread.linkedPullRequest,
          branchPullRequest: thread.branchPullRequest,
        },
        { threadPullRequests: supportsLinks },
        project,
      ),
    [
      thread.pullRequests,
      thread.linkedPullRequest,
      thread.branchPullRequest,
      supportsLinks,
      project,
    ],
  );
  const key = pullRequestRef === null ? null : snapshotKey(thread.environmentId, pullRequestRef);
  // Select this row's entry so answers for other pull requests do not re-render it.
  const snapshot = useAtomValue(pullRequestSnapshotsAtom, (current) =>
    key === null ? undefined : current.get(key),
  );
  const pullRequestSummary = useEnvironmentQuery(
    pullRequestRef === null
      ? null
      : pullRequestSummaryAtom({
          environmentId: thread.environmentId,
          input: {
            projectId: pullRequestRef.projectId,
            repository: pullRequestRef.repository,
            number: pullRequestRef.number,
            ...(pullRequestRef.host ? { host: pullRequestRef.host } : {}),
          },
        }),
  );
  const summary = pullRequestRef === null ? undefined : (pullRequestSummary.data ?? snapshot);
  // Rows pass `pr` into callbacks; a fresh object per render would invalidate them.
  const summaryPresentation = useMemo(
    () =>
      summary === undefined
        ? null
        : presentThreadPr(pullRequestDetailToVcsStatus(summary), {
            kind: summary.provider,
            name: summary.provider,
            baseUrl: "",
          }),
    [summary],
  );
  return linkedPresentation ?? summaryPresentation;
}

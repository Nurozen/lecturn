import { activityProjectIcon } from "./activityProjectIcon";
import { selectMergeHandoffThread } from "@lecturn/client-runtime/state/pullRequestHandoff";
import { isRepositoryWatchManagerEligible } from "@lecturn/client-runtime/state/repositoryScope";
import { scopedThreadKey } from "@lecturn/client-runtime/environment";
import {
  activityVisualState,
  describeThreadActivity,
  threadActivityExcerpt,
} from "@lecturn/client-runtime/state/activityContext";
import type {
  EnvironmentThread,
  EnvironmentThreadShell,
} from "@lecturn/client-runtime/state/models";
import {
  deriveLogicalProjectKeyFromSettings,
  type ProjectGroupingSettings,
  type SagaProjectIndexEntry,
} from "@lecturn/client-runtime/state/project-grouping";
import {
  resolveRepositoryScope,
  type RepositoryScopeProject,
} from "@lecturn/client-runtime/state/repositoryScope";
import type { OrchestrationProjectShell, ScopedProjectRef } from "@lecturn/contracts";
import type {
  DesktopActivityAction,
  DesktopActivityRow,
  DesktopActivitySnapshot,
  EnvironmentId,
  PullRequestWatchSnapshot,
} from "@lecturn/contracts";

export function watchActivityRows(
  values: readonly (readonly [EnvironmentId, PullRequestWatchSnapshot])[],
  threads: readonly EnvironmentThreadShell[] = [],
  details: readonly (EnvironmentThread | null)[] = [],
  projects: readonly RepositoryScopeProject[] = [],
  sagaIndex?: readonly SagaProjectIndexEntry[],
): DesktopActivityRow[] {
  return values.flatMap(([environmentId, snapshot]) =>
    snapshot.watches
      .filter((watch) => watch.watching)
      .toSorted(
        (a, b) =>
          Number(Boolean(b.error)) - Number(Boolean(a.error)) ||
          b.updatedAt.localeCompare(a.updatedAt),
      )
      .map((watch): DesktopActivityRow => {
        const eligible = threads.filter(
          (thread) =>
            !thread.archivedAt &&
            isRepositoryWatchManagerEligible({
              projects,
              ...(sagaIndex ? { sagaIndex } : {}),
              environmentId,
              thread,
              watch,
            }),
        );
        const recipient = selectMergeHandoffThread(watch, eligible);
        const legacyAuthorization =
          watch.authorization !== null &&
          ["waiting", "armed", "blocked"].includes(watch.authorization.status);
        return {
          id: JSON.stringify([environmentId, watch.id]),
          environmentId,
          projectId: watch.reference.projectId,
          watchId: watch.id,
          watchRevision: watch.revision,
          defaultMergeMode: watch.authorization?.mode ?? snapshot.defaultMergeMode,
          ...(recipient
            ? { threadId: recipient.id, mergeRecipient: recipient.title.slice(0, 300) }
            : {}),
          title: `${watch.reference.repository} #${watch.reference.number}`,
          subtitle: watch.observation?.title ?? "Awaiting observation",
          status: `${watch.error ? "Error · " : ""}${watch.observation?.state === "merged" ? "Merged · " : ""}${watch.managerStatus} · checks ${watch.observation?.checksState ?? "unknown"}`,
          checkTotal: watch.observation?.checks.length ?? 0,
          checks: (watch.observation?.checks ?? []).slice(0, 50).map((check) => ({
            name: check.name.slice(0, 300),
            status: check.status,
            ...(check.description ? { description: check.description.slice(0, 500) } : {}),
          })),
          mergeStatus: legacyAuthorization
            ? `Existing server merge authorization: ${watch.authorization!.status}. Revoke it before handing control to an agent.`
            : recipient
              ? `Send a merge-when-ready instruction to ${recipient.title}.`.slice(0, 1000)
              : "Choose an associated thread to handle this PR.",
          detail: [
            watch.error,
            watch.observation
              ? `Required checks: ${watch.observation.requiredChecks} · Observed ${new Date(watch.observation.observedAt).toLocaleString()}`
              : "Not yet observed",
            ...eligible
              .filter(
                (thread) =>
                  watch.threadIds.includes(thread.id) || thread.id === watch.managerThreadId,
              )
              .slice(0, 3)
              .map((thread) =>
                thread.id === recipient?.id
                  ? `Agent thread: ${thread.title}\n${describeThreadActivity(thread, details.find((item) => item?.environmentId === environmentId && item.id === thread.id)?.messages)}`
                  : `Associated thread: ${thread.title}`,
              ),
          ]
            .filter(Boolean)
            .join("\n"),
          actions: [
            { id: "open", label: "Open PR" },
            { id: "stop-watch", label: "Stop watching" },
            {
              id: "merge",
              label: recipient ? "Merge when ready" : "Choose agent",
              disabled: legacyAuthorization || watch.observation?.state !== "open",
            },
            ...(watch.authorization
              ? [{ id: "revoke-merge" as const, label: "Revoke merge" }]
              : []),
            ...(recipient ? [{ id: "steer" as const, label: "Steer thread" }] : []),
          ],
        };
      }),
  );
}

/** Match the whole published identity before routing a native request to an environment. */
export function resolveActivityAction(
  action: DesktopActivityAction,
  rows: readonly DesktopActivityRow[],
) {
  return (
    rows.find(
      (row) =>
        row.id === action.rowId &&
        row.environmentId === action.environmentId &&
        row.projectId === action.projectId &&
        row.threadId === action.threadId &&
        row.watchId === action.watchId &&
        row.watchRevision === action.watchRevision &&
        row.actions.some((candidate) => candidate.id === action.kind && !candidate.disabled),
    ) ?? null
  );
}

/** Project folders union their children; saga roots additionally expand their spaces. */
export function scopedPullRequestProjectIds(
  projects: readonly RepositoryScopeProject[],
  root: ScopedProjectRef,
  settings: ProjectGroupingSettings,
  sagaIndex?: readonly SagaProjectIndexEntry[],
) {
  const project = projects.find(
    (item) => item.environmentId === root.environmentId && item.id === root.projectId,
  );
  if (!project) return [root.projectId];
  const key = deriveLogicalProjectKeyFromSettings(project, settings);
  const roots = projects
    .filter(
      (item) =>
        item.environmentId === root.environmentId &&
        deriveLogicalProjectKeyFromSettings(item, settings) === key,
    )
    .map((item) => ({ environmentId: item.environmentId, projectId: item.id }));
  const targets = resolveRepositoryScope({ projects, roots, ...(sagaIndex ? { sagaIndex } : {}) });
  return [
    ...new Set([
      ...roots.map((item) => item.projectId),
      ...targets.flatMap((item) => item.projectIds),
    ]),
  ];
}

export function threadActivityRows(
  threads: readonly (Pick<
    EnvironmentThreadShell,
    | "id"
    | "environmentId"
    | "projectId"
    | "title"
    | "modelSelection"
    | "session"
    | "archivedAt"
    | "backgroundLiveness"
    | "hasPendingApprovals"
    | "hasPendingUserInput"
  > &
    Partial<
      Pick<EnvironmentThreadShell, "planProgress" | "latestUserMessageAt" | "settledOverride">
    >)[],
  connected: ReadonlySet<EnvironmentId>,
  interactions: Readonly<Record<string, string>> = {},
): DesktopActivityRow[] {
  const keyOf = (thread: { environmentId: EnvironmentId; id: EnvironmentThreadShell["id"] }) =>
    scopedThreadKey({ environmentId: thread.environmentId, threadId: thread.id });
  const interactedAt = (thread: (typeof threads)[number]) =>
    [interactions[keyOf(thread)], thread.latestUserMessageAt]
      .filter((at): at is string => typeof at === "string")
      .sort()
      .at(-1) ?? "";
  const recent = new Set(
    threads
      .filter((thread) => !thread.archivedAt && interactedAt(thread))
      .toSorted(
        (a, b) =>
          interactedAt(b).localeCompare(interactedAt(a)) || keyOf(a).localeCompare(keyOf(b)),
      )
      .slice(0, 3)
      .map(keyOf),
  );
  return threads
    .filter(
      (thread) =>
        !thread.archivedAt &&
        (recent.has(keyOf(thread)) ||
          (connected.has(thread.environmentId) &&
            (thread.session?.status === "running" ||
              thread.session?.status === "starting" ||
              thread.session?.status === "error" ||
              thread.backgroundLiveness ||
              thread.hasPendingApprovals ||
              thread.hasPendingUserInput))),
    )
    .toSorted(
      (a, b) =>
        Number(recent.has(keyOf(b))) - Number(recent.has(keyOf(a))) ||
        interactedAt(b).localeCompare(interactedAt(a)),
    )
    .map((thread) => ({
      id: JSON.stringify([thread.environmentId, "thread", thread.id]),
      environmentId: thread.environmentId,
      projectId: thread.projectId,
      threadId: thread.id,
      recent: recent.has(keyOf(thread)),
      title: thread.title,
      subtitle: thread.modelSelection.model,
      detail: describeThreadActivity(thread),
      status:
        thread.settledOverride === "settled"
          ? "Settled"
          : thread.hasPendingApprovals
            ? "Needs approval"
            : thread.hasPendingUserInput
              ? "Needs input"
              : thread.session?.status === "error"
                ? "Agent error"
                : thread.backgroundLiveness === "monitoring"
                  ? "Monitoring"
                  : thread.session?.status === "running" ||
                      thread.session?.status === "starting" ||
                      thread.backgroundLiveness === "working"
                    ? "Working"
                    : thread.session?.status === "interrupted" ||
                        thread.session?.status === "stopped"
                      ? "Stopped"
                      : "Idle",
      actions: [
        { id: "open", label: "Open thread" },
        { id: "steer", label: "Steer thread" },
      ],
    }));
}

/** Keep IPC publication within the shell's bounds as watch history grows. */
export function boundedActivitySnapshot(
  rows: readonly DesktopActivityRow[],
): DesktopActivitySnapshot {
  const visible = rows.slice(0, 200).map((row) => ({
    ...row,
    title: row.title.slice(0, 300),
    subtitle: row.subtitle.slice(0, 300),
    ...(row.detail ? { detail: row.detail.slice(0, 3000) } : {}),
  }));
  while (visible.length > 0 && JSON.stringify(visible).length > 900_000) visible.pop();
  return {
    summary:
      visible.length < rows.length
        ? `${rows.length} activity items · showing ${visible.length}`
        : `${rows.length} activity ${rows.length === 1 ? "item" : "items"}`,
    rows: visible,
  };
}

/** A stopped manager does not mean the PR monitor is disconnected. */
export function activityRowVisualState(
  row: DesktopActivityRow,
  thread?: Pick<
    EnvironmentThreadShell,
    "hasPendingApprovals" | "hasPendingUserInput" | "session" | "settledOverride"
  >,
) {
  const disconnected = /^(offline|monitor unavailable) · last observed$/i.test(row.status);
  const status = disconnected
    ? "offline"
    : row.watchId
      ? [
          row.status.replace(/\boffline\b/gi, "idle"),
          thread?.hasPendingApprovals
            ? "approval"
            : thread?.hasPendingUserInput
              ? "needs input"
              : "",
          thread?.session?.status === "error" ? "error" : "",
        ].join(" · ")
      : row.status;
  return activityVisualState({
    status,
    checks: row.checks,
    settled: !row.watchId && thread?.settledOverride === "settled",
  });
}

/** Enrich only matching environment identities; compact copy contains agent text, never tool payloads. */
export function contextualActivityRows(
  rows: readonly DesktopActivityRow[],
  threads: readonly EnvironmentThreadShell[],
  projects: readonly (RepositoryScopeProject &
    Partial<Pick<OrchestrationProjectShell, "title" | "projectIcon">>)[],
  details: readonly (EnvironmentThread | null)[],
): DesktopActivityRow[] {
  return rows.map((row) => {
    const project = projects.find(
      (item) => item.environmentId === row.environmentId && item.id === row.projectId,
    );
    const thread = threads.find(
      (item) => item.environmentId === row.environmentId && item.id === row.threadId,
    );
    const detail = details.find(
      (item) => item?.environmentId === row.environmentId && item.id === row.threadId,
    );
    const label =
      project?.title ??
      project?.stave?.spaceId ??
      project?.workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1);
    return {
      ...row,
      visualState: activityRowVisualState(row, thread),
      ...(thread?.latestUserMessageAt ? { userPromptAt: thread.latestUserMessageAt } : {}),
      userSettled: thread?.settledOverride === "settled",
      userStopped:
        thread?.latestTurn?.state === "interrupted" ||
        thread?.session?.status === "interrupted" ||
        thread?.session?.status === "stopped",
      ...(label ? { projectLabel: label.slice(0, 300) } : {}),
      ...(project && label
        ? { projectIcon: activityProjectIcon(label, project.workspaceRoot, project.projectIcon) }
        : {}),
      projectKind: project?.stave ? (project.stave.isSaga ? "saga" : "space") : "project",
      excerpt: (row.status === "Action failed"
        ? (row.mergeStatus ?? "Action failed")
        : thread
          ? threadActivityExcerpt(thread, detail?.messages)
          : row.subtitle
      ).slice(0, 180),
    };
  });
}

import {
  resolveProjectStatusIndicator,
  resolveThreadStatusPill,
  type ThreadStatusPill,
} from "../Sidebar.logic";
import type { SidebarThreadSummary } from "../../types";
import type {
  EnvironmentId,
  ProjectId,
  SagaWorkbenchWorkflow,
  SagaWorkbenchSnapshot,
} from "@t3tools/contracts";
export const SAGA_VIEWS = ["board", "list", "dependencies", "activity", "settings"] as const;
export type SagaWorkbenchView = (typeof SAGA_VIEWS)[number];
export function parseSagaWorkbenchSearch(search: Record<string, unknown>): {
  view: SagaWorkbenchView;
  member?: string;
} {
  return {
    view: SAGA_VIEWS.find((view) => view === search.view) ?? "board",
    ...(typeof search.member === "string" && search.member.length > 0
      ? { member: search.member }
      : {}),
  };
}
export function sagaSummarySourceTarget(url: string, environmentId: EnvironmentId) {
  if (url.startsWith("lecturn:thread:") && url.length > "lecturn:thread:".length)
    return {
      kind: "thread" as const,
      environmentId,
      threadId: url.slice("lecturn:thread:".length),
    };
  if (/^https?:\/\//u.test(url)) return { kind: "external" as const, url };
  return { kind: "reference" as const, label: url };
}
export function sagaWorkflowLabel(workflow: SagaWorkbenchWorkflow | null) {
  if (!workflow) return "Unavailable";
  if (workflow.evidenceState === "stale")
    return workflow.completedAt ? "Completion needs verification" : "Evidence changed";
  if (workflow.completedAt) return "Completed · last verified";
  return workflow.stage.charAt(0).toUpperCase() + workflow.stage.slice(1);
}

/** Reuse sidebar session/attention inference; workflow completion is a separate fact. */
export function sagaThreadActivity(thread: SagaActivityThread): SagaAgentActivity {
  return thread.archivedAt
    ? { kind: "idle", label: "Archived conversation" }
    : sagaAgentActivity(resolveThreadStatusPill({ thread }));
}

export function sagaProjectActivities(
  threads: readonly SagaActivityThread[],
  environmentId: EnvironmentId,
): ReadonlyMap<ProjectId, SagaAgentActivity> {
  const byProject = new Map<ProjectId, (ThreadStatusPill | null)[]>();
  for (const thread of threads) {
    if (thread.environmentId !== environmentId || thread.archivedAt) continue;
    const statuses = byProject.get(thread.projectId) ?? [];
    statuses.push(resolveThreadStatusPill({ thread }));
    byProject.set(thread.projectId, statuses);
  }
  return new Map(
    [...byProject].map(([projectId, statuses]) => [
      projectId,
      sagaAgentActivity(resolveProjectStatusIndicator(statuses)),
    ]),
  );
}

type SagaActivityThread = Parameters<typeof resolveThreadStatusPill>[0]["thread"] &
  Pick<SidebarThreadSummary, "environmentId" | "projectId" | "archivedAt">;
export interface SagaAgentActivity {
  readonly kind: "running" | "waiting" | "idle";
  readonly label: string;
}
function sagaAgentActivity(status: ThreadStatusPill | null): SagaAgentActivity {
  switch (status?.label) {
    case "Pending Approval":
      return { kind: "waiting", label: "Waiting for human · approval" };
    case "Awaiting Input":
      return { kind: "waiting", label: "Waiting for human · input" };
    case "Plan Ready":
      return { kind: "waiting", label: "Waiting for human · plan ready" };
    case "Working":
      return { kind: "running", label: "Running" };
    case "Connecting":
      return { kind: "running", label: "Connecting" };
    case "Monitoring":
      return { kind: "running", label: "Monitoring" };
    default:
      return { kind: "idle", label: "Idle" };
  }
}

export interface SagaStageDragGesture {
  readonly memberId: string;
  readonly identity: SagaWorkbenchWorkflow["identity"];
  readonly revision: number;
}

/** Snapshot primitives at pickup; live draggable data can change during a gesture. */
export function captureSagaStageDrag(
  member: SagaWorkbenchSnapshot["members"][number] | undefined,
): SagaStageDragGesture | null {
  return member?.workflow
    ? {
        memberId: member.id,
        identity: { ...member.workflow.identity },
        revision: member.workflow.revision,
      }
    : null;
}

/** Resolve the dragged member only if its incarnation and revision still match pickup. */
export function sagaStageDropInput(
  members: SagaWorkbenchSnapshot["members"],
  gesture: SagaStageDragGesture | null,
  targetStage: string,
  writable: boolean,
  requestId: string,
) {
  const member = members.find((item) => item.id === gesture?.memberId);
  const workflow = member?.workflow;
  const stage = ["spec", "plan", "build", "review", "accept"].find(
    (value) => value === targetStage,
  );
  if (
    !writable ||
    !gesture ||
    !member ||
    member.state !== "live" ||
    !workflow ||
    workflow.revision !== gesture.revision ||
    workflow.identity.projectId !== gesture.identity.projectId ||
    workflow.identity.workspaceRoot !== gesture.identity.workspaceRoot ||
    workflow.identity.spaceId !== gesture.identity.spaceId ||
    workflow.identity.createdAt !== gesture.identity.createdAt ||
    !stage ||
    workflow.automaticStage !== false ||
    workflow.stagePinned ||
    workflow.completedAt ||
    stage === workflow.stage
  )
    return null;
  return {
    identity: workflow.identity,
    expectedRevision: workflow.revision,
    requestId,
    stage: stage as SagaWorkbenchWorkflow["stage"],
  };
}

/** Attention on one conversation must not hide another conversation doing work. */
export function sagaRunningProjects(
  threads: readonly SagaActivityThread[],
  environmentId: EnvironmentId,
) {
  return new Set(
    threads
      .filter(
        (thread) =>
          thread.environmentId === environmentId &&
          !thread.archivedAt &&
          sagaThreadActivity(thread).kind === "running",
      )
      .map((thread) => thread.projectId),
  );
}

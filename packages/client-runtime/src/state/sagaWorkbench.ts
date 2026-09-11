import type {
  SagaWorkbenchSnapshot,
  SagaWorkbenchStage,
  SagaWorkbenchWorkflow,
} from "@t3tools/contracts";
import { scopeProjectRef } from "../environment/scoped.ts";
import type { EnvironmentProject } from "./models.ts";
import {
  buildSagaProjectTree,
  type ProjectGroup,
  type SagaProjectIndexEntry,
} from "./projectGrouping.ts";

export const SAGA_WORKBENCH_STAGES = ["spec", "plan", "build", "review", "accept"] as const;
export const sagaWorkbenchStageLabel = (stage: SagaWorkbenchStage): string =>
  stage.charAt(0).toUpperCase() + stage.slice(1);

/** Navigation may split physical spaces; this never changes logical settings groups. */
export function buildPhysicalSagaProjectGroups<T extends EnvironmentProject>(
  groups: readonly ProjectGroup<T>[],
  _sagaIndex: readonly SagaProjectIndexEntry[] = [],
): readonly ProjectGroup<T>[] {
  return groups.flatMap((group) => {
    if (group.members.length < 2 || !group.members.some(({ project }) => project.stave != null))
      return [group];
    // Older grouped payloads may retain alias project IDs without their physical roots.
    // Keep that group intact rather than lose its threads or invent a parent for an alias.
    if (
      group.memberProjectRefs.some(
        (ref) =>
          !group.members.some(
            ({ project }) =>
              project.environmentId === ref.environmentId && project.id === ref.projectId,
          ),
      )
    )
      return [group];
    const ordinary = group.members.filter(({ project }) => project.stave == null);
    const ordinaryRefs = group.memberProjectRefs.filter((ref) =>
      ordinary.some(
        ({ project }) =>
          project.environmentId === ref.environmentId && project.id === ref.projectId,
      ),
    );
    const split = group.members
      .filter(({ project }) => project.stave != null)
      .map((member) => ({
        key: `${group.key}::${member.physicalProjectKey}`,
        label: member.project.title,
        representative: member.project,
        members: [member],
        memberProjectRefs: [scopeProjectRef(member.project.environmentId, member.project.id)],
      }));
    if (ordinary.length > 0)
      split.push({
        key: group.key,
        label: group.label,
        representative: ordinary[0]!.project,
        members: [...ordinary],
        memberProjectRefs: [...ordinaryRefs],
      });
    return split;
  });
}

export function buildPhysicalSagaProjectTree<T extends EnvironmentProject>(
  groups: readonly ProjectGroup<T>[],
  index: readonly SagaProjectIndexEntry[],
) {
  return buildSagaProjectTree(buildPhysicalSagaProjectGroups(groups, index), index);
}

export interface SagaDependencyNode {
  readonly id: string;
  readonly after: readonly string[];
}
export function buildSagaDependencyWaves<T extends SagaDependencyNode>(members: readonly T[]) {
  const byId = new Map(members.map((member) => [member.id, member]));
  const depths = new Map<string, number>();
  const missing = new Map<string, readonly string[]>();
  for (const member of members) {
    const absent = member.after.filter((id) => !byId.has(id));
    if (absent.length) missing.set(member.id, absent);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const member of members) {
      if (depths.has(member.id) || missing.has(member.id)) continue;
      if (!member.after.every((id) => depths.has(id))) continue;
      depths.set(
        member.id,
        member.after.length ? 1 + Math.max(...member.after.map((id) => depths.get(id)!)) : 0,
      );
      changed = true;
    }
  }
  const waves: T[][] = [];
  for (const member of members) {
    const depth = depths.get(member.id);
    if (depth === undefined) continue;
    (waves[depth] ??= []).push(member);
  }
  return { waves, unresolved: members.filter((member) => !depths.has(member.id)), missing };
}

export function countSagaWorkbenchStages(snapshot: SagaWorkbenchSnapshot) {
  const counts = { spec: 0, plan: 0, build: 0, review: 0, accept: 0, completed: 0, unavailable: 0 };
  for (const member of snapshot.members) {
    if (member.workflow == null) counts.unavailable++;
    else if (member.workflow.completedAt && member.workflow.evidenceState !== "stale")
      counts.completed++;
    else counts[member.workflow.stage]++;
  }
  return counts;
}

export function sagaWorkbenchSummaryFallback(workflow: SagaWorkbenchWorkflow | null): string {
  if (!workflow) return "Workspace is unavailable. Its current progress cannot be verified.";
  if (workflow.evidenceState === "stale")
    return "Local evidence has changed since acceptance. Review the current revisions before accepting again.";
  if (workflow.completedAt)
    return "Completion was verified. Refresh evidence to check for subsequent changes.";
  if (workflow.stage === "accept")
    return workflow.accepted
      ? "Acceptance recorded. Required CI and merge evidence must still be verified before completion."
      : "Awaiting acceptance, required CI, and merge verification.";
  return `${sagaWorkbenchStageLabel(workflow.stage)} stage. No generated summary yet.`;
}

/** Retain newer durable rows if a delayed response arrives after a local mutation. */
export function reconcileSagaWorkbenchSnapshot(
  previous: SagaWorkbenchSnapshot | null,
  incoming: SagaWorkbenchSnapshot,
): SagaWorkbenchSnapshot {
  if (
    !previous ||
    previous.identity.projectId !== incoming.identity.projectId ||
    previous.identity.createdAt !== incoming.identity.createdAt ||
    previous.identity.workspaceRoot !== incoming.identity.workspaceRoot
  )
    return incoming;
  const newest = (old: SagaWorkbenchWorkflow | null, next: SagaWorkbenchWorkflow | null) =>
    old &&
    next &&
    old.identity.createdAt === next.identity.createdAt &&
    old.identity.workspaceRoot === next.identity.workspaceRoot &&
    old.revision > next.revision
      ? old
      : next;
  return {
    ...incoming,
    workflow: newest(previous.workflow, incoming.workflow)!,
    members: incoming.members.map((member) => ({
      ...member,
      workflow: newest(
        previous.members.find((old) => old.id === member.id)?.workflow ?? null,
        member.workflow,
      ),
    })),
  };
}

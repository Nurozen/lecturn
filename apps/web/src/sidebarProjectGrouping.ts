import type { EnvironmentId, ScopedProjectRef } from "@lecturn/contracts";
import {
  buildProjectGroups,
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  type ProjectGroupingSettings,
} from "./logicalProject";
import { resolveScratchProjectScopeKey } from "@lecturn/client-runtime/state/project-grouping";
import type { Project } from "./types";

export type EnvironmentPresence = "local-only" | "remote-only" | "mixed";

export interface SidebarProjectGroupMember extends Project {
  physicalProjectKey: string;
  environmentLabel: string | null;
}

export interface SidebarProjectSnapshot extends Project {
  projectKey: string;
  settingsProjectKey?: string;
  displayName: string;
  groupedProjectCount: number;
  environmentPresence: EnvironmentPresence;
  allRemoteMembersAreDesktopLocal: boolean;
  allRemoteMembersAreWsl: boolean;
  memberProjects: readonly SidebarProjectGroupMember[];
  memberProjectRefs: readonly ScopedProjectRef[];
  remoteEnvironmentLabels: readonly string[];
}

export function projectGroupsSpanEnvironments(
  groups: ReadonlyArray<Pick<SidebarProjectSnapshot, "memberProjects">>,
): boolean {
  const environmentIds = new Set<EnvironmentId>();
  for (const group of groups) {
    for (const member of group.memberProjects) {
      environmentIds.add(member.environmentId);
      if (environmentIds.size > 1) return true;
    }
  }
  return false;
}

export interface SidebarProjectPickerEntry {
  group: SidebarProjectSnapshot;
  targetProject: SidebarProjectGroupMember;
  isPreferred: boolean;
}

export function getSidebarProjectSettingsKey(
  group: SidebarProjectSnapshot,
  settings: ProjectGroupingSettings,
  projects: ReadonlyArray<Project>,
  projectRef?: ScopedProjectRef,
): string {
  if (!group.isScratch) return group.projectKey;
  const project =
    group.memberProjects.find(
      (member) =>
        member.environmentId === projectRef?.environmentId && member.id === projectRef.projectId,
    ) ??
    group.memberProjects.find((member) => member.environmentId === projectRef?.environmentId) ??
    group;
  return (
    buildPhysicalToLogicalProjectKeyMap({ projects, settings, primaryEnvironmentId: null }).get(
      derivePhysicalProjectKey(project),
    ) ?? group.projectKey
  );
}

export function resolveSidebarProjectScopeKey(input: {
  readonly groups: ReadonlyArray<SidebarProjectSnapshot>;
  readonly key: string | null;
  readonly settings?: ProjectGroupingSettings;
  readonly canClearMissingScope?: boolean;
}): string | null {
  if (input.key === null) return null;
  const group =
    input.groups.find((candidate) => candidate.projectKey === input.key) ??
    input.groups.find(
      (candidate) =>
        candidate.isScratch &&
        resolveScratchProjectScopeKey(input.key, candidate.memberProjects, input.settings) ===
          candidate.projectKey,
    );
  return group?.projectKey ?? (input.canClearMissingScope ? null : input.key);
}

export function buildPhysicalToLogicalProjectKeyMap(input: {
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingSettings;
  primaryEnvironmentId: EnvironmentId | null;
}): Map<string, string> {
  const mapping = new Map<string, string>();
  const groups = buildProjectGroups({
    projects: input.projects,
    settings: input.settings,
    preferredEnvironmentId: input.primaryEnvironmentId,
  });
  for (const group of groups) {
    for (const member of group.members) {
      mapping.set(member.physicalProjectKey, group.key);
    }
  }
  return mapping;
}

/**
 * Resolves the group key the sidebar and project settings use for a project.
 * A duplicate row can borrow its repository identity from a sibling, so the
 * key derived from the project alone is only the fallback.
 */
export function resolveLogicalProjectKey(input: {
  project: Project;
  logicalKeyByPhysicalKey: ReadonlyMap<string, string>;
  settings: ProjectGroupingSettings;
}): string {
  return (
    input.logicalKeyByPhysicalKey.get(derivePhysicalProjectKey(input.project)) ??
    deriveLogicalProjectKeyFromSettings(input.project, input.settings)
  );
}

export function buildSidebarProjectSnapshots(input: {
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingSettings;
  groupScratchProjects?: boolean;
  primaryEnvironmentId: EnvironmentId | null;
  resolveEnvironmentLabel: (environmentId: EnvironmentId) => string | null;
  isDesktopLocalEnvironment?: (environmentId: EnvironmentId) => boolean;
  isWslEnvironment?: (environmentId: EnvironmentId) => boolean;
}): SidebarProjectSnapshot[] {
  return buildProjectGroups({
    projects: input.projects,
    groupScratchProjects: input.groupScratchProjects ?? false,
    settings: input.settings,
    preferredEnvironmentId: input.primaryEnvironmentId,
  }).map((group): SidebarProjectSnapshot => {
    const members = group.members.map(
      ({ physicalProjectKey, project }): SidebarProjectGroupMember => ({
        ...project,
        physicalProjectKey,
        environmentLabel: input.resolveEnvironmentLabel(project.environmentId),
      }),
    );
    const representative =
      members.find(
        (member) =>
          member.environmentId === group.representative.environmentId &&
          member.id === group.representative.id,
      ) ?? members[0]!;

    return {
      ...representative,
      projectKey: group.key,
      displayName: group.label,
      groupedProjectCount: members.length,
      ...deriveSidebarEnvironmentMetadata({
        members,
        primaryEnvironmentId: input.primaryEnvironmentId,
        ...(input.isDesktopLocalEnvironment
          ? { isDesktopLocalEnvironment: input.isDesktopLocalEnvironment }
          : {}),
        ...(input.isWslEnvironment ? { isWslEnvironment: input.isWslEnvironment } : {}),
      }),
      memberProjects: members,
      memberProjectRefs: group.memberProjectRefs,
    };
  });
}

/** Presence belongs to the physical members currently represented by a navigation row. */
export function deriveSidebarEnvironmentMetadata(input: {
  members: readonly Pick<SidebarProjectGroupMember, "environmentId" | "environmentLabel">[];
  primaryEnvironmentId: EnvironmentId | null;
  isDesktopLocalEnvironment?: (environmentId: EnvironmentId) => boolean;
  isWslEnvironment?: (environmentId: EnvironmentId) => boolean;
}): Pick<
  SidebarProjectSnapshot,
  | "environmentPresence"
  | "allRemoteMembersAreDesktopLocal"
  | "allRemoteMembersAreWsl"
  | "remoteEnvironmentLabels"
> {
  const { members } = input;
  const hasLocal =
    input.primaryEnvironmentId !== null &&
    members.some((member) => member.environmentId === input.primaryEnvironmentId);
  const hasRemote =
    input.primaryEnvironmentId !== null
      ? members.some((member) => member.environmentId !== input.primaryEnvironmentId)
      : false;
  const remoteMembers = members.filter(
    (member) =>
      input.primaryEnvironmentId !== null && member.environmentId !== input.primaryEnvironmentId,
  );
  const remoteEnvironmentLabels = remoteMembers
    .flatMap((member) => (member.environmentLabel ? [member.environmentLabel] : []))
    .filter((label, index, labels) => labels.indexOf(label) === index);
  const isDesktopLocal = input.isDesktopLocalEnvironment ?? (() => false);
  const allRemoteMembersAreDesktopLocal =
    remoteMembers.length > 0 &&
    remoteMembers.every((member) => isDesktopLocal(member.environmentId));

  const allRemoteMembersAreWsl =
    remoteMembers.length > 0 &&
    remoteMembers.every((member) => input.isWslEnvironment?.(member.environmentId) === true);

  return {
    environmentPresence: hasLocal && hasRemote ? "mixed" : hasRemote ? "remote-only" : "local-only",
    allRemoteMembersAreDesktopLocal,
    allRemoteMembersAreWsl,
    remoteEnvironmentLabels,
  };
}

export function buildSidebarProjectPickerEntries(input: {
  groups: ReadonlyArray<SidebarProjectSnapshot>;
  preferredProjectRef: ScopedProjectRef | null;
}) {
  const preferredProjectRef = input.preferredProjectRef;
  const entries = input.groups.flatMap((group): SidebarProjectPickerEntry[] => {
    const isPreferred = preferredProjectRef
      ? group.memberProjectRefs.some(
          (projectRef) =>
            projectRef.environmentId === preferredProjectRef.environmentId &&
            projectRef.projectId === preferredProjectRef.projectId,
        )
      : false;
    const preferredProject = preferredProjectRef
      ? (group.memberProjects.find(
          (project) =>
            project.environmentId === preferredProjectRef.environmentId &&
            project.id === preferredProjectRef.projectId,
        ) ??
        group.memberProjects.find(
          (project) => project.environmentId === preferredProjectRef.environmentId,
        ))
      : null;
    const targetProject =
      preferredProject ??
      group.memberProjects.find(
        (project) => project.environmentId === group.environmentId && project.id === group.id,
      ) ??
      group.memberProjects[0];
    if (!targetProject) return [];

    return [{ group, targetProject, isPreferred }];
  });
  const preferredIndex = entries.findIndex((entry) => entry.isPreferred);
  if (preferredIndex <= 0) return entries;

  return [
    entries[preferredIndex]!,
    ...entries.slice(0, preferredIndex),
    ...entries.slice(preferredIndex + 1),
  ];
}

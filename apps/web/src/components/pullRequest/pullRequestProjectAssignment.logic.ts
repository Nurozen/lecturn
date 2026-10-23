import {
  pullRequestHostOf,
  type EnvironmentId,
  type EnvironmentMachineKind,
  type ProjectId,
  type OrchestrationProjectShell,
  type SourceControlProviderKind,
} from "@lecturn/contracts";
import {
  resolveProjectGitTargets,
  resolveRepositoryPullRequestSelector,
} from "@lecturn/client-runtime/state/projectGit";

export interface AssignableProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly repositoryIdentity?:
    | {
        readonly canonicalKey?: string | undefined;
        readonly displayName?: string | null;
        readonly owner?: string | null;
        readonly name?: string;
        readonly provider?: string;
      }
    | null
    | undefined;
  readonly stave?: OrchestrationProjectShell["stave"];
}

function repositoryKey(project: AssignableProject): string | undefined {
  // Listing accepts project IDs, so a mixed space cannot be dropped on the strength of
  // only its primary repository. Deduplicate only complete, known repository sets.
  if (project.stave) {
    const identities = project.stave.repos
      .filter((repo) => repo.mode === "edit")
      .map((repo) => repo.repositoryIdentity?.canonicalKey?.toLowerCase());
    if (identities.length === 0 || identities.some((key) => !key)) return undefined;
    return JSON.stringify([...new Set(identities)].sort());
  }
  const key = project.repositoryIdentity?.canonicalKey?.toLowerCase();
  return key ? JSON.stringify([key]) : undefined;
}

export function assignProjectsToEnvironments(
  projects: ReadonlyArray<AssignableProject>,
  environmentIds: ReadonlyArray<EnvironmentId>,
  preferredEnvironmentId?: EnvironmentId | null,
): Map<EnvironmentId, ProjectId[]> {
  const rank = new Map(environmentIds.map((id, index) => [id, index] as const));
  const owner = new Map<string, EnvironmentId>();
  for (const project of projects) {
    const key = repositoryKey(project);
    if (!key) continue;
    const environmentRank = rank.get(project.environmentId);
    if (environmentRank === undefined) continue;
    const current = owner.get(key);
    if (current === undefined) {
      owner.set(key, project.environmentId);
      continue;
    }
    if (current === preferredEnvironmentId) continue;
    if (
      project.environmentId === preferredEnvironmentId ||
      environmentRank < (rank.get(current) ?? Number.MAX_SAFE_INTEGER)
    ) {
      owner.set(key, project.environmentId);
    }
  }
  const assignment = new Map<EnvironmentId, ProjectId[]>();
  for (const project of projects) {
    if (!rank.has(project.environmentId)) continue;
    const key = repositoryKey(project);
    if (key && owner.get(key) !== project.environmentId) continue;
    const listed = assignment.get(project.environmentId);
    if (listed === undefined) assignment.set(project.environmentId, [project.id]);
    else listed.push(project.id);
  }
  return assignment;
}

/** Match the selected repository, including its host, against every editable checkout. */
export function projectPullRequestRepository(
  project: AssignableProject & { readonly workspaceRoot: string },
  reference: { readonly repository: string; readonly host?: string | undefined },
) {
  const candidates = project.stave
    ? resolveProjectGitTargets({
        project: { workspaceRoot: project.workspaceRoot, stave: project.stave },
      }).map((target) => ({ identity: target.repositoryIdentity, workspaceRoot: target.cwd }))
    : [{ identity: project.repositoryIdentity, workspaceRoot: project.workspaceRoot }];
  const matches = candidates.filter(({ identity }) => {
    if (!identity) return false;
    if (
      resolveRepositoryPullRequestSelector(identity)?.toLowerCase() !==
      reference.repository.toLowerCase()
    )
      return false;
    return (
      reference.host === undefined ||
      pullRequestHostOf(identity, identity.provider as SourceControlProviderKind) ===
        reference.host.toLowerCase()
    );
  });
  return matches.length === 1 ? matches[0] : undefined;
}

export interface PickableEnvironment {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly label: string;
  readonly machine?: EnvironmentMachineKind;
}

export function resolvePickableEnvironments(
  current: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly repository?: string;
    readonly host?: string | undefined;
  },
  projects: ReadonlyArray<AssignableProject & { readonly workspaceRoot: string }>,
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly machine?: EnvironmentMachineKind;
  }>,
): ReadonlyArray<PickableEnvironment> {
  const own = projects.find(
    (project) =>
      project.environmentId === current.environmentId && project.id === current.projectId,
  );
  const selected =
    own && current.repository
      ? projectPullRequestRepository(own, {
          repository: current.repository,
          ...(current.host ? { host: current.host } : {}),
        })
      : undefined;
  const key =
    selected?.identity?.canonicalKey?.toLowerCase() ??
    (current.repository ? undefined : own === undefined ? undefined : repositoryKey(own));
  const ownEnvironment = environments.find(
    (environment) => environment.environmentId === current.environmentId,
  );
  if (own === undefined || !key || ownEnvironment === undefined) return [];
  const others = environments.flatMap((environment) => {
    if (environment.environmentId === current.environmentId) return [];
    const copy = projects.find(
      (project) =>
        project.environmentId === environment.environmentId &&
        (current.repository
          ? projectPullRequestRepository(project, {
              repository: current.repository,
              ...(current.host ? { host: current.host } : {}),
            })?.identity?.canonicalKey?.toLowerCase() === key
          : repositoryKey(project) === key),
    );
    return copy === undefined
      ? []
      : [
          {
            environmentId: environment.environmentId,
            projectId: copy.id,
            workspaceRoot: current.repository
              ? projectPullRequestRepository(copy, {
                  repository: current.repository,
                  ...(current.host ? { host: current.host } : {}),
                })!.workspaceRoot
              : copy.workspaceRoot,
            label: environment.label,
            ...(environment.machine === undefined ? {} : { machine: environment.machine }),
          },
        ];
  });
  if (others.length === 0) return [];
  return [
    {
      environmentId: current.environmentId,
      projectId: own.id,
      workspaceRoot: selected?.workspaceRoot ?? own.workspaceRoot,
      label: ownEnvironment.label,
      ...(ownEnvironment.machine === undefined ? {} : { machine: ownEnvironment.machine }),
    },
    ...others,
  ];
}

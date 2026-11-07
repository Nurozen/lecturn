import type {
  EnvironmentId,
  OrchestrationProjectShell,
  ProjectId,
  PullRequestRef,
  RepositoryIdentity,
} from "@lecturn/contracts";
import type { ChangeRequestLink } from "@lecturn/source-control-core/shared/definition";

import { resolveProjectGitTargets } from "./state/projectGit.ts";
import { sourceControlClients } from "./sourceControlClients.ts";

interface ChangeRequestProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
  readonly workspaceRoot?: string;
  readonly stave?: OrchestrationProjectShell["stave"];
}

export interface ChangeRequestTarget<Project> {
  readonly project: Project;
  readonly repository: string;
  readonly host: string;
}

/** The host the panel and the page read the change request on; a Forgejo port stays on it. */
export function changeRequestLinkHost(link: ChangeRequestLink): string {
  return link.authority ?? link.host.toLowerCase();
}

/** Every editable checkout a project holds: a Stave workspace has one per repository. */
function changeRequestProjectRepositories(
  project: ChangeRequestProject,
): ReadonlyArray<RepositoryIdentity | null | undefined> {
  const { stave, workspaceRoot } = project;
  if (!stave || workspaceRoot === undefined) return [project.repositoryIdentity];
  return resolveProjectGitTargets({ project: { workspaceRoot, stave } }).map(
    (target) => target.repositoryIdentity,
  );
}

/** The project whose own checkout holds the change request, with that checkout's selector. */
export function findChangeRequestTarget<Project extends ChangeRequestProject>(
  projects: ReadonlyArray<Project>,
  link: ChangeRequestLink,
): ChangeRequestTarget<Project> | undefined {
  for (const project of projects) {
    const matches = changeRequestProjectRepositories(project).filter(
      (identity): identity is RepositoryIdentity =>
        identity?.provider !== undefined &&
        sourceControlClients.get(identity.provider).isChangeRequestInRepository(identity, link),
    );
    // Multiple checkouts of the same remote cannot identify the intended checkout.
    const [identity] = matches;
    if (identity !== undefined && matches.length === 1) {
      return {
        project,
        repository: sourceControlClients.repositorySelector(identity) ?? link.repository,
        host: changeRequestLinkHost(link),
      };
    }
  }
  return undefined;
}

/** The project whose own repository holds the change request, not just one on its host. */
export function findProjectForChangeRequest<Project extends ChangeRequestProject>(
  projects: ReadonlyArray<Project>,
  link: ChangeRequestLink,
): Project | undefined {
  return findChangeRequestTarget(projects, link)?.project;
}

export function resolvePullRequestPreviewTarget({
  environmentId,
  projects,
  pullRequestsEnabled,
  url,
}: {
  environmentId: EnvironmentId | null;
  projects: ReadonlyArray<ChangeRequestProject>;
  pullRequestsEnabled: boolean;
  url: string;
}): { environmentId: EnvironmentId; input: PullRequestRef } | null {
  if (!pullRequestsEnabled || environmentId === null) return null;
  const parsed = sourceControlClients.parseChangeRequestUrl(url)?.link;
  if (parsed === undefined) return null;
  // The matched checkout carries the repository selector, so a Stave workspace with several
  // repositories previews the one the link points at.
  const target = findChangeRequestTarget(
    projects.filter((candidate) => candidate.environmentId === environmentId),
    parsed,
  );
  if (target === undefined) return null;
  return {
    environmentId,
    input: {
      projectId: target.project.id,
      host: target.host,
      repository: target.repository,
      number: parsed.number,
    },
  };
}

/** The project host's browser URL for one of its change requests, before its detail loads. */
export function projectChangeRequestUrl(
  identity: RepositoryIdentity | null | undefined,
  repository: string,
  number: number,
): string | null {
  if (identity?.provider === undefined) return null;
  const [host, ...path] = identity.canonicalKey.split("/");
  if (!host) return null;
  // The RPC selector can be shorter than the browser path (Azure's `web` for
  // `org/project/_git/web`), so the project's own repository uses its full key.
  const ownRepository = sourceControlClients.repositorySelector(identity) === repository;
  return sourceControlClients.get(identity.provider).changeRequestUrl({
    host,
    repository: ownRepository ? path.join("/") : repository,
    number,
    remoteUrl: identity.locator.remoteUrl.trim(),
    ...(ownRepository && identity.webUrl !== undefined ? { webUrl: identity.webUrl } : {}),
  });
}

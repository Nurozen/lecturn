import type { EnvironmentId, PullRequestRef, ScopedThreadRef } from "@lecturn/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { type MouseEvent } from "react";

import { sourceControlClients } from "@lecturn/client-runtime/source-control-clients";
import { parseChangeRequestUrl, type ChangeRequestLink } from "@lecturn/shared/changeRequestUrl";
import { sourceControlRepositorySelector } from "@lecturn/shared/sourceControl";

import { useOpenLink } from "../browser/useOpenLink";
import { useClientSettings } from "../hooks/useSettings";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useRightPanelStore } from "../rightPanelStore";
import type { EnvironmentProject } from "@lecturn/client-runtime/state/shell";
import { resolveProjectGitTargets } from "@lecturn/client-runtime/state/projectGit";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { useProjects } from "../state/entities";
import { environmentServerConfigsAtom, serverEnvironment } from "../state/server";
import { usePrimaryEnvironmentId } from "../state/environments";

export {
  parseChangeRequestUrl,
  type ChangeRequestLink,
  gitHubPullRequestBrowserUrl,
  pullRequestCandidateUrlFromReferenceAutolink,
  matchesLinkedPullRequestUrl,
  changeRequestRepositoryUrl,
} from "@lecturn/shared/changeRequestUrl";

/** The host the panel and the page read the change request on; a Forgejo port stays on it. */
function changeRequestLinkHost(link: ChangeRequestLink): string {
  return link.authority ?? link.host.toLowerCase();
}
export interface ChangeRequestTarget {
  readonly project: EnvironmentProject;
  readonly repository: string;
  readonly host: string;
}

export function findChangeRequestTarget(
  projects: ReadonlyArray<EnvironmentProject>,
  link: ChangeRequestLink,
): ChangeRequestTarget | undefined {
  for (const project of projects) {
    // Every editable checkout a project holds: a Stave workspace has one per repository.
    const matches = resolveProjectGitTargets({ project }).flatMap((target) => {
      const identity = target.repositoryIdentity;
      if (
        !identity?.provider ||
        !sourceControlClients.get(identity.provider).isChangeRequestInRepository(identity, link)
      ) {
        return [];
      }
      const repository =
        identity.displayName ??
        (identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null);
      const selector = sourceControlRepositorySelector(identity) ?? repository ?? link.repository;
      return [{ project, repository: selector, host: changeRequestLinkHost(link) }];
    });
    // Multiple checkouts of the same remote cannot identify the intended checkout.
    if (matches.length === 1) return matches[0];
  }
  return undefined;
}

export function findProjectForChangeRequest(
  projects: ReadonlyArray<EnvironmentProject>,
  link: ChangeRequestLink,
): EnvironmentProject | undefined {
  return findChangeRequestTarget(projects, link)?.project;
}

export function resolvePullRequestPreviewTarget({
  environmentId,
  projects,
  pullRequestsEnabled,
  url,
}: {
  environmentId: EnvironmentId | null;
  projects: ReadonlyArray<EnvironmentProject>;
  pullRequestsEnabled: boolean;
  url: string;
}): { environmentId: EnvironmentId; input: PullRequestRef } | null {
  if (!pullRequestsEnabled || environmentId === null) return null;
  const parsed = parseChangeRequestUrl(url);
  if (parsed === null) return null;
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

export function usePullRequestPreviewTarget(environmentId: EnvironmentId | null, url: string) {
  const projects = useProjects();
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  return resolvePullRequestPreviewTarget({
    environmentId,
    projects,
    pullRequestsEnabled: serverConfig?.environment.capabilities.pullRequests === true,
    url,
  });
}

export function findProjectOnChangeRequestHost(
  projects: ReadonlyArray<EnvironmentProject>,
  link: ChangeRequestLink,
): EnvironmentProject | undefined {
  return findChangeRequestHostTarget(projects, link)?.project;
}

/** {@link findProjectOnChangeRequestHost}, with the repository and host the panel is handed. */
function findChangeRequestHostTarget(
  projects: ReadonlyArray<EnvironmentProject>,
  link: ChangeRequestLink,
): ChangeRequestTarget | undefined {
  const own = findChangeRequestTarget(projects, link);
  if (own !== undefined) return own;
  // Each host's definition decides whether a checkout lends its credentials host-wide; Azure's
  // reads stay scoped to the checkout's organization and project.
  const project = projects.find((candidate) =>
    resolveProjectGitTargets({ project: candidate }).some((target) => {
      const identity = target.repositoryIdentity;
      return (
        identity?.provider !== undefined &&
        sourceControlClients.get(identity.provider).canReadChangeRequestOnHost(identity, link)
      );
    }),
  );
  return project === undefined
    ? undefined
    : { project, repository: link.repository, host: changeRequestLinkHost(link) };
}

export function shouldOpenPullRequestExternally(
  event: Pick<MouseEvent<HTMLElement>, "metaKey" | "ctrlKey"> &
    Partial<Pick<MouseEvent<HTMLElement>, "button">>,
): boolean {
  return event.metaKey || event.ctrlKey || event.button === 1;
}

export function useOpenChangeRequestLink(
  threadRef?: ScopedThreadRef,
  panelRef?: ScopedThreadRef,
): (
  event: Pick<
    MouseEvent<HTMLElement>,
    "preventDefault" | "stopPropagation" | "metaKey" | "ctrlKey"
  >,
  targetUrl: string,
  targetThreadRef?: ScopedThreadRef,
  targetEnvironmentId?: EnvironmentId,
) => boolean {
  const navigate = useNavigate();
  const allProjects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const openInApp = useClientSettings((settings) => settings.pullRequestLinksOpenInApp);
  return (event, targetUrl, targetThreadRef, targetEnvironmentId) => {
    if (!openInApp || shouldOpenPullRequestExternally(event)) return false;
    // Read at click time: every provider status push replaces the config map, and
    // subscribing would hand every rendered link a new handler.
    const serverConfigs = appAtomRegistry.get(environmentServerConfigsAtom);
    const resolvedThreadRef = targetThreadRef ?? threadRef;
    const resolvedPanelRef = panelRef ?? resolvedThreadRef;
    const parsed = parseChangeRequestUrl(targetUrl);
    if (parsed === null) return false;
    const reads = (environmentId: string) =>
      serverConfigs.get(environmentId as EnvironmentId)?.environment.capabilities.pullRequests ===
      true;
    // Beside a thread the panel reads on that thread's environment, so a project from another
    // one could not be read there whatever its remote says: two environments can hold the same
    // repository, and handing the panel the wrong one's id opens a surface that never loads.
    const projects = resolvedThreadRef
      ? allProjects.filter((project) => project.environmentId === resolvedThreadRef.environmentId)
      : targetEnvironmentId
        ? allProjects.filter((project) => project.environmentId === targetEnvironmentId)
        : allProjects
            .filter((project) => reads(project.environmentId))
            .toSorted(
              (left, right) =>
                Number(right.environmentId === primaryEnvironmentId) -
                Number(left.environmentId === primaryEnvironmentId),
            );
    const target =
      findChangeRequestTarget(projects, parsed) ??
      (resolvedPanelRef
        ? findChangeRequestHostTarget(
            projects.filter(
              (candidate) =>
                serverConfigs.get(candidate.environmentId)?.environment.capabilities
                  .threadPullRequests === true,
            ),
            parsed,
          )
        : undefined);
    if (target === undefined || !reads(target.project.environmentId)) return false;
    const { project, host } = target;
    // A server that links pull requests to threads resolves the URL's own spelling; an older
    // one asks its provider for the checkout's repository selector.
    const repository =
      serverConfigs.get(project.environmentId)?.environment.capabilities.threadPullRequests === true
        ? parsed.repository
        : target.repository;
    event.preventDefault();
    event.stopPropagation();
    if (resolvedPanelRef) {
      useRightPanelStore.getState().openPullRequest(resolvedPanelRef, {
        // The standalone PR panel has a synthetic ref; each tab keeps its real environment.
        ...(resolvedPanelRef.environmentId === project.environmentId
          ? {}
          : { environmentId: project.environmentId }),
        projectId: project.id,
        repository,
        host,
        url: targetUrl,
        number: parsed.number,
      });
      if (!resolvedThreadRef) {
        void navigate({
          to: "/pull-requests",
          search: (previous) => ({
            ...previous,
            involvement: previous.involvement ?? "all",
            state: previous.state ?? "all",
            repository,
            number: parsed.number,
            selectedHost: host,
            selectedProjectId: project.id,
            selectedEnvironmentId: project.environmentId,
          }),
          replace: true,
        });
      }
      return true;
    }
    void navigate({
      to: "/pull-requests",
      search: {
        involvement: "all",
        state: "all",
        repository,
        number: parsed.number,
        selectedHost: host,
        selectedProjectId: project.id,
        selectedEnvironmentId: project.environmentId,
      },
    });
    return true;
  };
}

export function useOpenPrLink(threadRef?: ScopedThreadRef) {
  const openChangeRequest = useOpenChangeRequestLink(threadRef);
  const openLink = useOpenLink(threadRef);
  return (event: MouseEvent<HTMLElement>, prUrl: string, targetThreadRef?: ScopedThreadRef) => {
    if (event.button > 1) return false;
    event.stopPropagation();
    const openInBrowser = shouldOpenPullRequestExternally(event);
    const isAnchor =
      event.currentTarget instanceof HTMLAnchorElement && event.currentTarget.href.length > 0;
    // A real link already knows how to cmd/ctrl/middle-click. Leave its default
    // action alone so the browser (or Electron's window-open handler) opens
    // the host. Buttons have no href, so they still go through openExternal.
    if (openInBrowser && isAnchor) return false;

    event.preventDefault();
    if (!openInBrowser && openChangeRequest(event, prUrl, targetThreadRef)) return true;

    void openLink(prUrl, { event, threadRef: targetThreadRef }).catch((error: unknown) => {
      console.error(error);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open pull request link",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
    return false;
  };
}

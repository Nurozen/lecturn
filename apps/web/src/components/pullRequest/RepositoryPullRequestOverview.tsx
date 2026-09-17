import { useSagaRepositoryIndex } from "../../state/stave";
import { readLocalApi } from "~/localApi";
import { useState } from "react";
import {
  resolveRepositoryScope,
  type RepositoryScopeTarget,
} from "@lecturn/client-runtime/state/repositoryScope";
import { resolveRepositoryPullRequestSelector } from "@lecturn/client-runtime/state/projectGit";
import {
  pullRequestHostOf,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type SourceControlProviderKind,
} from "@lecturn/contracts";
import { useProjects, useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { vcsEnvironment } from "../../state/vcs";
import { useRightPanelStore } from "../../rightPanelStore";
import { PullRequestWatchButton } from "./PullRequestWatchControls";
import { Button } from "../ui/button";

function RepositoryRow({
  target,
  threadRef,
}: {
  target: RepositoryScopeTarget;
  threadRef: ScopedThreadRef;
}) {
  const status = useEnvironmentQuery(
    vcsEnvironment.status({ environmentId: target.environmentId, input: { cwd: target.cwd } }),
  );
  const identity = target.repositoryIdentity;
  const repository = resolveRepositoryPullRequestSelector(identity);
  const pr = status.data?.pr;
  const projectId = target.projectIds[0];
  const reference =
    pr && projectId && repository && identity
      ? {
          projectId,
          repository,
          host: pullRequestHostOf(identity, identity.provider as SourceControlProviderKind),
          number: pr.number,
        }
      : null;
  return (
    <div className="flex flex-wrap items-center gap-2 py-1 text-xs">
      <span className="min-w-24 font-medium">
        {target.repoName}
        {target.mode === "reference" ? " · reference" : ""}
      </span>
      <span className="text-muted-foreground">
        {status.error ??
          (pr
            ? `${pr.state} #${pr.number} ${pr.title}`
            : status.isPending
              ? "Loading…"
              : "No pull request")}
      </span>
      {reference ? (
        <>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              if (target.mode === "reference" && pr)
                void readLocalApi()?.shell.openExternal(pr.url);
              else useRightPanelStore.getState().openPullRequest(threadRef, reference);
            }}
          >
            {target.mode === "reference" ? "Open PR on provider" : "Open PR"}
          </Button>
          {target.mode === "edit" ? (
            <PullRequestWatchButton
              environmentId={target.environmentId}
              reference={reference}
              threadId={threadRef.threadId}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** Space and saga threads inspect their complete repository scope, including member spaces. */
export function RepositoryPullRequestOverview({
  projectRef,
  threadRef,
}: {
  projectRef: ScopedProjectRef;
  threadRef: ScopedThreadRef;
}) {
  const projects = useProjects();
  const sagaIndex = useSagaRepositoryIndex(projects);
  const thread = useThreadShell(threadRef);
  const [expanded, setExpanded] = useState(false);
  const targets = resolveRepositoryScope({
    projects,
    sagaIndex,
    roots: [projectRef],
    includeReferences: true,
    ...(thread
      ? { thread: { ...projectRef, branch: thread.branch, worktreePath: thread.worktreePath } }
      : {}),
  });
  if (targets.length === 0) return null;
  return (
    <details
      className="max-h-48 overflow-y-auto border-b px-5 py-2"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-xs text-muted-foreground">
        Pull requests across {targets.length} repositories
      </summary>
      {expanded ? (
        <div className="pt-2">
          {targets.map((target) => (
            <RepositoryRow key={target.key} target={target} threadRef={threadRef} />
          ))}
        </div>
      ) : null}
    </details>
  );
}

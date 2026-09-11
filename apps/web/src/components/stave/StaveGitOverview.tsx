import { useState } from "react";
import {
  type ProjectGitTarget,
  resolveRepositoryPullRequestSelector,
} from "@lecturn/client-runtime/state/projectGit";
import {
  pullRequestHostOf,
  type SourceControlProviderKind,
  type OrchestrationProjectShell,
  type ScopedThreadRef,
} from "@lecturn/contracts";
import { GitBranchIcon, GitPullRequestIcon, RefreshCwIcon } from "lucide-react";
import type { DraftId } from "~/composerDraftStore";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "../ui/dialog";
import GitActionsControl from "../GitActionsControl";
import { BranchToolbarBranchSelector } from "../BranchToolbarBranchSelector";
import { useStaveGitSelection } from "./staveGitSelection";

export interface StavePullRequestTarget {
  readonly repository: string;
  readonly host?: string;
}

interface Props {
  project: OrchestrationProjectShell;
  threadRef: ScopedThreadRef;
  draftId?: DraftId;
  onOpenDiff: () => void;
  onOpenPullRequest?: (number: number, target?: StavePullRequestTarget) => void;
}

function RepoRow({
  target,
  selected,
  onSelect,
  onInspect,
  threadRef,
  project,
  draftId,
  onOpenPullRequest,
}: Props & {
  target: ProjectGitTarget;
  selected: boolean;
  onSelect: () => void;
  onInspect: () => void;
}) {
  const status = useEnvironmentQuery(
    vcsEnvironment.status({
      environmentId: threadRef.environmentId,
      input: { cwd: target.cwd },
    }),
  );
  const data = status.data;
  const identity = target.repositoryIdentity;
  const repository = resolveRepositoryPullRequestSelector(identity);
  const repositoryTarget =
    identity && repository
      ? {
          repository,
          host: pullRequestHostOf(identity, identity.provider as SourceControlProviderKind),
        }
      : undefined;
  const editable = target.mode === "edit" && project.stave?.state !== "archived";
  const conflicts = data?.workingTree.files.filter((file) => file.conflicted).length ?? 0;
  const staged = data?.workingTree.files.filter((file) => file.staged).length ?? 0;
  return (
    <section
      className="rounded-lg border border-border/70"
      aria-label={`${target.repoName} repository`}
    >
      <button
        type="button"
        data-lecturn-hover
        aria-expanded={selected}
        onClick={onSelect}
        className="flex w-full flex-col gap-2 rounded-lg px-4 py-3 text-left focus-visible:outline-ring"
      >
        <span className="flex w-full items-center justify-between gap-3">
          <span className="font-medium">{target.repoName}</span>
          <span className="text-xs text-muted-foreground">
            {target.mode === "reference" ? "Reference · read only" : "Editable"}
          </span>
        </span>
        <span className="break-all font-mono text-xs text-muted-foreground">{target.cwd}</span>
        {status.error ? (
          <span className="text-xs text-error">{status.error}</span>
        ) : !data ? (
          <span className="text-xs text-muted-foreground">Loading repository…</span>
        ) : !data.isRepo ? (
          <span className="text-xs text-error">Repository unavailable</span>
        ) : (
          <span className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <GitBranchIcon className="size-3" />
              {data.refName ?? "Detached HEAD"}
            </span>
            <span>
              {data.workingTree.files.length
                ? `${data.workingTree.files.length} changed files`
                : "Clean"}
            </span>
            <span>
              ↑ {data.aheadCount} ahead · ↓ {data.behindCount} behind
            </span>
            {staged > 0 ? <span>{staged} staged</span> : null}
            {conflicts > 0 ? <span className="text-error">{conflicts} conflicts</span> : null}
            {data.pr ? (
              <span>
                PR #{data.pr.number} · {data.pr.state}
              </span>
            ) : null}
          </span>
        )}
      </button>
      {selected ? (
        <div className="space-y-3 border-t border-border/70 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => status.refresh()}
              aria-label={`Refresh ${target.repoName}`}
            >
              <RefreshCwIcon className="size-3.5" /> Refresh
            </Button>
            <Button size="sm" variant="outline" onClick={onInspect}>
              Inspect changes
            </Button>
            {data?.pr && repositoryTarget && onOpenPullRequest ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onOpenPullRequest(data.pr!.number, repositoryTarget)}
              >
                <GitPullRequestIcon className="size-3.5" />
                PR #{data.pr.number}
              </Button>
            ) : null}
            {editable && data?.isRepo ? (
              <>
                <BranchToolbarBranchSelector
                  repoTarget={target}
                  environmentId={threadRef.environmentId}
                  threadId={threadRef.threadId}
                  {...(draftId ? { draftId } : {})}
                  envLocked
                  startFromOrigin={false}
                  onStartFromOriginChange={() => {}}
                />
                <GitActionsControl
                  key={target.key}
                  gitCwd={target.cwd}
                  activeThreadRef={threadRef}
                  syncThreadBranch={false}
                  {...(repositoryTarget ? { repositoryTarget } : {})}
                  {...(draftId ? { draftId } : {})}
                  {...(repositoryTarget && onOpenPullRequest ? { onOpenPullRequest } : {})}
                />
              </>
            ) : null}
          </div>
          {editable && data?.workingTree.files.length ? (
            <p className="text-xs text-muted-foreground">
              Choose files in Commit to stage and commit only those changes in this repository.
            </p>
          ) : null}
          {data?.workingTree.files.length ? (
            <ul className="max-h-48 space-y-1 overflow-auto font-mono text-xs">
              {data.workingTree.files.map((file) => (
                <li key={file.path} className="flex flex-wrap justify-between gap-2">
                  <span className="break-all">{file.path}</span>
                  <span className="text-muted-foreground">
                    {file.conflicted ? "Conflict · " : ""}
                    {file.staged ? "Staged · " : ""}
                    {file.unstaged ? "Unstaged · " : ""}+{file.insertions} −{file.deletions}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {target.mode === "reference" ? (
            <p className="text-xs text-muted-foreground">
              Reference repositories are available for inspection. Git write actions are disabled.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function StaveGitOverview(props: Props) {
  const [open, setOpen] = useState(false);
  const selection = useStaveGitSelection(props.threadRef.environmentId, props.project);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <GitBranchIcon className="size-4" />
        Space Git{" "}
        <span className="text-muted-foreground">
          {selection.targets.filter((target) => target.mode === "edit").length}
        </span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Git in {props.project.title}</DialogTitle>
            <DialogDescription>
              Repositories share this space. Each commit, branch, and pull request belongs to its
              repository.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            {open
              ? selection.targets.map((target) => (
                  <RepoRow
                    key={target.key}
                    {...props}
                    target={target}
                    selected={selection.selected?.key === target.key}
                    onSelect={() => selection.select(target.key)}
                    onInspect={() => {
                      selection.select(target.key);
                      setOpen(false);
                      props.onOpenDiff();
                    }}
                    {...(props.onOpenPullRequest
                      ? {
                          onOpenPullRequest: (
                            number: number,
                            repository?: StavePullRequestTarget,
                          ) => {
                            setOpen(false);
                            props.onOpenPullRequest?.(number, repository);
                          },
                        }
                      : {})}
                  />
                ))
              : null}
            {selection.targets.length === 0 ? (
              <p className="text-sm text-muted-foreground">This space has no repositories.</p>
            ) : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}

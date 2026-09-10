import { BoxesIcon, ChevronDownIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import type { describeStaveWorkspace } from "./staveWorkspaceContext.logic";

export function StaveWorkspaceContext({
  context,
}: {
  context: NonNullable<ReturnType<typeof describeStaveWorkspace>>;
}) {
  const gitTarget = context.primaryRepoName ?? context.primaryRepoPath;
  return (
    <Popover>
      <PopoverTrigger
        render={<Button variant="ghost" size="xs" />}
        className="min-w-0 font-normal text-xs! text-muted-foreground/70 hover:text-foreground/80"
        aria-label={context.label}
        data-composer-context-control
      >
        <BoxesIcon className="size-3 shrink-0" />
        <span className="min-w-0 truncate">{context.label}</span>
        <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" className="w-80 max-w-[calc(100vw-2rem)]">
        <PopoverTitle>Thread workspace</PopoverTitle>
        <p className="mt-2 break-all font-mono text-xs">{context.workspaceRoot}</p>
        <p className="mt-2 text-xs text-muted-foreground">
          Threads start at the space root with access to all of its repositories.
        </p>
        {[
          { label: "Editable repos", repos: context.editableRepos },
          { label: "Reference repos", repos: context.referenceRepos },
        ].map(({ label, repos }) =>
          repos.length > 0 ? (
            <div key={label} className="mt-3">
              <p className="text-xs font-medium">{label}</p>
              <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                {repos.map((repo) => (
                  <li key={repo.path} className="break-all font-mono">
                    {repo.name}
                  </li>
                ))}
              </ul>
            </div>
          ) : null,
        )}
        <p className="mt-3 border-t pt-3 text-xs text-muted-foreground">
          {gitTarget
            ? `Git controls target ${gitTarget}, the primary repo. Threads use the whole space.`
            : "This space has no primary repo for Git controls."}
        </p>
      </PopoverPopup>
    </Popover>
  );
}

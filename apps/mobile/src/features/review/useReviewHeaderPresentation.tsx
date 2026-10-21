import { useEnvironmentQuery } from "../../state/query";
import { useSelectedThreadGitActions } from "../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../state/use-selected-thread-git-state";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useThreadSelection } from "../../state/use-thread-selection";
import { vcsEnvironment } from "../../state/vcs";
import { useThreadGitMenuDefinition } from "../threads/ThreadGitControls";
import type { EnvironmentId, ThreadId } from "@lecturn/contracts";
import type { ReviewSectionItem } from "./reviewModel";
import type { ScreenHeaderMenuItem, ScreenHeaderMenu } from "../../components/ScreenHeader.types";
import type { AppSymbolName } from "../../components/AppSymbol";

interface ReviewHeaderPresentation {
  readonly title: string;
  readonly subtitle: string;
  readonly gitMenu: ScreenHeaderMenu | null;
  readonly menuIcon: AppSymbolName;
  readonly refreshAction?: ScreenHeaderMenuItem;
}

export function useReviewHeaderPresentation(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Pinned Stave repository; scopes git state, actions, and the menu to it. */
  readonly repoKey?: string | undefined;
  readonly title: string;
  readonly subtitle: string;
  readonly androidSubtitle: string;
  readonly selectedThreadCwd: string | null;
  readonly selectedSection: ReviewSectionItem | null;
  readonly onRefresh: () => Promise<void>;
}): ReviewHeaderPresentation {
  const { selectedThread } = useThreadSelection();
  const { selectedThreadGitBranch, selectedThreadGitRepository } = useSelectedThreadWorktree(
    props.repoKey,
  );
  const gitState = useSelectedThreadGitState(props.repoKey);
  const gitActions = useSelectedThreadGitActions(props.repoKey);
  const gitStatusQuery = useEnvironmentQuery(
    selectedThread !== null && props.selectedThreadCwd !== null
      ? vcsEnvironment.status({
          environmentId: selectedThread.environmentId,
          input: { cwd: props.selectedThreadCwd },
        })
      : null,
  );
  // The selection-based git hooks only apply when this review belongs to the
  // selected thread (it always does when reached from the thread's toolbar).
  const gitMenuAvailable =
    selectedThread !== null &&
    String(selectedThread.id) === String(props.threadId) &&
    selectedThreadGitRepository?.mode !== "reference";
  const gitMenu = useThreadGitMenuDefinition({
    environmentId: props.environmentId,
    threadId: props.threadId,
    currentBranch: selectedThreadGitBranch,
    ...(props.repoKey ? { repoKey: props.repoKey } : {}),
    gitStatus: gitStatusQuery.data,
    gitOperationLabel: gitState.gitOperationLabel,
    onPull: gitActions.onPullSelectedThreadBranch,
    onRunAction: gitActions.onRunSelectedThreadGitAction,
  });
  return {
    title: props.title,
    subtitle: props.subtitle,
    menuIcon: "ellipsis",
    gitMenu: gitMenuAvailable ? gitMenu : null,
  };
}

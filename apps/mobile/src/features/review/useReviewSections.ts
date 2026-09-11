import { useCallback, useEffect, useMemo } from "react";

import { isStaveProject } from "@t3tools/client-runtime/state/projectGit";
import type { EnvironmentId, OrchestrationCheckpointSummary, ThreadId } from "@t3tools/contracts";

import { useCheckpointDiff } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import { reviewEnvironment } from "../../state/review";
import { useSelectedThreadDetail } from "../../state/use-thread-detail";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useThreadSelection } from "../../state/use-thread-selection";
import {
  buildReviewSectionItems,
  getDefaultReviewSectionId,
  getReadyReviewCheckpoints,
  getReviewSectionIdForCheckpoint,
} from "./reviewModel";
import {
  setReviewAsyncError,
  setReviewGitSections,
  setReviewSelectedSectionId,
  setReviewTurnDiff,
  setReviewTurnDiffLoading,
  type ReviewCacheForThread,
} from "./reviewState";

export function useReviewSections(input: {
  readonly enabled?: boolean;
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
  readonly reviewCache: ReviewCacheForThread;
  readonly repoKey?: string;
}) {
  const { environmentId, reviewCache, threadId } = input;
  const enabled = input.enabled ?? true;
  const selectedThread = useSelectedThreadDetail();
  const { selectedThreadProject } = useThreadSelection();
  const { selectedThreadGitCwd, selectedThreadGitRepository } = useSelectedThreadWorktree(
    input.repoKey,
  );
  const diffPreview = useEnvironmentQuery(
    enabled && environmentId !== undefined && selectedThreadGitCwd !== null
      ? reviewEnvironment.diffPreview({
          environmentId,
          input: { cwd: selectedThreadGitCwd },
        })
      : null,
  );
  // Checkpoints snapshot the thread cwd, which for a Stave space is the
  // non-git space root, so turn diffs are meaningless there: no turn sections
  // and no checkpoint diff queries.
  const checkpointsAvailable = !isStaveProject(selectedThreadProject);
  const { loadingTurnIds } = reviewCache.asyncState;

  useEffect(() => {
    if (reviewCache.threadKey && diffPreview.data) {
      setReviewGitSections(reviewCache.threadKey, diffPreview.data.sources);
    }
  }, [diffPreview.data, reviewCache.threadKey]);

  const readyCheckpoints = useMemo(
    () =>
      checkpointsAvailable ? getReadyReviewCheckpoints(selectedThread?.checkpoints ?? []) : [],
    [checkpointsAvailable, selectedThread?.checkpoints],
  );
  const checkpointBySectionId = useMemo(
    () =>
      Object.fromEntries(
        readyCheckpoints.map((checkpoint) => [
          getReviewSectionIdForCheckpoint(checkpoint),
          checkpoint,
        ]),
      ) as Record<string, OrchestrationCheckpointSummary>,
    [readyCheckpoints],
  );
  const reviewSections = useMemo(
    () =>
      buildReviewSectionItems({
        checkpoints: readyCheckpoints,
        gitSections: reviewCache.gitSections,
        turnDiffById: reviewCache.turnDiffById,
        loadingTurnIds,
        loadingGitSections: diffPreview.isPending,
        ...(!checkpointsAvailable && selectedThreadGitRepository
          ? { gitCwd: selectedThreadGitRepository.cwd }
          : {}),
      }).map((section) =>
        checkpointsAvailable || !selectedThreadGitRepository
          ? section
          : {
              ...section,
              title: `${selectedThreadGitRepository.repoName} / ${section.title}`,
              subtitle: `${selectedThreadGitRepository.cwd}${section.subtitle ? ` · ${section.subtitle}` : ""}`,
            },
      ),
    [
      diffPreview.isPending,
      checkpointsAvailable,
      selectedThreadGitRepository,
      loadingTurnIds,
      readyCheckpoints,
      reviewCache.gitSections,
      reviewCache.turnDiffById,
    ],
  );
  const selectedSection = useMemo(
    () =>
      reviewSections.find((section) => section.id === reviewCache.selectedSectionId) ??
      reviewSections[0] ??
      null,
    [reviewCache.selectedSectionId, reviewSections],
  );
  const fallbackSectionId = useMemo(
    () => getDefaultReviewSectionId(reviewSections),
    [reviewSections],
  );
  const selectedSectionIdExists = useMemo(
    () =>
      reviewCache.selectedSectionId
        ? reviewSections.some((section) => section.id === reviewCache.selectedSectionId)
        : false,
    [reviewCache.selectedSectionId, reviewSections],
  );

  useEffect(() => {
    if (
      reviewSections.length > 0 &&
      reviewCache.threadKey &&
      (!reviewCache.selectedSectionId || !selectedSectionIdExists)
    ) {
      setReviewSelectedSectionId(reviewCache.threadKey, fallbackSectionId);
    }
  }, [
    fallbackSectionId,
    reviewCache.selectedSectionId,
    reviewCache.threadKey,
    reviewSections.length,
    selectedSectionIdExists,
  ]);

  let activeCheckpoint = readyCheckpoints[0] ?? null;
  if (selectedSection?.kind === "turn") {
    activeCheckpoint = checkpointBySectionId[selectedSection.id] ?? activeCheckpoint;
  }
  const activeSectionId = activeCheckpoint
    ? getReviewSectionIdForCheckpoint(activeCheckpoint)
    : null;
  const activeTurnDiff = useCheckpointDiff({
    environmentId: enabled ? (environmentId ?? null) : null,
    threadId: enabled ? (threadId ?? null) : null,
    fromTurnCount:
      enabled && activeCheckpoint ? Math.max(0, activeCheckpoint.checkpointTurnCount - 1) : null,
    toTurnCount: enabled ? (activeCheckpoint?.checkpointTurnCount ?? null) : null,
    ignoreWhitespace: false,
  });

  useEffect(() => {
    if (!reviewCache.threadKey || !activeSectionId) {
      return;
    }
    setReviewTurnDiffLoading(reviewCache.threadKey, activeSectionId, activeTurnDiff.isPending);
  }, [activeSectionId, activeTurnDiff.isPending, reviewCache.threadKey]);

  useEffect(() => {
    if (!reviewCache.threadKey || !activeSectionId || !activeTurnDiff.data) {
      return;
    }
    setReviewTurnDiff(reviewCache.threadKey, activeSectionId, activeTurnDiff.data.diff);
    setReviewAsyncError(reviewCache.threadKey, null);
  }, [activeSectionId, activeTurnDiff.data, reviewCache.threadKey]);

  useEffect(() => {
    if (reviewCache.threadKey && activeTurnDiff.error) {
      setReviewAsyncError(reviewCache.threadKey, activeTurnDiff.error);
    }
  }, [activeTurnDiff.error, reviewCache.threadKey]);

  const refreshSelectedSection = useCallback(async () => {
    if (!enabled) {
      return;
    }
    if (selectedSection?.kind === "turn") {
      activeTurnDiff.refresh();
      return;
    }
    diffPreview.refresh();
  }, [activeTurnDiff, diffPreview, enabled, selectedSection?.kind]);

  const selectSection = useCallback(
    (sectionId: string) => {
      if (reviewCache.threadKey) {
        setReviewSelectedSectionId(reviewCache.threadKey, sectionId);
      }
    },
    [reviewCache.threadKey],
  );

  return {
    error: diffPreview.error ?? activeTurnDiff.error ?? reviewCache.asyncState.error,
    loadingGitDiffs: diffPreview.isPending,
    loadingTurnIds,
    reviewSections,
    selectedSection,
    refreshSelectedSection,
    selectSection,
  };
}

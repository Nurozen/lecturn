import * as Dialog from "../../../components/ui/Dialog";
import { useMobileSagaIndex } from "../../../state/stave";
import { resolveRepositoryScope } from "@lecturn/client-runtime/state/repositoryScope";
import { useProjects } from "../../../state/entities";
import { useOpenPullRequest } from "../../../native/useOpenPullRequest";
import { tryOpenExternalUrl } from "../../../lib/openExternalUrl";
import {
  type GitActionRequestInput,
  buildMenuItems,
  getGitActionDisabledReason,
  requiresDefaultBranchConfirmation,
} from "@lecturn/client-runtime/state/vcs";
import { isStaveProject, type ProjectGitTarget } from "@lecturn/client-runtime/state/projectGit";
import { EnvironmentId, ThreadId, type ProjectId, WS_METHODS } from "@lecturn/contracts";
import {
  CommonActions,
  StackActions,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { createEnvironmentRpcQueryAtomFamily } from "@lecturn/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../../../connection/runtime";
import { WatchPullRequestButton } from "../../pull-request-watch/WatchPullRequestButton";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { useEffect, useState } from "react";
import { Platform, Pressable, RefreshControl, ScrollView, View } from "react-native";

import { ScreenStack } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NativeSheetContent } from "../../../native/NativeSheetContent";
import { NativeHeader, NativeScreen } from "../../../native/ThemedScreenStack";
import {
  AndroidHeaderIconButton,
  AndroidSheetHeader,
} from "../../../components/ui/AndroidScreenHeader";
import { AndroidAnchoredMenu } from "../../../components/ui/AndroidAnchoredMenu";
import { ListRow } from "../../../components/ui/ListRow";
import { ListSection } from "../../../components/ui/ListSection";
import { ScreenContent } from "../../../components/ui/ScreenContent";
import { useAdaptiveWorkspaceLayout } from "../../layout/AdaptiveWorkspaceLayout";
import { AppText as Text } from "../../../components/ui/AppText";
import {
  NativeStackScreenOptions,
  nativeHeaderScrollEdgeEffects,
} from "../../../native/StackHeader";
import { useEnvironmentQuery } from "../../../state/query";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../../state/use-selected-thread-git-state";
import { useSelectedThreadWorktree } from "../../../state/use-selected-thread-worktree";
import { vcsEnvironment } from "../../../state/vcs";
import { resolveGitOverviewReviewNavigationAction } from "./git-overview-navigation";
import { menuItemIconName, statusSummary } from "./gitSheetComponents";
import {
  LinkedPullRequestRow,
  linkedPullRequestKey,
  useLinkedPullRequestLines,
} from "../LinkedPullRequestList";
import { useLinkedPullRequestActions } from "../useLinkedPullRequestActions";
import { PullRequestGlyph } from "../../pull-requests/pullRequestGlyphs";

const spacePullRequests = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile:project-pull-requests",
  tag: WS_METHODS.pullRequestsList,
  staleTimeMs: 30_000,
});

function ProjectPullRequests(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}) {
  const projects = useProjects();
  const sagaIndex = useMobileSagaIndex(projects, true);
  const projectIds = [
    ...new Set([
      props.projectId,
      ...resolveRepositoryScope({
        projects,
        sagaIndex,
        roots: [{ environmentId: props.environmentId, projectId: props.projectId }],
      }).flatMap((target) => target.projectIds),
    ]),
  ];
  const query = useEnvironmentQuery(
    spacePullRequests({
      environmentId: props.environmentId,
      input: { projectIds, state: "open", limit: 50 },
    }),
  );
  const groups = new Map<string, NonNullable<typeof query.data>["entries"][number][]>();
  for (const pr of query.data?.entries ?? []) {
    const key = `${pr.host} / ${pr.repository}`;
    const group = groups.get(key) ?? [];
    group.push(pr);
    groups.set(key, group);
  }
  return (
    <ListSection title="Pull requests">
      {query.error ? <PullRequestsNotice text={query.error} /> : null}
      {query.isPending && !query.data ? <PullRequestsNotice text="Loading pull requests…" /> : null}
      {query.data?.entries.length === 0 && query.data.errors.length === 0 ? (
        <PullRequestsNotice text="No open pull requests." />
      ) : null}
      {[...groups].map(([repository, prs]) => (
        <View key={repository}>
          <PullRequestsNotice text={repository} />
          {prs.map((pr) => (
            <View key={pr.number}>
              <ListRow
                icon={PullRequestGlyph.pullRequest}
                label={`#${pr.number} ${pr.title}`}
                description={`${pr.headBranch} → ${pr.baseBranch}${pr.isDraft ? " · Draft" : ""}`}
                onPress={() => {
                  void tryOpenExternalUrl(pr.url, "pull-request");
                }}
              />
              <WatchPullRequestButton
                environmentId={props.environmentId}
                threadId={props.threadId}
                reference={{
                  projectId: pr.projectId,
                  host: pr.host,
                  repository: pr.repository,
                  number: pr.number,
                }}
              />
            </View>
          ))}
        </View>
      ))}
      {query.data?.errors.map((error) => (
        <PullRequestsNotice key={`${error.projectId}:${error.message}`} text={error.message} />
      ))}
      {query.data?.truncated ? (
        <PullRequestsNotice text="Showing the first 50 open pull requests per repository." />
      ) : null}
      <ListRow icon="arrow.clockwise" label="Refresh pull requests" onPress={query.refresh} />
    </ListSection>
  );
}

function PullRequestsNotice(props: { readonly text: string }) {
  return (
    <Text textRole="footnote" className="px-4 pt-3 text-foreground-muted">
      {props.text}
    </Text>
  );
}

function SpaceRepositoryRow(props: {
  readonly environmentId: EnvironmentId;
  readonly target: ProjectGitTarget;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onSelect: () => void;
}) {
  const query = useEnvironmentQuery(
    vcsEnvironment.status({ environmentId: props.environmentId, input: { cwd: props.target.cwd } }),
  );
  const conflicts = query.data?.workingTree.files.filter((file) => file.conflicted).length ?? 0;
  return (
    <ListRow
      icon={props.selected ? "checkmark.circle" : "folder"}
      label={`${props.target.repoName}${props.target.mode === "reference" ? " · Read-only reference" : ""}`}
      description={`${query.data?.refName ?? props.target.branch ?? "Detached HEAD"} · ${query.error ?? statusSummary(query.data)}${conflicts ? ` · ${conflicts} conflicts` : ""}\n${props.target.cwd}`}
      disabled={props.disabled}
      onPress={props.onSelect}
    />
  );
}

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

type GitOverviewSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}> & {
  readonly headerInset?: number;
  readonly presentation?: "sheet" | "inspector";
};

export function GitOverviewSheet(props: GitOverviewSheetProps) {
  const navigation = useNavigation();
  const { environmentId, threadId } = props.route.params;
  const isBlankLink = environmentId.trim().length === 0 || threadId.trim().length === 0;
  useEffect(() => {
    if (isBlankLink) navigation.goBack();
  }, [isBlankLink, navigation]);
  if (isBlankLink) return null;
  return <GitOverviewSheetContent {...props} />;
}

function GitOverviewSheetContent(props: GitOverviewSheetProps) {
  const { layout } = useAdaptiveWorkspaceLayout();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const presentation = props.presentation ?? "sheet";
  const isInspector = presentation === "inspector";
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const threadId = ThreadId.make(props.route.params.threadId);
  const { selectedThread, selectedThreadProject, selectedEnvironmentRuntime } =
    useThreadSelection();
  const openPullRequest = useOpenPullRequest({
    replace: presentation === "sheet",
    context: selectedThread ?? undefined,
  });
  const {
    selectedThreadGitCwd,
    selectedThreadWorktreePath,
    selectedThreadGitTargets,
    selectedThreadGitRepository,
    selectGitRepository,
  } = useSelectedThreadWorktree();
  const linkedPrLines = useLinkedPullRequestLines(selectedThread, selectedEnvironmentRuntime);
  const linkedPrActions = useLinkedPullRequestActions({
    thread: selectedThread,
    project: selectedThreadProject,
    runtime: selectedEnvironmentRuntime,
  });
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();
  const { canWriteSourceControl, canChangeThreadBranch } = gitActions;
  const worktreesSupported = !isStaveProject(selectedThreadProject);
  const readOnly = selectedThreadGitRepository?.mode === "reference";
  const repoParams =
    !worktreesSupported && selectedThreadGitRepository
      ? { repoKey: selectedThreadGitRepository.key }
      : {};

  const gitStatus = useEnvironmentQuery(
    selectedThread !== null && selectedThreadGitCwd !== null
      ? vcsEnvironment.status({
          environmentId: selectedThread.environmentId,
          input: { cwd: selectedThreadGitCwd },
        })
      : null,
  );

  const currentBranchLabel =
    gitStatus.data?.refName ??
    selectedThreadGitRepository?.branch ??
    selectedThread?.branch ??
    "Detached HEAD";
  const currentStatusSummary = statusSummary(gitStatus.data);
  const currentWorktreePath = selectedThreadWorktreePath;
  const gitOperationLabel = gitState.gitOperationLabel;
  const busy = gitOperationLabel !== null;
  const isRepo = selectedThreadGitCwd !== null && (gitStatus.data?.isRepo ?? true);
  const hasPrimaryRemote = gitStatus.data?.hasPrimaryRemote ?? false;
  const isDefaultRef = gitStatus.data?.isDefaultRef ?? false;

  const menuItems = isRepo
    ? buildMenuItems(gitStatus.data, busy, hasPrimaryRemote).filter(
        (item) => !readOnly || item.kind === "open_pr",
      )
    : [];

  const sheetMenuItems = menuItems.map((item) => ({
    item: {
      ...item,
      disabled: item.disabled || (!canWriteSourceControl && item.kind !== "open_pr"),
    },
    disabledReason:
      !canWriteSourceControl && item.kind !== "open_pr"
        ? "This connection cannot change source control."
        : getGitActionDisabledReason({
            item,
            gitStatus: gitStatus.data,
            isBusy: busy,
            hasOriginRemote: hasPrimaryRemote,
          }),
  }));

  const openExistingPr = async () => {
    const prUrl = gitStatus.data?.pr?.state === "open" ? gitStatus.data.pr.url : null;
    if (!prUrl) {
      Dialog.alert("No open PR", "This branch does not have an open pull request.");
      return;
    }
    if (!(await openPullRequest(prUrl))) {
      Dialog.alert("Unable to open PR", "The pull request could not be opened.");
    }
  };

  const runActionWithPrompt = async (input: GitActionRequestInput) => {
    if (!canWriteSourceControl) return;
    const confirmableAction =
      input.action === "push" ||
      input.action === "create_pr" ||
      input.action === "commit_push" ||
      input.action === "commit_push_pr"
        ? input.action
        : null;
    const branchName = gitStatus.data?.refName;
    if (
      branchName &&
      confirmableAction &&
      !input.featureBranch &&
      requiresDefaultBranchConfirmation(input.action, isDefaultRef)
    ) {
      navigation.navigate("GitConfirm", {
        environmentId: String(environmentId),
        threadId: String(threadId),
        ...repoParams,
        confirmAction: confirmableAction,
        branchName,
        includesCommit: String(input.action === "commit_push" || input.action === "commit_push_pr"),
      });
      return;
    }

    if (!isInspector) {
      navigation.goBack();
    }
    await gitActions.onRunSelectedThreadGitAction(input);
  };

  const onPressMenuItem = async (item: (typeof menuItems)[number]) => {
    if (item.disabled) return;
    if (item.kind === "open_pr") {
      await openExistingPr();
      return;
    }
    if (!canWriteSourceControl) return;
    if (item.dialogAction === "commit") {
      navigation.navigate("GitCommit", {
        environmentId: String(environmentId),
        threadId: String(threadId),
        ...repoParams,
      });
      return;
    }
    if (item.dialogAction === "push") {
      await runActionWithPrompt({ action: "push" });
      return;
    }
    if (item.dialogAction === "create_pr") {
      await runActionWithPrompt({ action: "create_pr" });
    }
  };

  const rowStatusDetail = (item: (typeof menuItems)[number]): string | undefined => {
    const status = gitStatus.data;
    if (status == null) {
      return undefined;
    }
    if (item.dialogAction === "commit" && status.hasWorkingTreeChanges) {
      const fileCount = status.workingTree?.files.length ?? 0;
      return `${fileCount} file${fileCount === 1 ? "" : "s"} changed`;
    }
    if (item.dialogAction === "push" && (status.aheadCount ?? 0) > 0) {
      const ahead = status.aheadCount ?? 0;
      return `${ahead} commit${ahead === 1 ? "" : "s"} ahead`;
    }
    if (item.kind === "open_pr" && status.pr?.number != null) {
      return `PR #${status.pr.number} ${status.pr.state ?? "open"}`;
    }
    return undefined;
  };

  const behindCount = gitStatus.data?.behindCount ?? 0;

  // Tying RefreshControl to the query's isPending flag left the spinner stuck
  // (the status query reports pending during quiet background refreshes too).
  const [isRefreshing, setIsRefreshing] = useState(false);
  const handleRefresh = async () => {
    setIsRefreshing(true);
    await gitActions.refreshSelectedThreadGitStatus();
    setIsRefreshing(false);
  };

  const content = (
    <ScrollView
      nestedScrollEnabled
      alwaysBounceVertical
      className="flex-1 android:bg-sheet-solid ios:bg-screen"
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      showsVerticalScrollIndicator={false}
      contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
      contentContainerStyle={{
        paddingHorizontal: Platform.OS === "android" ? 8 : isInspector ? 12 : 20,
        paddingTop: 8,
        gap: Platform.OS === "android" ? 8 : 14,
      }}
      refreshControl={
        Platform.OS === "ios" || isInspector ? (
          <RefreshControl refreshing={isRefreshing} onRefresh={() => void handleRefresh()} />
        ) : undefined
      }
    >
      {!worktreesSupported ? (
        <ListSection
          title="Space repositories"
          footer="Select a repository for Git actions. Threads keep working across the whole space."
        >
          {selectedThreadGitTargets.length === 0 ? (
            <Text textRole="footnote" className="p-4 text-foreground-muted">
              This space has no repositories.
            </Text>
          ) : null}
          {selectedThreadGitTargets.map((target) => (
            <SpaceRepositoryRow
              key={target.key}
              environmentId={environmentId}
              target={target}
              selected={target.key === selectedThreadGitRepository?.key}
              disabled={busy}
              onSelect={() => selectGitRepository(target.key)}
            />
          ))}
        </ListSection>
      ) : null}
      {!worktreesSupported && selectedThreadGitRepository ? (
        <ListSection title={readOnly ? "Inspecting reference" : "Selected repository"}>
          <Text selectable textRole="footnote" className="p-4 text-foreground-muted">
            {selectedThreadGitRepository.cwd}
          </Text>
        </ListSection>
      ) : null}
      <ListSection>
        {sheetMenuItems.map(({ item, disabledReason }) => (
          <ListRow
            key={`${item.id}-${item.label}`}
            icon={menuItemIconName(item.icon)}
            label={item.label}
            description={disabledReason ?? rowStatusDetail(item)}
            disabled={item.disabled}
            onPress={() => void onPressMenuItem(item)}
          />
        ))}
        {behindCount > 0 && !readOnly ? (
          <ListRow
            icon="arrow.down.circle"
            label="Pull latest"
            description={
              canWriteSourceControl
                ? `${behindCount} commit${behindCount === 1 ? "" : "s"} behind upstream`
                : "This connection cannot change source control."
            }
            disabled={!canWriteSourceControl || busy || !isRepo}
            onPress={() => void gitActions.onPullSelectedThreadBranch()}
          />
        ) : null}
        <ListRow
          icon="text.bubble"
          label="Review changes"
          description={
            worktreesSupported
              ? "Inspect changes, uncommitted edits, and turn diffs"
              : "Inspect changes and uncommitted edits"
          }
          disabled={busy || !isRepo}
          onPress={() => {
            const params = { environmentId, threadId, ...repoParams };
            navigation.dispatch(
              resolveGitOverviewReviewNavigationAction(presentation) === "replace"
                ? StackActions.replace("ThreadReview", params)
                : CommonActions.navigate("ThreadReview", params),
            );
          }}
        />
        <ListRow
          icon="point.topleft.down.curvedto.point.bottomright.up"
          label={worktreesSupported ? "Branches & worktrees" : "Branches"}
          description={
            !canChangeThreadBranch
              ? worktreesSupported
                ? "View branches and worktrees"
                : "View branches"
              : worktreesSupported
                ? "Switch branch, create branch, or move to a worktree"
                : "Switch branch or create branch"
          }
          disabled={busy || !isRepo || readOnly}
          onPress={() =>
            navigation.navigate("GitBranches", {
              environmentId: String(environmentId),
              threadId: String(threadId),
              ...repoParams,
            })
          }
        />
        {linkedPrActions.canLink ? (
          <ListRow
            icon="link"
            label="Link pull request"
            description="Attach a pull request by URL or number"
            onPress={linkedPrActions.promptLink}
          />
        ) : null}
      </ListSection>

      {linkedPrLines.length > 0 ? (
        <ListSection title="Linked pull requests">
          {linkedPrLines.map((line, index) => (
            <LinkedPullRequestRow
              key={linkedPullRequestKey(line)}
              line={line}
              separator={index < linkedPrLines.length - 1}
              surfaceClassName="text-grouped-card"
              openPullRequest={openPullRequest}
              actions={linkedPrActions}
            />
          ))}
        </ListSection>
      ) : null}

      {selectedThreadProject ? (
        <ProjectPullRequests
          environmentId={environmentId}
          projectId={selectedThreadProject.id}
          threadId={threadId}
        />
      ) : null}
      {currentWorktreePath ? (
        <ListSection title="Worktree">
          <Text selectable textRole="footnote" className="p-4 text-foreground-muted">
            {currentWorktreePath}
          </Text>
        </ListSection>
      ) : null}
    </ScrollView>
  );

  if (isInspector && Platform.OS === "ios") {
    return (
      <View collapsable={false} className="flex-1 border-l border-border bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <NativeScreen
            activityState={2}
            enabled
            isNativeStack
            screenId="thread-git-inspector-native"
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            className="flex-1 bg-sheet"
          >
            <NativeSheetContent>{content}</NativeSheetContent>
            <NativeHeader
              backgroundColor="rgba(0,0,0,0)"
              tintColorClassName="accent-foreground"
              hideBackButton
              hideShadow={false}
              navigationItemStyle="editor"
              title={currentBranchLabel}
              titleColorClassName="accent-foreground"
              titleFontSize={17}
              titleFontWeight="700"
              translucent
            />
          </NativeScreen>
        </ScreenStack>
      </View>
    );
  }

  if (Platform.OS === "ios") {
    // Compact form sheet: a plain screen presented as formSheet never renders a
    // stack header, so — like the Settings sheet — the header must come from a
    // nested native stack INSIDE the sheet.
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <NativeScreen
            activityState={2}
            enabled
            isNativeStack
            screenId="thread-git-sheet-native"
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            className="flex-1 bg-sheet"
          >
            <NativeSheetContent>{content}</NativeSheetContent>
            <NativeHeader
              backgroundColor="rgba(0,0,0,0)"
              tintColorClassName="accent-foreground"
              hideBackButton
              hideShadow={false}
              navigationItemStyle="editor"
              title={currentBranchLabel}
              titleColorClassName="accent-foreground"
              titleFontSize={18}
              titleFontWeight="800"
              translucent
            />
          </NativeScreen>
        </ScreenStack>
      </View>
    );
  }

  const refreshMenu = (
    <AndroidAnchoredMenu
      title="Repository options"
      actions={[
        {
          id: "refresh",
          title: "Refresh repository status",
          attributes: { disabled: busy || isRefreshing },
        },
      ]}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "refresh") void handleRefresh();
      }}
    >
      {(open) => (
        <AndroidHeaderIconButton
          accessibilityLabel="Repository options"
          icon="ellipsis"
          onPress={open}
        />
      )}
    </AndroidAnchoredMenu>
  );

  return (
    <View
      collapsable={false}
      className={
        Platform.OS === "android"
          ? "flex-1 bg-header"
          : isInspector
            ? "flex-1 border-l border-border bg-sheet"
            : "flex-1 bg-sheet"
      }
    >
      {!isInspector ? (
        <NativeStackScreenOptions
          options={{ sheetCornerRadius: Platform.OS === "android" ? 28 : undefined }}
        />
      ) : null}
      {isInspector ? (
        <View
          style={{
            minHeight: props.headerInset ?? 0,
            paddingTop: props.headerInset ?? 0,
          }}
        />
      ) : null}

      {isInspector ? (
        <View className="gap-1 px-4 pb-4 pt-3 android:bg-header ios:border-b ios:border-border">
          {Platform.OS === "android" ? (
            <View className="absolute right-3 top-4 z-[1]">{refreshMenu}</View>
          ) : (
            <Pressable
              className={
                busy
                  ? "absolute right-3 top-4 z-[1] h-9 w-9 items-center justify-center rounded-full bg-subtle opacity-[0.45]"
                  : "absolute right-3 top-4 z-[1] h-9 w-9 items-center justify-center rounded-full bg-subtle"
              }
              disabled={busy}
              onPress={() => void gitActions.refreshSelectedThreadGitStatus()}
            >
              <SymbolView
                name="arrow.clockwise"
                size={16}
                tintColorClassName="accent-icon"
                type="monochrome"
                weight="medium"
              />
            </Pressable>
          )}
          <Text className="text-xs font-lecturn-bold tracking-[1px] uppercase text-foreground-muted">
            Repository
          </Text>
          <Text className="pr-10 text-xl font-lecturn-bold">{currentBranchLabel}</Text>
          <Text className="text-foreground-secondary text-sm font-medium leading-normal">
            {currentStatusSummary}
          </Text>
        </View>
      ) : (
        <AndroidSheetHeader
          title={currentBranchLabel}
          hideBottomBorder={Platform.OS === "android"}
          subtitle={currentStatusSummary}
          onBack={() => navigation.goBack()}
          trailing={Platform.OS === "android" ? refreshMenu : undefined}
          actions={
            Platform.OS === "android"
              ? undefined
              : [
                  {
                    accessibilityLabel: "Refresh repository status",
                    disabled: busy,
                    icon: "arrow.clockwise",
                    onPress: () => void gitActions.refreshSelectedThreadGitStatus(),
                  },
                ]
          }
        />
      )}

      <ScreenContent insetHorizontal={layout.usesSplitView}>{content}</ScreenContent>
    </View>
  );
}

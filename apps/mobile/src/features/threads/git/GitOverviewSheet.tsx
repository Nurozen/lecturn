import { GlassCard } from "../../../components/GlassCard";
import { useMobileSagaIndex } from "../../../state/stave";
import { resolveRepositoryScope } from "@lecturn/client-runtime/state/repositoryScope";
import { useProjects } from "../../../state/entities";
import {
  type GitActionRequestInput,
  buildMenuItems,
  getGitActionDisabledReason,
  requiresDefaultBranchConfirmation,
} from "@lecturn/client-runtime/state/vcs";
import { isStaveProject, type ProjectGitTarget } from "@lecturn/client-runtime/state/projectGit";
import {
  resolveThreadPullRequestChains,
  threadPullRequestKeyOf,
} from "@lecturn/shared/threadPullRequests";
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
import { SymbolView } from "../../../components/AppSymbol";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Alert, Platform, Pressable, RefreshControl, ScrollView, View } from "react-native";

import { Screen, ScreenStack, ScreenStackHeaderConfig } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useUniwindTheme } from "../../../lib/useUniwindTheme";
import {
  AndroidHeaderIconButton,
  AndroidSheetHeader,
} from "../../../components/AndroidScreenHeader";
import { AndroidAnchoredMenu } from "../../../components/AndroidAnchoredMenu";
import { MaterialScreenContent } from "../../../components/MaterialScreenContent";
import { useAdaptiveWorkspaceLayout } from "../../layout/AdaptiveWorkspaceLayout";
import { AppText as Text } from "../../../components/AppText";
import {
  NativeStackScreenOptions,
  nativeHeaderScrollEdgeEffects,
} from "../../../native/StackHeader";
import { tryOpenExternalUrl } from "../../../lib/openExternalUrl";
import { useEnvironmentQuery } from "../../../state/query";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../../state/use-selected-thread-git-state";
import { useSelectedThreadWorktree } from "../../../state/use-selected-thread-worktree";
import { vcsEnvironment } from "../../../state/vcs";
import { resolveGitOverviewReviewNavigationAction } from "./git-overview-navigation";
import { MetaCard, SheetListRow, menuItemIconName, statusSummary } from "./gitSheetComponents";

/** Android uses flat Material groups; iOS keeps Lecturn's glass cards. */
function SheetGroupCard(props: { readonly className?: string; readonly children: ReactNode }) {
  if (Platform.OS === "android") {
    return <View className="overflow-hidden rounded-[20px] bg-card">{props.children}</View>;
  }
  return <GlassCard className={props.className}>{props.children}</GlassCard>;
}

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
    <GlassCard className="gap-2 px-4 py-3">
      <Text className="font-lecturn-bold text-base">Pull requests</Text>
      {query.error ? <Text className="text-foreground-muted text-sm">{query.error}</Text> : null}
      {query.isPending && !query.data ? (
        <Text className="text-foreground-muted text-sm">Loading pull requests…</Text>
      ) : null}
      {query.data?.entries.length === 0 && query.data.errors.length === 0 ? (
        <Text className="text-foreground-muted text-sm">No open pull requests.</Text>
      ) : null}
      {[...groups].map(([repository, prs]) => (
        <View key={repository} className="gap-1">
          <Text className="text-foreground-muted text-xs">{repository}</Text>
          {prs.map((pr) => (
            <View key={pr.number}>
              <SheetListRow
                icon="arrow.triangle.pull"
                title={`#${pr.number} ${pr.title}`}
                subtitle={`${pr.headBranch} → ${pr.baseBranch}${pr.isDraft ? " · Draft" : ""}`}
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
        <Text key={`${error.projectId}:${error.message}`} className="text-foreground-muted text-sm">
          {error.message}
        </Text>
      ))}
      {query.data?.truncated ? (
        <Text className="text-foreground-muted text-sm">
          Showing the first 50 open pull requests per repository.
        </Text>
      ) : null}
      <Pressable accessibilityRole="button" onPress={query.refresh}>
        <Text className="text-primary text-sm">Refresh pull requests</Text>
      </Pressable>
    </GlassCard>
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
    <SheetListRow
      icon={props.selected ? "checkmark.circle" : "folder"}
      title={`${props.target.repoName}${props.target.mode === "reference" ? " · Read-only reference" : ""}`}
      subtitle={`${query.data?.refName ?? props.target.branch ?? "Detached HEAD"} · ${query.error ?? statusSummary(query.data)}${conflicts ? ` · ${conflicts} conflicts` : ""}\n${props.target.cwd}`}
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
  const { layout } = useAdaptiveWorkspaceLayout();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const presentation = props.presentation ?? "sheet";
  const isInspector = presentation === "inspector";
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const threadId = ThreadId.make(props.route.params.threadId);
  const { selectedThread, selectedThreadProject, selectedEnvironmentRuntime } =
    useThreadSelection();
  const {
    selectedThreadGitCwd,
    selectedThreadWorktreePath,
    selectedThreadGitTargets,
    selectedThreadGitRepository,
    selectGitRepository,
  } = useSelectedThreadWorktree();
  const supportsLinkedPrSnapshots =
    selectedEnvironmentRuntime?.serverConfig?.environment.capabilities.threadPullRequests === true;
  const linkedPrChains = useMemo(
    () =>
      resolveThreadPullRequestChains(
        supportsLinkedPrSnapshots ? (selectedThread?.pullRequests ?? []) : [],
      ),
    [selectedThread?.pullRequests, supportsLinkedPrSnapshots],
  );
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();
  const theme = useUniwindTheme();
  const foregroundColor = theme["--color-foreground"];
  const sheetColor = theme["--color-sheet"];
  const worktreesSupported = !isStaveProject(selectedThreadProject);
  const readOnly = selectedThreadGitRepository?.mode === "reference";
  const repoParams = useMemo(
    () =>
      !worktreesSupported && selectedThreadGitRepository
        ? { repoKey: selectedThreadGitRepository.key }
        : {},
    [worktreesSupported, selectedThreadGitRepository],
  );

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

  const menuItems = useMemo(
    () =>
      isRepo
        ? buildMenuItems(gitStatus.data, busy, hasPrimaryRemote).filter(
            (item) => !readOnly || item.kind === "open_pr",
          )
        : [],
    [busy, gitStatus.data, hasPrimaryRemote, isRepo, readOnly],
  );

  const sheetMenuItems = useMemo(
    () =>
      menuItems.map((item) => ({
        item,
        disabledReason: getGitActionDisabledReason({
          item,
          gitStatus: gitStatus.data,
          isBusy: busy,
          hasOriginRemote: hasPrimaryRemote,
        }),
      })),
    [busy, gitStatus.data, hasPrimaryRemote, menuItems],
  );

  const { refreshSelectedThreadGitStatus } = gitActions;
  useEffect(() => {
    void refreshSelectedThreadGitStatus({ quiet: true });
  }, [refreshSelectedThreadGitStatus]);

  const openExistingPr = useCallback(async () => {
    const prUrl = gitStatus.data?.pr?.state === "open" ? gitStatus.data.pr.url : null;
    if (!prUrl) {
      Alert.alert("No open PR", "This branch does not have an open pull request.");
      return;
    }
    if (!(await tryOpenExternalUrl(prUrl, "pull-request"))) {
      Alert.alert("Unable to open PR", "The pull request could not be opened.");
    }
  }, [gitStatus.data]);

  const runActionWithPrompt = useCallback(
    async (input: GitActionRequestInput) => {
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
          includesCommit: String(
            input.action === "commit_push" || input.action === "commit_push_pr",
          ),
        });
        return;
      }

      if (!isInspector) {
        navigation.goBack();
      }
      await gitActions.onRunSelectedThreadGitAction(input);
    },
    [
      environmentId,
      gitActions,
      gitStatus.data,
      isDefaultRef,
      isInspector,
      navigation,
      repoParams,
      threadId,
    ],
  );

  const onPressMenuItem = useCallback(
    async (item: (typeof menuItems)[number]) => {
      if (item.disabled) return;
      if (item.kind === "open_pr") {
        await openExistingPr();
        return;
      }
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
    },
    [environmentId, openExistingPr, navigation, repoParams, runActionWithPrompt, threadId],
  );

  // Status facts live on the relevant rows instead of crowding the header
  // subtitle: files changed → Commit, ahead → Push, PR → View PR, behind → Pull.
  const rowStatusDetail = useCallback(
    (item: (typeof menuItems)[number]): string | undefined => {
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
    },
    [gitStatus.data],
  );

  const behindCount = gitStatus.data?.behindCount ?? 0;

  // Deterministic pull-to-refresh state. Tying RefreshControl to the query's
  // isPending flag left the spinner stuck (the status query reports pending
  // during quiet background refreshes too).
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const handlePullRefresh = useCallback(async () => {
    setIsPullRefreshing(true);
    try {
      await gitActions.refreshSelectedThreadGitStatus();
    } finally {
      setIsPullRefreshing(false);
    }
  }, [gitActions]);

  const content = (
    <ScrollView
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
        <RefreshControl refreshing={isPullRefreshing} onRefresh={() => void handlePullRefresh()} />
      }
    >
      {!worktreesSupported ? (
        <GlassCard className="gap-1 px-4 py-3">
          <Text className="text-base font-lecturn-bold">Space repositories</Text>
          <Text className="text-sm text-foreground-muted">
            Select a repository for Git actions. Threads keep working across the whole space.
          </Text>
          {selectedThreadGitTargets.length === 0 ? (
            <Text className="text-sm text-foreground-muted">This space has no repositories.</Text>
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
        </GlassCard>
      ) : null}
      {!worktreesSupported && selectedThreadGitRepository ? (
        <MetaCard
          label={readOnly ? "Inspecting reference" : "Selected repository"}
          value={selectedThreadGitRepository.cwd}
        />
      ) : null}
      <SheetGroupCard className={isInspector ? "px-3 py-1" : "px-4 py-1"}>
        {sheetMenuItems.map(({ item, disabledReason }, index) => (
          <View key={`${item.id}-${item.label}`}>
            {index > 0 && Platform.OS !== "android" ? (
              <View className="ml-12 h-px bg-border" />
            ) : null}
            <SheetListRow
              icon={menuItemIconName(item.icon)}
              title={item.label}
              subtitle={disabledReason ?? rowStatusDetail(item)}
              disabled={item.disabled}
              onPress={() => void onPressMenuItem(item)}
            />
          </View>
        ))}
        {behindCount > 0 && !readOnly ? (
          <>
            {Platform.OS !== "android" ? <View className="ml-12 h-px bg-border" /> : null}
            <SheetListRow
              icon="arrow.down.circle"
              title="Pull latest"
              subtitle={`${behindCount} commit${behindCount === 1 ? "" : "s"} behind upstream`}
              disabled={busy || !isRepo}
              onPress={() => void gitActions.onPullSelectedThreadBranch()}
            />
          </>
        ) : null}
        {Platform.OS !== "android" ? <View className="ml-12 h-px bg-border" /> : null}
        <SheetListRow
          icon="text.bubble"
          title="Review changes"
          subtitle={
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
        {Platform.OS !== "android" ? <View className="ml-12 h-px bg-border" /> : null}
        <SheetListRow
          icon="point.topleft.down.curvedto.point.bottomright.up"
          title={worktreesSupported ? "Branches & worktrees" : "Branches"}
          subtitle={
            worktreesSupported
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
      </SheetGroupCard>

      {linkedPrChains.length > 0 ? (
        <View className="gap-2">
          <Text className="px-1 text-xs font-lecturn-bold text-foreground-muted">
            Linked pull requests
          </Text>
          {linkedPrChains.map((chain) => (
            <SheetGroupCard key={threadPullRequestKeyOf(chain.layers[0]!)} className="px-3 py-1">
              {chain.layers.length > 1 ? (
                <View className="flex-row items-center gap-2 px-1 pt-2 pb-1">
                  <SymbolView
                    name="square.3.layers.3d"
                    size={14}
                    tintColorClassName="accent-foreground-muted"
                  />
                  <Text className="text-xs text-foreground-muted">
                    {chain.kind === "native" ? "Stack" : "Branch stack"} · {chain.layers.length} PRs
                    · bottom to top
                  </Text>
                </View>
              ) : null}
              {chain.layers.map((link, index) => (
                <View key={threadPullRequestKeyOf(link)}>
                  {index > 0 && Platform.OS !== "android" ? (
                    <View className="ml-12 h-px bg-border" />
                  ) : null}
                  <SheetListRow
                    icon="arrow.triangle.pull"
                    title={`#${link.number} ${link.snapshot?.title ?? "Pull request"}`}
                    subtitle={`${link.repository} · ${link.snapshot === null ? "Status pending" : link.snapshot.isDraft && link.snapshot.state === "open" ? "Draft" : link.snapshot.state}${link.watch === undefined ? "" : " · Watching"}`}
                    onPress={() => {
                      void tryOpenExternalUrl(link.url, "pull-request").then((opened) => {
                        if (!opened)
                          Alert.alert("Unable to open PR", "The pull request could not be opened.");
                      });
                    }}
                  />
                </View>
              ))}
            </SheetGroupCard>
          ))}
        </View>
      ) : null}

      {selectedThreadProject ? (
        <ProjectPullRequests
          environmentId={environmentId}
          projectId={selectedThreadProject.id}
          threadId={threadId}
        />
      ) : null}
      {currentWorktreePath ? <MetaCard label="Worktree" value={currentWorktreePath} /> : null}
    </ScrollView>
  );

  if (isInspector && Platform.OS === "ios") {
    return (
      <View collapsable={false} className="flex-1 border-l border-border bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <Screen
            activityState={2}
            enabled
            isNativeStack
            screenId="thread-git-inspector-native"
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            style={{ backgroundColor: sheetColor, flex: 1 }}
          >
            {content}
            <ScreenStackHeaderConfig
              backgroundColor="rgba(0,0,0,0)"
              color={foregroundColor}
              hideBackButton
              hideShadow={false}
              navigationItemStyle="editor"
              title={currentBranchLabel}
              titleColor={foregroundColor}
              titleFontSize={17}
              titleFontWeight="700"
              translucent
            />
          </Screen>
        </ScreenStack>
      </View>
    );
  }

  if (Platform.OS === "ios") {
    // Compact form sheet: a plain screen presented as formSheet never renders a
    // stack header, so — like the Settings sheet — the header must come from a
    // nested native stack INSIDE the sheet. This reuses the exact structure of the
    // inspector branch below: branch as the title, status summary as the native
    // subtitle, and content that owns pull-to-refresh.
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <Screen
            activityState={2}
            enabled
            isNativeStack
            screenId="thread-git-sheet-native"
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            style={{ backgroundColor: sheetColor, flex: 1 }}
          >
            {content}
            <ScreenStackHeaderConfig
              backgroundColor="rgba(0,0,0,0)"
              color={foregroundColor}
              hideBackButton
              hideShadow={false}
              navigationItemStyle="editor"
              title={currentBranchLabel}
              titleColor={foregroundColor}
              titleFontSize={18}
              titleFontWeight="800"
              translucent
            />
          </Screen>
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
          attributes: { disabled: busy || isPullRefreshing },
        },
      ]}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "refresh") void handlePullRefresh();
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

      <MaterialScreenContent insetHorizontal={layout.usesSplitView}>
        {content}
      </MaterialScreenContent>
    </View>
  );
}

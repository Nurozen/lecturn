import { useActiveNewTask } from "../../state/active-new-task";
import { ThreadUndoNotice } from "../home/ThreadUndoNotice";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { resolveScratchProjectScopeKey } from "@lecturn/client-runtime/state/project-grouping";
import {
  useAppearancePreferences,
  useAndroidFloatingTabs,
} from "../settings/appearance/AppearancePreferencesProvider";
import { threadMoveScopes } from "../home/threadMoveScopes";
import { HierarchyRow } from "../home/HierarchyRow";
import { accountSectionFrames } from "../home/accountSectionFrames";
import { HIERARCHY_LAYOUT_TRANSITION } from "../home/hierarchyMotion";
import { AnimatedLegendList } from "@legendapp/list/reanimated";
import { AccountSurfaceColorContext } from "../../lib/accountTintContext";
import { useAccountRowColors } from "../home/useAccountRowColors";
import {
  useAccountSectionDisplayStates,
  toggleMobileAccountSection,
  isAccountSectionKey,
} from "../home/accountSectionExpansion";
import { useAccountSections, useAccountAttention } from "../home/useAccountSections";
import { AccountSectionHeader } from "../home/AccountSectionHeader";
import { GlassCard } from "../../components/GlassCard";
import { buildSidebarHierarchy } from "./sidebar-hierarchy";
import { useMobileSagaIndex, useSidebarNestSagas } from "../../state/stave";
import { ArcaneBackdrop } from "../../components/ArcaneBackdrop";
import type { ThreadMoveDestination } from "./threadOrder";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@lecturn/client-runtime/state/shell";
import { threadSearchMatchKey } from "@lecturn/client-runtime/state/thread-search";
import type { MenuAction } from "@react-native-menu/menu";
import { useAtomValue } from "@effect/atom-react";
import { useMemo, useRef, useState } from "react";
import type { LayoutChangeEvent, TextInputInstance } from "react-native";
import { Platform, StyleSheet, TextInput, View } from "react-native";
import { GestureDetector, useNativeGesture } from "react-native-gesture-handler";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { useEnabledNavigationTabs } from "../workspace/navigation-tabs";
import { FLOATING_TABS, floatingTabsMetrics } from "../workspace/floating-workspace-tabs";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { SearchBarCommands } from "react-native-screens";

import { AppText as Text } from "../../components/ui/AppText";
import { CompactBrandTitle } from "../../components/CompactBrandTitle";
import { Menu } from "../../components/ui/Menu";
import { SymbolView } from "../../components/ui/AppSymbol";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";
import { useListedProjects, useListedThreadShells, useThreadShells } from "../../state/entities";
import { useThreadSearch } from "../../state/queries";
import { useThreadListV2ShelfPreferences } from "./use-thread-list-v2-shelf-preferences";
import { useThreadListNow } from "./use-thread-list-now";
import { usePendingThreadOrder } from "../../state/thread-order";
import { threadListEnvironmentsAtom } from "../../state/server";
import { usePendingNewTasks, type PendingNewTask } from "../../state/use-pending-new-tasks";
import { useQueuedThreadKeys } from "../../state/use-thread-outbox";
import { useWorkspaceState } from "../../state/workspace";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { useThreadListV2 } from "./useThreadListV2";
import { useThreadJumpShortcuts } from "../keyboard/threadKeyboardShortcuts";
import { requestThreadMessageJump } from "./threadMessageJump";
import { useThreadListSearchMatches } from "./useThreadListSearchMatches";
import { useHomeListOptions } from "../home/home-list-options";
import {
  buildHomeListFilterMenu,
  groupAccountFilterEnvironments,
} from "../home/home-list-filter-menu";
import {
  buildHomeHierarchyV2Items,
  DEFAULT_GROUP_DISPLAY_STATE,
  homeListItemsAreEqual,
  nextGroupDisplayState,
  type HomeGroupDisplayAction,
  type HomeGroupDisplayState,
  type HomeHierarchyV2Item,
} from "../home/homeListItems";
import { buildHomeProjectScopes, buildHomeThreadGroups } from "../home/homeThreadList";
import { SwipeableScrollGateProvider, useSwipeableScrollGate } from "../home/thread-swipe-actions";
import { usePendingTaskListActions } from "../home/usePendingTaskListActions";
import { useThreadListActions } from "../home/useThreadListActions";
import {
  getConnectionAwareBrandHeaderOptions,
  WorkspaceConnectionTitle,
} from "../home/WorkspaceConnectionTitle";
import { SidebarHeaderActions } from "./sidebar-header-actions";
import { ThreadListToolbar } from "../home/ThreadListToolbar";
import { useToolbarLayout } from "../../components/ui/useToolbarLayout";
import { useFabScroll } from "../home/FabScrollContext";
import { SidebarFilterButton } from "./sidebar-filter-button";
import { createSidebarHeaderItems } from "./sidebar-native-header-items";
import { SidebarNavigationShell } from "./sidebar-navigation-shell";
import { ThreadListGroupHeader, THREAD_ACTIVITY_VIEWABILITY_CONFIG } from "./thread-list-items";
import {
  ThreadListV2PendingRow,
  ThreadListV2Row,
  ThreadListV2SettledShelfHeader,
  ThreadListV2ShowMoreRow,
  ThreadListV2SnoozedShelfHeader,
  ThreadListV2WorkingShelfHeader,
} from "./thread-list-v2-items";
import { useThreadRowProviderInstanceResolver } from "./thread-provider-instance";
import type { ThreadPrPresentation } from "../../state/thread-pr-presentation";
import {
  isThreadListV2ListItem,
  threadListV2ListItemsAreEqual,
  type ThreadListV2ListItem,
} from "./threadListV2";
import { SquireHomeListRow, useSquireHomeItems } from "../squires/SquireHomeRows";
import { SquireMotionClock } from "../squires/SquireIndicator";
import { isHomeSquireItem } from "../squires/squireHomeItems.logic";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";

type SidebarListItem = (
  | HomeHierarchyV2Item
  | {
      readonly type: "v2-show-more";
      readonly key: string;
      readonly hiddenCount: number;
      readonly state?: "loading" | "failed";
    }
) & { readonly depth?: number };

const SIDEBAR_STICKY_HEADER_HEIGHT = 114;

/** Android hosts the sidebar list on the Material screen surface, so its rows
    and headers keep the compact Home margins. */
const SIDEBAR_ROW_PANE = Platform.OS === "android" ? "screen" : "sidebar";
const SIDEBAR_HEADER_VARIANT = Platform.OS === "android" ? "compact" : "sidebar";
/** Hierarchy groups only supply project/saga structure here (row order comes
    from the v2 partition), so their internal thread order is fixed. */
const HIERARCHY_THREAD_SORT_ORDER = "updated_at";

interface ThreadNavigationSidebarProps {
  readonly width: number;
  readonly visible: boolean;
  readonly selectedThreadKey: string | null;
  readonly onOpenSettings: () => void;
  readonly onOpenEnvironmentSettings: () => void;
  readonly onNewThreadOnBranch: (thread: EnvironmentThreadShell) => void;
  readonly onNewThreadInProject: (project: EnvironmentProject) => void;
  readonly onOpenPendingTask: (pendingTask: PendingNewTask) => void;
  readonly onSearchQueryChange: (query: string) => void;
  /** Only the scoping fields are needed: forking selects a child thread whose
      full shell has not arrived yet. */
  readonly onSelectThread: (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) => void;
  readonly onOpenThreadPullRequests: (
    thread: EnvironmentThreadShell,
    pr: ThreadPrPresentation,
  ) => void;
  readonly onRequestVisibility: () => void;
  readonly searchQuery: string;
}

export function ThreadNavigationSidebar(props: ThreadNavigationSidebarProps) {
  // Lecturn: one motion clock for every Squire indicator in the sidebar list.
  return (
    <SquireMotionClock>
      {Platform.OS !== "ios" ? (
        <ThreadNavigationSidebarPane {...props} nativeChrome={false} />
      ) : (
        <NativeSidebarContainer {...props} />
      )}
    </SquireMotionClock>
  );
}

function NativeSidebarContainer(props: ThreadNavigationSidebarProps) {
  return (
    <View
      testID="thread-navigation-sidebar"
      className="flex-1 border-border bg-drawer"
      style={{ borderRightWidth: StyleSheet.hairlineWidth, width: props.width }}
    >
      <SidebarNavigationShell>
        <ThreadNavigationSidebarPane {...props} nativeChrome />
      </SidebarNavigationShell>
    </View>
  );
}

function ThreadNavigationSidebarPane(
  props: ThreadNavigationSidebarProps & { readonly nativeChrome: boolean },
) {
  const accountSections = useAccountSections();
  const attention = useAccountAttention(accountSections);
  const floatingTabsEnabled = useAndroidFloatingTabs();
  const { themeVariables: materialTheme } = useAppearancePreferences();
  const drawerColor = materialTheme["--color-drawer"];

  const insets = useSafeAreaInsets();
  const { fabClearance, scale, fabSize } = useAndroidControlSizing();
  const enabledTabs = useEnabledNavigationTabs();
  const floatingTabs = floatingTabsMetrics(enabledTabs.length + 1, scale, fabSize, props.width);
  const projects = useListedProjects();
  const threads = useListedThreadShells();
  const allThreadShells = useThreadShells();
  const { environments: workspaceEnvironments, state: catalogState } = useWorkspaceState();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const searchInputRef = useRef<TextInputInstance>(null);
  const searchBarRef = useRef<SearchBarCommands>(null);
  const openSwipeableRef = useRef<SwipeableMethods | null>(null);
  const sidebarScrollGesture = useNativeGesture();
  const {
    archiveThread,
    confirmDeleteThread,
    settleThread,
    snoozeThread,
    unsnoozeThread,
    unsettleThread,
    pinThread,
    unpinThread,
    setThreadAutoSettle,
    moveThread,
    renameThread,
    regenerateThreadTitle,
    forkThread,
  } = useThreadListActions();
  const nestSagas = useSidebarNestSagas();
  const pendingTasks = usePendingNewTasks();
  const activeNewTask = useActiveNewTask();
  const queuedThreadKeys = useQueuedThreadKeys();
  const selectDetail = useSelectWorkspaceDetail();
  const { confirmDeletePendingTask } = usePendingTaskListActions((params) =>
    selectDetail({ name: "Thread", params }),
  );
  const environments = Object.values(savedConnectionsById)
    .map((connection) => ({
      environmentId: connection.environmentId,
      label: connection.environmentLabel,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
  const availableEnvironmentIds = new Set(
    environments.map((environment) => environment.environmentId),
  );
  const { options, setSelectedEnvironmentId, setSelectedProjectKey } =
    useHomeListOptions(availableEnvironmentIds);
  const searchEnvironmentIds =
    options.selectedEnvironmentId === null
      ? workspaceEnvironments
          .filter((environment) => environment.connectionState === "connected")
          .map((environment) => environment.environmentId)
      : workspaceEnvironments.some(
            (environment) =>
              environment.environmentId === options.selectedEnvironmentId &&
              environment.connectionState === "connected",
          )
        ? [options.selectedEnvironmentId]
        : [];
  // A legacy per-environment scratch key resolves here on every render; the stored
  // value is only rewritten when the user picks a filter.
  const resolvedProjectKey = resolveScratchProjectScopeKey(options.selectedProjectKey, projects, {
    sidebarProjectGroupingMode: options.projectGroupingMode,
    sidebarProjectGroupingOverrides: {},
  });
  const projectScopes = useMemo(
    () =>
      buildHomeProjectScopes({
        accountSections,
        projects,
        environmentId: options.selectedEnvironmentId,
        projectGroupingMode: options.projectGroupingMode,
      }),
    [accountSections, projects, options.selectedEnvironmentId, options.projectGroupingMode],
  );
  const projectFilterOptions = projectScopes.map((scope) => ({
    key: scope.key,
    label: scope.title,
  }));
  const projectTitleByProjectKey = useMemo(
    () =>
      new Map(
        projectScopes.flatMap((scope) =>
          scope.projectRefs.map(
            (projectRef) =>
              [
                scopedProjectKey(projectRef.environmentId, projectRef.projectId),
                scope.title,
              ] as const,
          ),
        ),
      ),
    [projectScopes],
  );
  const selectedProjectScope =
    projectScopes.find((scope) => scope.key === resolvedProjectKey) ?? null;
  const threadSearch = useThreadSearch(
    searchEnvironmentIds,
    props.searchQuery,
    selectedProjectScope === null
      ? {}
      : { projectIds: selectedProjectScope.projectRefs.map((ref) => ref.projectId) },
  );
  // This map reaches LegendList's extraData, which re-renders every row whenever it changes
  // identity; the hook keeps it stable.
  const threadSearchMatchByKey = useThreadListSearchMatches(threads, threadSearch);
  const matchedThreadKeys = new Set(threadSearchMatchByKey.keys());
  const selectedProjectKey = selectedProjectScope?.key ?? null;
  const selectedProjectRefs =
    selectedProjectScope === null
      ? null
      : new Set(
          selectedProjectScope.projectRefs.map((projectRef) =>
            scopedProjectKey(projectRef.environmentId, projectRef.projectId),
          ),
        );
  const scopedProjects =
    selectedProjectRefs === null
      ? projects
      : projects.filter((project) =>
          selectedProjectRefs.has(scopedProjectKey(project.environmentId, project.id)),
        );
  const scopedThreads =
    selectedProjectRefs === null
      ? threads
      : threads.filter((thread) =>
          selectedProjectRefs.has(scopedProjectKey(thread.environmentId, thread.projectId)),
        );
  const scopedPendingTasks =
    selectedProjectRefs === null
      ? pendingTasks
      : pendingTasks.filter((pendingTask) =>
          selectedProjectRefs.has(
            scopedProjectKey(pendingTask.environmentId, pendingTask.projectId),
          ),
        );
  const sagaIndex = useMobileSagaIndex(scopedProjects, nestSagas && props.visible);
  const groups = buildHomeThreadGroups({
    accountSections,
    includeStaveProjects: nestSagas,
    sagaIndex,
    projects: scopedProjects,
    threads: scopedThreads,
    pendingTasks: scopedPendingTasks,
    queuedThreadKeys,
    environmentId: options.selectedEnvironmentId,
    searchQuery: props.searchQuery,
    matchedThreadKeys,
    projectSortOrder: options.projectSortOrder,
    threadSortOrder: HIERARCHY_THREAD_SORT_ORDER,
    projectGroupingMode: options.projectGroupingMode,
  });
  const [groupDisplayStates, setGroupDisplayStates] = useState<
    ReadonlyMap<string, HomeGroupDisplayState>
  >(() => new Map());
  const updateGroupDisplay = (key: string, action: HomeGroupDisplayAction) => {
    if (isAccountSectionKey(key) && action === "toggle-collapsed") {
      toggleMobileAccountSection(key);
      return;
    }
    setGroupDisplayStates((previous) => {
      const next = new Map(previous);
      next.set(
        key,
        nextGroupDisplayState(
          previous.get(key) ?? {
            ...DEFAULT_GROUP_DISPLAY_STATE,
            collapsed: key.startsWith("settled:"),
          },
          action,
        ),
      );
      return next;
    });
  };
  const hasSearchQuery = props.searchQuery.trim().length > 0;
  const accountDisplayStates = useAccountSectionDisplayStates(groupDisplayStates);
  const projectByKey = useMemo(() => {
    const map = new Map<string, EnvironmentProject>();
    for (const project of projects) {
      map.set(scopedProjectKey(project.environmentId, project.id), project);
    }
    return map;
  }, [projects]);

  const {
    loaded: shelfPreferencesLoaded,
    settledShelfExpanded,
    snoozedShelfExpanded,
    workingShelfEnabled,
    workingShelfExpanded,
    toggleSettledShelf,
    toggleSnoozedShelf,
    toggleWorkingShelf,
  } = useThreadListV2ShelfPreferences();
  const now = useThreadListNow(threads);
  const listEnvironments = useAtomValue(threadListEnvironmentsAtom);
  const {
    providersByEnvironmentId,
    machineByEnvironmentId,
    settlementEnvironmentIds,
    snoozeEnvironmentIds,
    pinningEnvironmentIds,
    autoSettleOptOutEnvironmentIds,
    pinReorderEnvironmentIds,
    activeReorderEnvironmentIds,
    titleRegenerationEnvironmentIds,
    forkingEnvironmentIds,
  } = listEnvironments;
  const moveScopes = threadMoveScopes(
    buildHomeThreadGroups({
      accountSections,
      projects,
      threads,
      includeStaveProjects: nestSagas,
      sagaIndex,
      environmentId: null,
      searchQuery: "",
      projectSortOrder: options.projectSortOrder,
      threadSortOrder: HIERARCHY_THREAD_SORT_ORDER,
      projectGroupingMode: options.projectGroupingMode,
    }),
    sagaIndex,
  );
  const pendingOrder = usePendingThreadOrder(moveScopes);
  const handleMoveThread = (thread: EnvironmentThreadShell, direction: ThreadMoveDestination) => {
    const scope = moveScopes.get(scopedProjectKey(thread.environmentId, thread.projectId));
    if (scope) void moveThread(thread, direction, scope);
  };
  const resolveProviderInstance = useThreadRowProviderInstanceResolver(providersByEnvironmentId);
  const {
    layout: threadListV2Layout,
    items: threadListV2Items,
    contentOnlyThreadKeys,
    olderSettledShelf,
  } = useThreadListV2({
    threads,
    allThreads: allThreadShells,
    moveScopes,
    pendingTasks,
    environmentId: options.selectedEnvironmentId,
    projectRefs: selectedProjectScope === null ? null : selectedProjectScope.projectRefs,
    searchQuery: props.searchQuery,
    searchMatches: threadSearchMatchByKey,
    settlementEnvironmentIds,
    snoozeEnvironmentIds,
    pinReorderEnvironmentIds,
    activeReorderEnvironmentIds,
    queuedThreadKeys,
    settledLimit: Number.POSITIVE_INFINITY,
    now,
    pendingOrder,
    shelfPreferencesLoaded,
    workingShelfEnabled,
    workingShelfExpanded,
    snoozedShelfExpanded,
    settledShelfExpanded: true,
    selectedThreadKey: props.selectedThreadKey ?? null,
  });
  // Lecturn: the Squires section above the project tree, as on Home.
  const squireItems = useSquireHomeItems({
    environments,
    selectedEnvironmentId: options.selectedEnvironmentId,
    searching: hasSearchQuery,
  });
  const listItems = ((): readonly SidebarListItem[] => {
    const items: SidebarListItem[] = buildHomeHierarchyV2Items({
      accountSections,
      groups,
      items: threadListV2Items,
      sagaIndex,
      displayStates: accountDisplayStates,
      searching: hasSearchQuery,
      selectedThreadKey: props.selectedThreadKey,
      squires: squireItems,
    });
    if (settledShelfExpanded && threadListV2Layout.hiddenSettledCount > 0) {
      items.push({
        type: "v2-show-more",
        key: "v2-show-more",
        hiddenCount: threadListV2Layout.hiddenSettledCount,
        ...(olderSettledShelf.loading
          ? { state: "loading" as const }
          : olderSettledShelf.failed
            ? { state: "failed" as const }
            : {}),
      });
    }
    return items;
  })();
  const hierarchyGuides = buildSidebarHierarchy(listItems);
  const listMenuActions = [
    {
      id: "environment",
      title: "Environment",
      subactions: [
        {
          id: "environment:all",
          title: "All environments",
          subtitle: "Show threads from every environment",
          state: options.selectedEnvironmentId === null ? "on" : "off",
        },
        ...(accountSections
          ? groupAccountFilterEnvironments(environments, accountSections, attention).map(
              (group) => ({
                id: `account:${group.id}`,
                title: group.label,
                subactions: group.environments.map((environment) => ({
                  id: `environment:${environment.environmentId}`,
                  title: environment.label,
                  state:
                    options.selectedEnvironmentId === environment.environmentId
                      ? ("on" as const)
                      : ("off" as const),
                })),
              }),
            )
          : environments.map((environment) => ({
              id: `environment:${environment.environmentId}`,
              title: environment.label,
              state:
                options.selectedEnvironmentId === environment.environmentId
                  ? ("on" as const)
                  : ("off" as const),
            }))),
      ],
    },
    ...(projectFilterOptions.length === 0
      ? []
      : ([
          {
            id: "project",
            title: "Project",
            subactions: [
              {
                id: "project:all",
                title: "All projects",
                subtitle: "Show threads from every project",
                state: selectedProjectKey === null ? "on" : "off",
              },
              ...projectFilterOptions.map((project) => ({
                id: `project:${project.key}`,
                title: project.label,
                state: selectedProjectKey === project.key ? ("on" as const) : ("off" as const),
              })),
            ],
          },
        ] satisfies MenuAction[])),
  ] satisfies MenuAction[];
  const handleListMenuAction = ({
    nativeEvent,
  }: {
    readonly nativeEvent: { readonly event: string };
  }) => {
    const event = nativeEvent.event;
    if (event === "environment:all") {
      setSelectedEnvironmentId(null);
      return;
    }
    if (event.startsWith("environment:")) {
      const environment = environments.find(
        (candidate) => String(candidate.environmentId) === event.slice("environment:".length),
      );
      if (environment) setSelectedEnvironmentId(environment.environmentId);
      return;
    }
    if (event === "project:all") {
      setSelectedProjectKey(null);
      return;
    }
    if (event.startsWith("project:")) {
      const projectKey = event.slice("project:".length);
      if (projectFilterOptions.some((project) => project.key === projectKey)) {
        setSelectedProjectKey(projectKey);
      }
      return;
    }
  };

  const [measuredHeaderHeight, setMeasuredHeaderHeight] = useState<number | null>(null);
  const { height, paddingTop, paddingBottom } = useToolbarLayout();
  const stickyHeaderHeight =
    measuredHeaderHeight ??
    (Platform.OS === "android"
      ? paddingTop + height + paddingBottom
      : insets.top + SIDEBAR_STICKY_HEADER_HEIGHT);
  const topListInset = stickyHeaderHeight + 6;
  const handleStickyHeaderLayout = (event: LayoutChangeEvent) => {
    const nextHeight = event.nativeEvent.layout.height;
    setMeasuredHeaderHeight((current) => (current === nextHeight ? current : nextHeight));
  };
  const handleSwipeableWillOpen = (methods: SwipeableMethods) => {
    if (openSwipeableRef.current !== methods) {
      openSwipeableRef.current?.close();
      openSwipeableRef.current = methods;
    }
  };
  const handleSwipeableClose = (methods: SwipeableMethods) => {
    if (openSwipeableRef.current === methods) {
      openSwipeableRef.current = null;
    }
  };
  // Destructure callback props; capturing all props would invalidate these row-closing handlers on unrelated changes.
  const { onSelectThread, onOpenThreadPullRequests } = props;
  // A row listed for a message match opens the thread at that message, by
  // tap or by shortcut.
  const handleSelectThread = (thread: EnvironmentThreadShell) => {
    const key = threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id });
    const messageId = contentOnlyThreadKeys.has(key)
      ? threadSearchMatchByKey.get(key)?.messageId
      : undefined;
    if (messageId) {
      requestThreadMessageJump(scopedThreadKey(thread.environmentId, thread.id), messageId);
    }
    onSelectThread(thread);
    openSwipeableRef.current?.close();
  };
  const handleOpenThreadPullRequests = (
    thread: EnvironmentThreadShell,
    pr: ThreadPrPresentation,
  ) => {
    onOpenThreadPullRequests(thread, pr);
    openSwipeableRef.current?.close();
  };
  // Fork-then-open: select the child immediately; the detail pane shows its
  // loading state until the child's shell arrives over the socket.
  const handleForkThread = async (thread: EnvironmentThreadShell) => {
    const child = await forkThread(thread);
    if (child === null) {
      return;
    }
    openSwipeableRef.current?.close();
    onSelectThread({ environmentId: child.environmentId, id: child.threadId });
  };
  const handleScrollBeginDrag = () => {
    openSwipeableRef.current?.close();
  };
  const onFabScroll = useFabScroll();
  const { swipeEnabled, scrollGateHandlers } = useSwipeableScrollGate({
    onScroll: onFabScroll,
    onScrollBeginDrag: handleScrollBeginDrag,
  });
  // Recycle equality needs project/search data for titles and favicons; keep the minute clock on items to limit updates.
  const listExtraData = {
    queuedThreadKeys,
    hierarchyGuides,
    activeNewTask,
    selectedThreadKey: props.selectedThreadKey ?? "",
    projectByKey,
    projectTitleByProjectKey,
    savedConnectionsById,
    listEnvironments,
    threadSearchMatchByKey,
    workingShelfEnabled,
  };
  // Jump shortcuts walk the rendered thread rows in order; hierarchy headers
  // and collapsed groups contribute none.
  const shortcutItems = listItems.filter((item): item is SidebarListItem & ThreadListV2ListItem =>
    isThreadListV2ListItem(item),
  );
  useThreadJumpShortcuts(shortcutItems, handleSelectThread);
  const sidebarItemsAreEqual = (previous: SidebarListItem, item: SidebarListItem): boolean => {
    if (previous.depth !== item.depth) return false;
    if (isThreadListV2ListItem(previous) && isThreadListV2ListItem(item)) {
      if (previous.type === "v2-settled-shelf" && item.type === "v2-settled-shelf") {
        if (previous.groupKey !== item.groupKey) return false;
      }
      if (previous.settledBranch !== item.settledBranch) return false;
      return threadListV2ListItemsAreEqual(previous, item);
    }
    if (
      (previous.type === "header" || previous.type === "account-header") &&
      (item.type === "header" || item.type === "account-header")
    ) {
      return homeListItemsAreEqual(previous, item);
    }
    if (previous.type === "v2-show-more" && item.type === "v2-show-more") {
      return previous.hiddenCount === item.hiddenCount && previous.state === item.state;
    }
    if (isHomeSquireItem(previous) && isHomeSquireItem(item)) {
      return homeListItemsAreEqual(previous, item);
    }
    return false;
  };
  const focusSearch = () => {
    if (Platform.OS === "android") return false;
    const focus = () => {
      if (props.nativeChrome) {
        searchBarRef.current?.focus();
        return;
      }
      searchInputRef.current?.focus();
    };
    if (!props.visible) {
      props.onRequestVisibility();
      setTimeout(focus, 240);
    } else {
      focus();
    }
    return true;
  };
  useHardwareKeyboardCommand("focusSearch", focusSearch);
  const renderListRow = ({ item }: { readonly item: SidebarListItem }) => {
    if (isHomeSquireItem(item)) return <SquireHomeListRow item={item} pane={SIDEBAR_ROW_PANE} />;
    switch (item.type) {
      case "account-header":
        return (
          <AccountSectionHeader
            item={item}
            onToggle={() => updateGroupDisplay(item.key, "toggle-collapsed")}
          />
        );
      case "v2-pending": {
        const pendingScopeKey = scopedProjectKey(
          item.pendingTask.environmentId,
          item.pendingTask.projectId,
        );
        return (
          <ThreadListV2PendingRow
            pendingTask={item.pendingTask}
            selected={
              activeNewTask?.pendingKey === item.pendingTask.key ||
              (item.pendingTask.kind === "pending" &&
                scopedThreadKey(
                  item.pendingTask.environmentId,
                  item.pendingTask.message.threadId,
                ) === props.selectedThreadKey)
            }
            project={projectByKey.get(pendingScopeKey) ?? null}
            projectTitle={projectTitleByProjectKey.get(pendingScopeKey)}
            environmentLabel={
              Object.keys(savedConnectionsById).length > 1
                ? (savedConnectionsById[item.pendingTask.environmentId]?.environmentLabel ?? null)
                : null
            }
            environmentMachine={machineByEnvironmentId.get(item.pendingTask.environmentId)}
            pane="sidebar"
            showPendingDivider={item.showPendingDivider}
            onSelectPendingTask={props.onOpenPendingTask}
            onDeletePendingTask={confirmDeletePendingTask}
            fullSwipeWidth={props.width - 20}
            onSwipeableClose={handleSwipeableClose}
            onSwipeableWillOpen={handleSwipeableWillOpen}
            simultaneousSwipeGesture={sidebarScrollGesture}
          />
        );
      }
      case "v2-thread": {
        const thread = item.item.thread;
        const scopeKey = scopedProjectKey(thread.environmentId, thread.projectId);
        return (
          <ThreadListV2Row
            nested
            onNewThreadOnBranch={props.onNewThreadOnBranch}
            thread={thread}
            variant={item.item.variant}
            hasQueuedMessages={item.hasQueuedMessages}
            snoozed={item.item.snoozed}
            pinned={item.item.pinned}
            wokeAt={item.item.wokeAt}
            snoozePresetMinute={item.snoozePresetMinute ?? ""}
            snoozeWakeLabelText={item.snoozeWakeLabelText}
            timeLabel={item.timeLabel}
            project={projectByKey.get(scopeKey) ?? null}
            providerInstance={resolveProviderInstance(thread)}
            providers={providersByEnvironmentId.get(thread.environmentId)}
            environmentLabel={
              Object.keys(savedConnectionsById).length > 1
                ? (savedConnectionsById[thread.environmentId]?.environmentLabel ?? null)
                : null
            }
            environmentMachine={machineByEnvironmentId.get(thread.environmentId)}
            searchMatch={
              // Only rows listed for their messages show one and open at it.
              contentOnlyThreadKeys.has(
                threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
              )
                ? threadSearchMatchByKey.get(
                    threadSearchMatchKey({
                      environmentId: thread.environmentId,
                      threadId: thread.id,
                    }),
                  )
                : undefined
            }
            searchQuery={threadSearch.query}
            pane={SIDEBAR_ROW_PANE}
            selected={
              !activeNewTask &&
              scopedThreadKey(thread.environmentId, thread.id) === props.selectedThreadKey
            }
            fullSwipeWidth={props.width - 20}
            onSelectThread={handleSelectThread}
            onOpenThreadPullRequests={handleOpenThreadPullRequests}
            onDeleteThread={confirmDeleteThread}
            onArchiveThread={archiveThread}
            onForkThread={handleForkThread}
            forkSupported={forkingEnvironmentIds.has(thread.environmentId)}
            onRenameThread={renameThread}
            onRegenerateThreadTitle={regenerateThreadTitle}
            titleRegenerationSupported={titleRegenerationEnvironmentIds.has(thread.environmentId)}
            settlementSupported={settlementEnvironmentIds.has(thread.environmentId)}
            onSettleThread={settleThread}
            snoozeSupported={snoozeEnvironmentIds.has(thread.environmentId)}
            pinningSupported={pinningEnvironmentIds.has(thread.environmentId)}
            autoSettleOptOutSupported={autoSettleOptOutEnvironmentIds.has(thread.environmentId)}
            reorderSupported={
              item.item.pinned
                ? pinReorderEnvironmentIds.has(thread.environmentId)
                : !workingShelfEnabled && activeReorderEnvironmentIds.has(thread.environmentId)
            }
            canMoveUp={item.canMoveUp}
            canMoveDown={item.canMoveDown}
            onSnoozeThread={snoozeThread}
            onUnsnoozeThread={unsnoozeThread}
            onUnsettleThread={unsettleThread}
            onPinThread={pinThread}
            onUnpinThread={unpinThread}
            onSetThreadAutoSettle={setThreadAutoSettle}
            onMoveThread={handleMoveThread}
            onSwipeableClose={handleSwipeableClose}
            onSwipeableWillOpen={handleSwipeableWillOpen}
            simultaneousSwipeGesture={sidebarScrollGesture}
          />
        );
      }
      case "v2-working-shelf":
        return (
          <ThreadListV2WorkingShelfHeader
            count={item.count}
            disabled={item.disabled}
            expanded={item.expanded}
            onToggle={toggleWorkingShelf}
            pane="sidebar"
          />
        );
      case "v2-snoozed-shelf":
        return (
          <ThreadListV2SnoozedShelfHeader
            count={item.count}
            disabled={item.disabled}
            expanded={item.expanded}
            onToggle={toggleSnoozedShelf}
            pane={SIDEBAR_ROW_PANE}
          />
        );
      case "v2-settled-shelf":
        return (
          <ThreadListV2SettledShelfHeader
            count={item.count}
            disabled={item.disabled}
            expanded={item.expanded}
            onToggle={
              item.groupKey
                ? () => updateGroupDisplay(item.groupKey!, "toggle-collapsed")
                : toggleSettledShelf
            }
            pane={SIDEBAR_ROW_PANE}
          />
        );
      case "v2-show-more":
        return (
          <ThreadListV2ShowMoreRow
            pane={SIDEBAR_ROW_PANE}
            hiddenCount={item.hiddenCount}
            {...(item.state === undefined ? {} : { state: item.state })}
            onPress={() => olderSettledShelf.retry()}
          />
        );
      case "header":
        return (
          <ThreadListGroupHeader
            variant={SIDEBAR_HEADER_VARIANT}
            collapsed={item.collapsed}
            isFirst={item.isFirst}
            depth={0}
            memberStatus={item.memberStatus}
            groupKey={item.group.key}
            onGroupAction={updateGroupDisplay}
            // Same gating as the compact Home list: aggregated groups have no
            // single target project, and pending-project groups hold a
            // placeholder shell rather than a real project.
            newThreadTarget={item.group.newThreadTarget}
            onNewThread={props.onNewThreadInProject}
            project={item.group.representative}
            threadCount={item.group.threads.length + item.group.pendingTasks.length}
            title={item.group.title}
            firstThread={item.group.threads[0]}
            onSelectThread={handleSelectThread}
          />
        );
    }
  };
  const filterCustomized = options.selectedEnvironmentId !== null || selectedProjectKey !== null;
  const filterIcon = filterCustomized
    ? "line.3.horizontal.decrease.circle.fill"
    : "line.3.horizontal.decrease.circle";
  const filterMenu = buildHomeListFilterMenu({
    accountSections,
    accountAttention: attention,
    environments,
    projects: projectFilterOptions,
    selectedEnvironmentId: options.selectedEnvironmentId,
    selectedProjectKey,
    onEnvironmentChange: setSelectedEnvironmentId,
    onProjectChange: setSelectedProjectKey,
  });
  const nativeHeaderItems = createSidebarHeaderItems({
    filterIcon,
    filterMenu,
    onOpenSettings: props.onOpenSettings,
  });
  const accountRowColors = useAccountRowColors(listItems);
  const sectionFrames = accountSectionFrames(listItems);
  const renderListItem = (rowProps: { readonly item: SidebarListItem }) => (
    <AccountSurfaceColorContext.Provider value={accountRowColors.get(rowProps.item.key)}>
      <HierarchyRow
        depth={rowProps.item.depth ?? 0}
        settled={
          "settledBranch" in rowProps.item &&
          rowProps.item.type !== "v2-settled-shelf" &&
          Boolean(rowProps.item.settledBranch)
        }
        frame={sectionFrames.get(rowProps.item.key)}
        guides={hierarchyGuides.get(rowProps.item.key)}
      >
        {renderListRow(rowProps)}
      </HierarchyRow>
    </AccountSurfaceColorContext.Provider>
  );

  const listEmpty = (
    <Text
      className={
        Platform.OS === "android"
          ? "px-4 py-4 text-center text-sm text-drawer-foreground-muted"
          : "px-2 py-4 text-sm text-drawer-foreground-muted"
      }
    >
      {catalogState.isLoadingConnections
        ? "Loading threads…"
        : Platform.OS === "android" && !catalogState.hasConnections
          ? "No environments connected"
          : props.searchQuery.trim().length > 0
            ? threadSearch.isPending
              ? "Searching thread messages…"
              : "No matching threads"
            : selectedProjectScope !== null
              ? `No threads in ${selectedProjectScope.title}`
              : "No threads yet"}
    </Text>
  );

  if (props.nativeChrome) {
    return (
      <>
        <NativeStackScreenOptions
          optionsVersion={[nativeHeaderItems, props.width]}
          options={{
            ...getConnectionAwareBrandHeaderOptions({
              headerWidth: props.width,
              trailingItemCount: nativeHeaderItems.length,
              onOpenEnvironments: props.onOpenEnvironmentSettings,
              fallbackTitleStyle: { fontSize: 18, fontWeight: "800" },
            }),
            headerSearchBarOptions: {
              ref: searchBarRef,
              autoCapitalize: "none",
              hideNavigationBar: false,
              hideWhenScrolling: false,
              obscureBackground: false,
              placeholder: "Search",
              placement: "stacked",
              onCancelButtonPress: () => {
                props.onSearchQueryChange("");
              },
              onChangeText: (event) => {
                props.onSearchQueryChange(event.nativeEvent.text);
              },
            },
            unstable_headerRightItems: () => nativeHeaderItems,
          }}
        />
        <View className="flex-1">
          <ArcaneBackdrop emphasis="sidebar" />
          <SwipeableScrollGateProvider enabled={swipeEnabled}>
            <GestureDetector gesture={sidebarScrollGesture}>
              <AnimatedLegendList
                renderScrollComponent={Platform.OS === "ios" ? NativeScrollView : undefined}
                itemLayoutAnimation={HIERARCHY_LAYOUT_TRANSITION}
                viewabilityConfig={THREAD_ACTIVITY_VIEWABILITY_CONFIG}
                data={listItems}
                drawDistance={500}
                estimatedItemSize={80}
                extraData={listExtraData}
                getItemType={(item) => item.type}
                itemsAreEqual={sidebarItemsAreEqual}
                keyExtractor={(item) => item.key}
                renderItem={renderListItem}
                automaticallyAdjustsScrollIndicatorInsets={NATIVE_LIQUID_GLASS_SUPPORTED}
                contentInsetAdjustmentBehavior={
                  NATIVE_LIQUID_GLASS_SUPPORTED ? "automatic" : "never"
                }
                contentContainerStyle={[
                  styles.threadListContent,
                  Platform.OS === "android" ? { paddingHorizontal: 0 } : null,
                  {
                    paddingBottom: Math.max(insets.bottom, 16) + 16,
                    paddingTop: 6,
                  },
                ]}
                keyboardDismissMode="on-drag"
                keyboardShouldPersistTaps="handled"
                {...scrollGateHandlers}
                recycleItems
                scrollEventThrottle={16}
                showsVerticalScrollIndicator={false}
                style={styles.threadList}
                ListEmptyComponent={listEmpty}
              />
            </GestureDetector>
          </SwipeableScrollGateProvider>
          <ThreadUndoNotice visible={props.visible} />
        </View>
      </>
    );
  }

  // Android renders ThreadListToolbar (its own search field); the
  // glass layout keeps the account glass card around this field.
  const searchField = (
    <>
      <SymbolView
        name="magnifyingglass"
        size={15}
        tintColorClassName="accent-foreground-muted"
        type="monochrome"
      />
      <TextInput
        ref={searchInputRef}
        accessibilityLabel="Search threads"
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="while-editing"
        onChangeText={props.onSearchQueryChange}
        placeholder="Search"
        placeholderTextColorClassName="accent-placeholder"
        returnKeyType="search"
        className="h-[34px] flex-1 px-0 py-0 font-sans text-base text-foreground"
        value={props.searchQuery}
      />
    </>
  );

  return (
    <View
      testID="thread-navigation-sidebar"
      className={
        Platform.OS === "android" ? "flex-1 bg-header" : "flex-1 border-r border-border bg-drawer"
      }
      // Android fills its pane, which animates its width while a hinge resizes the split.
      style={Platform.OS === "android" ? undefined : { width: props.width }}
    >
      <ArcaneBackdrop emphasis="sidebar" />
      <View
        className="flex-1"
        style={
          Platform.OS === "android"
            ? {
                marginTop: stickyHeaderHeight,
                marginHorizontal: 4,
                paddingBottom: insets.bottom,
                backgroundColor: drawerColor,
                borderTopLeftRadius: 28,
                borderTopRightRadius: 28,
                overflow: "hidden",
              }
            : { paddingBottom: insets.bottom }
        }
      >
        {Platform.OS === "android" && listItems.length === 0 ? (
          <View className="flex-1 items-center justify-center">{listEmpty}</View>
        ) : (
          <SwipeableScrollGateProvider enabled={swipeEnabled}>
            <GestureDetector gesture={sidebarScrollGesture}>
              {/* oxlint-disable-next-line lecturn/require-registered-list-scroll -- Only the non-native workspace layout (Android and the fallback) renders this sidebar, which has no native header to register with. */}
              <AnimatedLegendList
                itemLayoutAnimation={HIERARCHY_LAYOUT_TRANSITION}
                viewabilityConfig={THREAD_ACTIVITY_VIEWABILITY_CONFIG}
                data={listItems}
                drawDistance={500}
                estimatedItemSize={80}
                extraData={listExtraData}
                getItemType={(item) => item.type}
                itemsAreEqual={sidebarItemsAreEqual}
                keyExtractor={(item) => item.key}
                renderItem={renderListItem}
                contentContainerStyle={[
                  styles.threadListContent,
                  Platform.OS === "android" ? { paddingHorizontal: 0 } : null,
                  {
                    paddingBottom:
                      Platform.OS === "android"
                        ? floatingTabsEnabled
                          ? FLOATING_TABS.bottom +
                            FLOATING_TABS.edge +
                            Math.max(floatingTabs.height, floatingTabs.fabOffset + fabSize)
                          : Math.max(insets.bottom, 16) + fabClearance - insets.bottom
                        : 16 + insets.bottom,
                    paddingTop: Platform.OS === "android" ? 6 : topListInset,
                  },
                ]}
                keyboardDismissMode="on-drag"
                keyboardShouldPersistTaps="handled"
                {...scrollGateHandlers}
                recycleItems
                scrollEventThrottle={16}
                showsVerticalScrollIndicator={false}
                style={styles.threadList}
                ListEmptyComponent={listEmpty}
              />
            </GestureDetector>
          </SwipeableScrollGateProvider>
        )}
      </View>

      {Platform.OS === "android" ? (
        <ThreadListToolbar
          sidebar
          onLayout={handleStickyHeaderLayout}
          searchQuery={props.searchQuery}
          onSearchQueryChange={props.onSearchQueryChange}
          filterActions={listMenuActions}
          filterCustomized={filterCustomized}
          onFilterAction={handleListMenuAction}
          onOpenEnvironments={props.onOpenEnvironmentSettings}
          onRequestVisibility={props.onRequestVisibility}
        />
      ) : (
        <View
          className="absolute inset-x-0 top-0 z-[4] border-border bg-drawer"
          collapsable={false}
          onLayout={handleStickyHeaderLayout}
          pointerEvents="auto"
          style={{
            paddingTop: insets.top,
            paddingBottom: 12,
            borderBottomWidth: StyleSheet.hairlineWidth,
          }}
        >
          <View className="h-[50px] flex-row items-end gap-0.5 pr-2 pl-5">
            <WorkspaceConnectionTitle
              grow
              onPress={props.onOpenEnvironmentSettings}
              size="pageTitle"
              brand={
                <View className="h-11 flex-1 justify-center">
                  <CompactBrandTitle allowFontScaling={false} />
                </View>
              }
            />
            <View className="flex-row items-center gap-2.5">
              <Menu actions={listMenuActions} onPressAction={handleListMenuAction}>
                <SidebarFilterButton accessibilityLabel="Filter threads" icon={filterIcon} />
              </Menu>
              <SidebarHeaderActions onOpenSettings={props.onOpenSettings} />
            </View>
          </View>

          <GlassCard
            radius={22}
            className="mx-4 mt-[9px] h-[42px] flex-row items-center gap-2 pr-3 pl-3"
          >
            {searchField}
          </GlassCard>
        </View>
      )}
      <ThreadUndoNotice visible={props.visible} />
    </View>
  );
}

const styles = StyleSheet.create({
  threadList: {
    flex: 1,
  },
  threadListContent: {
    paddingHorizontal: 8,
  },
});

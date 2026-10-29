import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { resolveScratchProjectScopeKey } from "@lecturn/client-runtime/state/project-grouping";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
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
import { computeScopedThreadMoveAvailability, type ThreadMoveDestination } from "./threadOrder";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@lecturn/client-runtime/state/shell";
import {
  threadSearchMatchKey,
  type EnvironmentThreadSearchMatch,
} from "@lecturn/client-runtime/state/thread-search";
import type { MenuAction } from "@react-native-menu/menu";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LayoutChangeEvent, TextInputInstance } from "react-native";
import { Platform, StyleSheet, TextInput, View } from "react-native";
import { GestureDetector, useNativeGesture } from "react-native-gesture-handler";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
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
import { usePendingThreadOrder } from "../../state/thread-order";
import { threadListEnvironmentsAtom } from "../../state/server";
import { usePendingNewTasks } from "../../state/use-pending-new-tasks";
import { useQueuedThreadKeys } from "../../state/use-thread-outbox";
import { useWorkspaceState } from "../../state/workspace";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { useThreadJumpShortcuts } from "../keyboard/threadKeyboardShortcuts";
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
  buildThreadListV2Items,
  getThreadListV2OrderedSection,
  buildThreadListV2ListItems,
  isThreadListV2ListItem,
  threadListV2ListItemsAreEqual,
  threadListInboxReturns,
  THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  THREAD_LIST_V2_SETTLED_PAGE_COUNT,
  type ThreadListV2ListItem,
} from "./threadListV2";

type SidebarListItem = (
  | HomeHierarchyV2Item
  | { readonly type: "v2-show-more"; readonly key: string; readonly hiddenCount: number }
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
  if (Platform.OS !== "ios") {
    return <ThreadNavigationSidebarPane {...props} nativeChrome={false} />;
  }
  return <NativeSidebarContainer {...props} />;
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
  const { themeVariables: materialTheme } = useAppearancePreferences();
  const drawerColor = materialTheme["--color-drawer"];

  const insets = useSafeAreaInsets();
  const { fabClearance } = useAndroidControlSizing();
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
  const queuedThreadKeys = useQueuedThreadKeys();
  const { openPendingTask, confirmDeletePendingTask } = usePendingTaskListActions();
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
  const threadSearch = useThreadSearch(searchEnvironmentIds, props.searchQuery);
  // These maps reach LegendList's extraData, which re-renders every row whenever it changes
  // identity. The compiler leaves them unmemoized because they stay live across later hook calls.
  const threadSearchMatchByKey = useMemo(() => {
    const matches = new Map<string, EnvironmentThreadSearchMatch>();
    for (const match of threadSearch.matches) {
      if (match.source === "user" || match.source === "assistant") {
        matches.set(threadSearchMatchKey(match), match);
      }
    }
    return matches;
  }, [threadSearch.matches]);
  const matchedThreadKeys = new Set(threadSearch.matches.map(threadSearchMatchKey));
  const projectScopeKey = options.selectedProjectKey;
  const resolvedProjectKey = resolveScratchProjectScopeKey(projectScopeKey, projects, {
    sidebarProjectGroupingMode: options.projectGroupingMode,
    sidebarProjectGroupingOverrides: {},
  });
  useEffect(() => {
    if (resolvedProjectKey !== projectScopeKey) {
      setSelectedProjectKey(resolvedProjectKey);
    }
  }, [projectScopeKey, resolvedProjectKey, setSelectedProjectKey]);
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

  const [settledVisibleCount, setSettledVisibleCount] = useState(
    THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  );
  const settledResetKey = `${options.selectedEnvironmentId ?? "all"}:${selectedProjectKey ?? "all"}:${props.searchQuery.trim()}`;
  const [lastSettledResetKey, setLastSettledResetKey] = useState(settledResetKey);
  if (lastSettledResetKey !== settledResetKey) {
    setLastSettledResetKey(settledResetKey);
    setSettledVisibleCount(THREAD_LIST_V2_SETTLED_INITIAL_COUNT);
  }
  const showMoreSettled = () =>
    setSettledVisibleCount((count) => count + THREAD_LIST_V2_SETTLED_PAGE_COUNT);
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
  // The list's clock is state: the compiler caches anything computed from it on
  // its other inputs, so a render-time `new Date()` would stop moving. The minute
  // interval and the snooze-wake timer below both advance it.
  const [now, setNow] = useState(() => new Date().toISOString());
  const nowMinute = now.slice(0, 16);
  // The wake timestamp, so section membership and move planning refresh at the
  // same boundary, before the next minute tick.
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(() => Date.now());
  useEffect(() => {
    setNow(new Date().toISOString());
    const id = setInterval(() => setNow(new Date().toISOString()), 60_000);
    return () => clearInterval(id);
  }, []);
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
  const pendingOrder = usePendingThreadOrder(nowMinute, snoozeWakeTick, moveScopes);
  const handleMoveThread = (thread: EnvironmentThreadShell, direction: ThreadMoveDestination) => {
    const scope = moveScopes.get(scopedProjectKey(thread.environmentId, thread.projectId));
    if (scope) void moveThread(thread, direction, scope);
  };
  const resolveProviderInstance = useThreadRowProviderInstanceResolver(providersByEnvironmentId);
  // Up/down menu availability for every card, computed once per owning
  // project group per section (see computeScopedThreadMoveAvailability):
  // per-thread planner calls made list construction quadratic, and this list
  // rebuilds on every minute tick.
  const threadMoveAvailability = (() => {
    const sectionAvailability = (section: "pinned" | "active") =>
      computeScopedThreadMoveAvailability({
        scopes: moveScopes,
        allThreads: allThreadShells,
        section,
        pendingOrder,
        reorderableEnvironmentIds:
          section === "pinned" ? pinReorderEnvironmentIds : activeReorderEnvironmentIds,
        ordered: getThreadListV2OrderedSection({
          threads,
          section,
          pendingOrder,
          now,
          settlementEnvironmentIds,
          snoozeEnvironmentIds,
          queuedThreadKeys,
        }),
      });
    return new Map([
      ...sectionAvailability("pinned"),
      ...(workingShelfEnabled ? [] : sectionAvailability("active")),
    ]);
  })();
  const threadListV2Layout = (() => {
    threadListInboxReturns.observe(workingShelfEnabled ? threads : null);
    return buildThreadListV2Items({
      pendingOrder,
      threads: threads.filter((thread) => thread.archivedAt === null),
      environmentId: options.selectedEnvironmentId,
      projectRefs: selectedProjectScope === null ? null : selectedProjectScope.projectRefs,
      searchQuery: props.searchQuery,
      matchedThreadKeys,
      settlementEnvironmentIds,
      snoozeEnvironmentIds,
      queuedThreadKeys,
      settledLimit: Number.POSITIVE_INFINITY,
      now,
      workingShelfEnabled,
      workingShelfExpanded,
      inboxReturnAt: threadListInboxReturns.returnedAt,
      snoozedShelfExpanded,
      settledShelfExpanded: true,
      selectedThreadKey: props.selectedThreadKey ?? null,
    });
  })();
  const nextSnoozeWakeAt = threadListV2Layout.nextSnoozeWakeAt;
  useEffect(() => {
    if (nextSnoozeWakeAt === null) return;
    const wakeAtMs = Date.parse(nextSnoozeWakeAt);
    if (Number.isNaN(wakeAtMs)) return;
    const delayMs = Math.min(Math.max(0, wakeAtMs - Date.now()) + 50, 2_147_483_647);
    const id = setTimeout(() => {
      setNow(new Date().toISOString());
      bumpSnoozeWakeTick(Date.now());
    }, delayMs);
    return () => clearTimeout(id);
    // snoozeWakeTick must re-arm the timer even when nextSnoozeWakeAt is
    // unchanged: after a clamped fire (wake beyond the 32-bit setTimeout
    // range) the boundary string is identical and the chain would die.
  }, [nextSnoozeWakeAt, snoozeWakeTick]);
  const listItems = ((): readonly SidebarListItem[] => {
    const v2SearchQuery = props.searchQuery.trim().toLocaleLowerCase();
    const v2PendingTasks = pendingTasks.filter(
      (pendingTask) =>
        (options.selectedEnvironmentId === null ||
          pendingTask.environmentId === options.selectedEnvironmentId) &&
        (selectedProjectRefs === null ||
          selectedProjectRefs.has(
            scopedProjectKey(pendingTask.environmentId, pendingTask.projectId),
          )) &&
        (v2SearchQuery.length === 0 ||
          pendingTask.title.toLocaleLowerCase().includes(v2SearchQuery)),
    );
    const flatItems = buildThreadListV2ListItems({
      items: threadListV2Layout.items,
      pendingTasks: v2PendingTasks,
      workingCount: threadListV2Layout.workingCount,
      workingShelfExpanded,
      workingShelfHeaderIndex: threadListV2Layout.workingShelfHeaderIndex,
      snoozedCount: threadListV2Layout.snoozedCount,
      snoozedShelfExpanded,
      snoozedShelfHeaderIndex: threadListV2Layout.snoozedShelfHeaderIndex,
      settledCount: threadListV2Layout.settledCount,
      settledShelfExpanded: true,
      settledShelfHeaderIndex: threadListV2Layout.settledShelfHeaderIndex,
      snoozeLabelNow: `${nowMinute}:00.000Z`,
      snoozeEnvironmentIds,
      queuedThreadKeys,
      moveAvailability: threadMoveAvailability,
      shelfPreferencesLoading: !shelfPreferencesLoaded,
    });
    const items: SidebarListItem[] = buildHomeHierarchyV2Items({
      accountSections,
      groups,
      items: flatItems,
      sagaIndex,
      displayStates: accountDisplayStates,
      searching: hasSearchQuery,
      selectedThreadKey: props.selectedThreadKey,
    });
    if (settledShelfExpanded && threadListV2Layout.hiddenSettledCount > 0) {
      items.push({
        type: "v2-show-more",
        key: "v2-show-more",
        hiddenCount: threadListV2Layout.hiddenSettledCount,
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
  // The sticky header (title row, search field, optional connection status)
  // is measured so the list inset always matches its real height — no
  // hardcoded per-variant constants.
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
  // These close the open row too, so they cannot be pass-throughs. The compiler would
  // recache a closure over `props` whenever any prop changed.
  const { onSelectThread, onOpenThreadPullRequests } = props;
  const handleSelectThread = (thread: EnvironmentThreadShell) => {
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
  // The sticky header's project shells and search maps feed row props, so
  // they have to bust the recycler's memoization — otherwise a row keeps the
  // blank favicon and fallback title it was first rendered with. The minute
  // clock deliberately stays out: its per-row text lives on the items, so a
  // tick only re-renders rows whose displayed text actually moved.
  const listExtraData = {
    queuedThreadKeys,
    hierarchyGuides,
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
      return previous.hiddenCount === item.hiddenCount;
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
            onSelectPendingTask={openPendingTask}
            onDeletePendingTask={confirmDeletePendingTask}
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
            snoozePresetMinute={item.snoozePresetMinute ?? ""}
            snoozeWakeLabelText={item.snoozeWakeLabelText}
            timeLabel={item.timeLabel}
            project={projectByKey.get(scopeKey) ?? null}
            projectTitle={projectTitleByProjectKey.get(scopeKey)}
            providerInstance={resolveProviderInstance(thread)}
            providers={providersByEnvironmentId.get(thread.environmentId)}
            environmentLabel={
              Object.keys(savedConnectionsById).length > 1
                ? (savedConnectionsById[thread.environmentId]?.environmentLabel ?? null)
                : null
            }
            environmentMachine={machineByEnvironmentId.get(thread.environmentId)}
            searchMatch={threadSearchMatchByKey.get(
              threadSearchMatchKey({
                environmentId: thread.environmentId,
                threadId: thread.id,
              }),
            )}
            searchQuery={props.searchQuery}
            pane={SIDEBAR_ROW_PANE}
            selected={scopedThreadKey(thread.environmentId, thread.id) === props.selectedThreadKey}
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
            onPress={showMoreSettled}
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
                        ? Math.max(insets.bottom, 16) + fabClearance - insets.bottom
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
          onOpenSettings={props.onOpenSettings}
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

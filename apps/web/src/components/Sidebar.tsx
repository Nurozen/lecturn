import {
  SidebarDragScope,
  ScopedSortableThreadRow,
  SidebarDragBoundary,
  SidebarMotionList,
} from "./sidebar/SidebarDragScope";
import { useSidebarAccountStyle } from "./sidebar/useSidebarAccountStyle";
import { StaveIcon } from "./StaveIcon";
import { projectSettledPage } from "./sidebarSettledGroups";
import { StaveLifecycleBadge } from "./stave/StaveLifecycleBadge";
import { StaveConfirmDialog } from "./stave/StaveConfirmDialog";
import {
  readStaveSpaceLifecycleMenuEntry,
  useStaveArchiveLanding,
  type StaveSpaceConfirmation,
} from "./stave/staveSpaceLifecycle";
import type { EnvironmentServerConfig } from "@lecturn/client-runtime/connection";
import { ThreadContextDragGhost } from "./chat/ThreadContextDragGhost";
import { discardComposerDraft } from "../lib/discardComposerDraft";
import { SidebarPointerSensor } from "./Sidebar.pointer";
import { requestCustomSnooze } from "./CustomSnoozeDialog";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import {
  canSnooze,
  effectiveSnoozed,
  threadWokeAt,
} from "@lecturn/client-runtime/state/thread-settled";
import { createInboxReturnTracker } from "@lecturn/client-runtime/state/thread-inbox";
import { sortSettledThreads } from "@lecturn/client-runtime/state/thread-sort";
import {
  nextShownOrder,
  threadSearchMatchKey,
  threadSearchSubject,
  type ShownOrder,
} from "@lecturn/client-runtime/state/thread-search";
import type { ThreadListingCapabilitiesByEnvironment } from "@lecturn/client-runtime/state/thread-shell";
import { foldSearchQuery, rankMessageMatches } from "@lecturn/shared/paletteSearch";
import { findForMessageMatch, requestThreadFindQuery } from "./chat/threadFindActionBus";
import {
  threadRuntimeCanArchive,
  type EnvironmentThreadShell,
} from "@lecturn/client-runtime/state/models";
import {
  parseScopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@lecturn/client-runtime/environment";
import {
  type ContextMenuItem,
  type EnvironmentId,
  AuthOrchestrationOperateScope,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ThreadId,
} from "@lecturn/contracts";
import { ChevronDownIcon, CircleCheckIcon, FolderIcon, PlusIcon, SettingsIcon } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useRouter } from "@tanstack/react-router";

import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@lecturn/client-runtime/state/runtime";
import { isElectron } from "../env";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHintsForModifiers,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { useShortcutModifierState } from "../shortcutModifierState";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { isMacPlatform } from "~/lib/utils";
import { readLocalApi } from "../localApi";
import { useSidebarPendingFileDropStore } from "../sidebarPendingFileDropStore";
import { getProjectOrderKey, selectProjectGroupingSettings } from "../logicalProject";
import {
  buildSidebarProjectSnapshots,
  projectGroupsSpanEnvironments,
  resolveSidebarProjectScopeKey,
  getSidebarProjectSettingsKey,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import {
  getThreadKeysToDeselectAfterDelete,
  useThreadSelectionStore,
} from "../threadSelectionStore";
import { useAcknowledgeThreadWoke, useThreadActions } from "../hooks/useThreadActions";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useTerminalFocus } from "../hooks/useTerminalFocus";
import { isCommandPaletteOpen, openCommandPalette } from "../commandPaletteBus";
import { registerSettleAndAdvance } from "../settleAndAdvance";
import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { useClientSettings } from "../hooks/useSettings";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useNowMinute } from "../hooks/useNowMinute";
import {
  useEnvironmentIdentities,
  useConnectedEnvironmentIds,
  useEnvironmentMachines,
  usePrimaryEnvironmentId,
} from "../state/environments";
import {
  readEnvironmentSupportsForking,
  useAllEnvironmentProjectSnapshotsReady,
  readThreadShell,
  useServerConfigs,
  useThreadListingCapabilities,
  useQuietThreadShells,
} from "../state/entities";
import { readForkAtLatestTurn, useForkThread } from "../hooks/useForkThread";
import { environmentPresentations } from "../state/presentation";
import { primaryServerKeybindingsAtom } from "../state/server";
import { environmentProjects } from "../state/projects";
import { threadEnvironment } from "../state/threads";
import { useThreadSearch } from "../state/queries";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { readEnvironmentScope } from "../state/session";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { canShareWithGuestAtom, isGuestShareableThread } from "./chat/guestShareAvailability";
import { openGuestShareDialog } from "./chat/guestShareDialogState";
import { buildThreadRouteParams, resolveActiveThreadRouteRef } from "../threadRoutes";
import type { SidebarThreadSummary } from "../types";
import { isScratchProject } from "@lecturn/client-runtime/state/projects";
import { cn } from "~/lib/utils";
import { ProjectEnvironmentBadge } from "./ProjectEnvironmentBadge";
import {
  buildDraftActionMenuItems,
  buildThreadActionMenuItems,
  threadActionRequiresOperate,
} from "./threadActionMenu.logic";
import {
  type SidebarSection,
  filterSidebarV2VisibleThreads,
  buildBulkTitleRegenerationContextMenuItem,
  buildBulkUnpinContextMenuItem,
  deleteSelectedThreadEntries,
  filterSidebarProjectScopeItems,
  firstValidTimestampMs,
  isSidebarNestedLinkClick,
  isSidebarThreadWorking,
  isTrailingDoubleClick,
  orderItemsByPreferredIds,
  reduceSidebarProjectScopeMenuState,
  resolveAdjacentThreadId,
  resolveSidebarSweepKeys,
  resolveSidebarThreadSection,
  searchSidebarThreads,
  shouldCreateNewThreadInCurrentProject,
  shouldNavigateAfterThreadPark,
  sidebarThreadKeyAtY,
  sortInboxThreadsByReturn,
  sortPinnedThreadsForSidebar,
  sortSidebarV2ProjectGroups,
  sortThreadsForSidebar,
  sortWorkingThreadsBySend,
  useThreadJumpHintVisibility,
  resolveSidebarRowThreadId,
} from "./Sidebar.logic";
import { resolveSnoozePresets, snoozeWakeLabel, type SnoozePreset } from "./Sidebar.snooze";
import { ProjectFavicon } from "./ProjectFavicon";
import { deriveProviderEntriesByEnvironment } from "../providerInstances";
import { useStableCallback } from "../hooks/useStableCallback";
import {
  completeSidebarRouteReveal,
  pendingSidebarRouteReveal,
  type SidebarRouteReveal,
} from "./sidebar/routeReveal";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Button } from "./ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxSearchInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
  useComboboxFilter,
} from "./ui/combobox";
import { useSagaSidebarTree } from "./stave/useSagaSidebarTree";
import {
  partitionThreadsByProjectKeys,
  withoutArchivedStaveProjectThreads,
} from "./stave/listedProjects.logic";
import { useListedProjects } from "./stave/useListedProjects";
import { useAppsNewThreadTarget } from "./apps/useAppsSidebarShortcuts";
import { AppsModeSwitch } from "./apps/AppsModeSwitch";
import { AppsSidebar } from "./apps/AppsSidebar";
import { SquiresSidebarGroup } from "./squire/sidebar/SquiresSidebarGroup";
import {
  readSquireContainerTrackMenu,
  readSquireSelectionTrackMenu,
  readSquireThreadTrackMenu,
  squireContainerTarget,
  type SquireContainerTrackMenu,
} from "./squire/track/readSquireTrack";
import { buildSquireTrackMenuItems } from "./squire/track/squireTrack.logic";
import { useSquireTrack } from "./squire/track/useSquireTrack";
import { sagaSidebarThreadOrder } from "./stave/staveSaga.logic";
import { SidebarContent, SidebarGroup, useSidebar } from "./ui/sidebar";
import { snapshotsPerAccount, useSidebarSegmentation } from "./sidebar/accountProjectGroups";
import { SidebarSegments } from "./sidebar/SidebarSegments";
import { flattenSegmentsForNavigation, nameGroupsByAccount } from "./sidebar/sidebarSegments.logic";
import { useSidebarSegments } from "./sidebar/useSidebarSegments";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { SidebarHierarchyPanel } from "./sidebar/SidebarHierarchyPanel";
import { partitionShelfRows } from "./sidebar/sidebarShelfRows";
import { SidebarScopeTrigger } from "./sidebar/SidebarScopeRow";
import { SidebarThreadHeader } from "./sidebar/SidebarThreadHeader";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { composerDraftHasUserContent, DraftId, useComposerDraftStore } from "../composerDraftStore";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import {
  SidebarSearchResultRow,
  SidebarThreadRow,
  type SidebarProviderEntry,
  type SidebarSweepAction,
} from "./sidebar/SidebarThreadRow";
import { SidebarDraftBlock } from "./sidebar/SidebarDraftBlock";

function sameSidebarProviderEntries(
  left: ReadonlyMap<string, SidebarProviderEntry>,
  right: ReadonlyMap<string, SidebarProviderEntry>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [instanceId, entry] of right) {
    const other = left.get(instanceId);
    if (
      other === undefined ||
      other.driverKind !== entry.driverKind ||
      other.enabled !== entry.enabled ||
      other.displayName !== entry.displayName ||
      other.accentColor !== entry.accentColor ||
      other.acpRegistryAgentId !== entry.acpRegistryAgentId ||
      other.acpRegistryIconUrl !== entry.acpRegistryIconUrl ||
      other.models !== entry.models
    ) {
      return false;
    }
  }
  return true;
}

// Threads on non-primary environments (Lecturn Connect, hosted) resolve their
// provider entry from their own environment's config: default instance ids
// are driver slugs, so a flat map would collide across environments.
const sidebarProviderEntriesAtom = Atom.make((get) => {
  const providersByEnvironment = get(environmentPresentations.providersByEnvironmentAtom);
  const derived = deriveProviderEntriesByEnvironment(
    [...get(environmentPresentations.serverConfigsAtom)].map(
      ([environmentId, config]) =>
        [environmentId, providersByEnvironment.get(environmentId) ?? [], config.settings] as const,
    ),
  );
  const previous = Option.getOrNull(
    get.self<ReadonlyMap<string, ReadonlyMap<string, SidebarProviderEntry>>>(),
  );
  const next = new Map<string, ReadonlyMap<string, SidebarProviderEntry>>();
  let changed = previous === null || previous.size !== derived.size;
  for (const [environmentId, entries] of derived) {
    const prior = previous?.get(environmentId);
    if (prior !== undefined && sameSidebarProviderEntries(prior, entries)) {
      next.set(environmentId, prior);
    } else {
      next.set(environmentId, entries);
      changed = true;
    }
  }
  return !changed && previous !== null ? previous : next;
}).pipe(Atom.withLabel("sidebar-provider-entries"));

const EMPTY_PROVIDER_ENTRIES: ReadonlyMap<string, SidebarProviderEntry> = new Map();

// Collapsed shelves share one empty list so a route change alone does not
// give the sidebar list a new identity.
const EMPTY_THREADS: readonly EnvironmentThreadShell[] = [];

const SETTLED_TAIL_INITIAL_COUNT = 10;

const SETTLED_TAIL_PAGE_COUNT = 25;

const SETTLED_SHELF_EXPANDED_KEY = "lecturn:sidebar:settled-expanded";

const SNOOZED_SHELF_EXPANDED_KEY = "lecturn:sidebar:snoozed-expanded";

const WORKING_SHELF_EXPANDED_KEY = "lecturn:sidebar:working-expanded";

const inboxReturns = createInboxReturnTracker();

/** Working beta: the inbox order, newest return first. */
function sortInboxForSidebar<T extends EnvironmentThreadShell>(threads: readonly T[]): T[] {
  return sortInboxThreadsByReturn(threads, inboxReturns.returnedAt);
}

function canOperateThreads(
  threads: ReadonlyArray<Pick<SidebarThreadSummary, "environmentId">>,
): boolean {
  return threads.every((thread) =>
    readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope),
  );
}

function checkThreadOperations(
  threads: ReadonlyArray<Pick<SidebarThreadSummary, "environmentId">>,
): boolean {
  if (canOperateThreads(threads)) return true;
  toastManager.add({
    type: "error",
    title: "Thread action unavailable",
    description: "This connection cannot change one or more selected threads.",
  });
  return false;
}

// Pointer travel before a press on a row's action button starts a sweep, the
// same distance a row drag needs. Shorter presses stay clicks.
const SIDEBAR_DRAG_DISTANCE = 6;

function scheduleSnoozeWake(wakeAt: string | null, onWake: () => void): (() => void) | undefined {
  const wakeAtMs = wakeAt === null ? Number.NaN : Date.parse(wakeAt);
  if (Number.isNaN(wakeAtMs)) return undefined;
  // setTimeout delays are signed 32-bit: anything larger overflows and fires
  // immediately, turning a far-future wake (event-condition snoozes synced
  // from elsewhere) into a tight re-arm loop.
  const delayMs = Math.min(Math.max(0, wakeAtMs - Date.now()) + 50, 2_147_483_647);
  const id = window.setTimeout(onWake, delayMs);
  return () => window.clearTimeout(id);
}

// Snooze wakes depend on the clock, so the minute tick and the precise wake
// tick arrive as `clockKey`: a new key repartitions under the React Compiler.
function partitionForkSidebarThreads(input: {
  readonly threads: readonly EnvironmentThreadShell[];
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly archivedProjectKeys: ReadonlySet<string>;
  readonly appProjectKeys: ReadonlySet<string>;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, EnvironmentServerConfig>;
  readonly listing: ThreadListingCapabilitiesByEnvironment;
  readonly workingShelfEnabled: boolean;
  readonly clockKey: string;
}) {
  const { threads, scopedProjectKeys, archivedProjectKeys, appProjectKeys } = input;
  const { serverConfigs, workingShelfEnabled } = input;
  const preciseNow = new Date().toISOString();
  // Archived Stave spaces keep their threads out of the live list.
  // App threads leave the Projects-mode list but stay findable through search.
  const { outside: visible, inside: appSearchThreads } = partitionThreadsByProjectKeys(
    withoutArchivedStaveProjectThreads(
      filterSidebarV2VisibleThreads(threads, scopedProjectKeys, input.listing),
      archivedProjectKeys,
    ),
    appProjectKeys,
  );
  inboxReturns.observe(workingShelfEnabled ? threads : null);
  const pinned: EnvironmentThreadShell[] = [];
  const active: EnvironmentThreadShell[] = [];
  const working: EnvironmentThreadShell[] = [];
  const inbox = (thread: EnvironmentThreadShell) =>
    workingShelfEnabled && isSidebarThreadWorking(thread) ? working : active;
  const snoozed: EnvironmentThreadShell[] = [];
  const settled: EnvironmentThreadShell[] = [];
  for (const thread of visible) {
    const supportsSettlement =
      serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSettlement === true;
    const supportsSnooze =
      serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSnooze === true;
    // Snooze outranks settlement and pinning until the thread wakes.
    const section = resolveSidebarThreadSection({
      snoozed: supportsSnooze && effectiveSnoozed(thread, { now: preciseNow }),
      settled: supportsSettlement && thread.settledOverride === "settled",
      pinned: thread.pinnedAt != null,
    });
    (section === "snoozed"
      ? snoozed
      : section === "settled"
        ? settled
        : section === "pinned"
          ? pinned
          : inbox(thread)
    ).push(thread);
  }
  // Server capability only gates DRAGGING — it must not influence the
  // sort, or mixed-version fleets would render different pinned orders on
  // web and mobile from the same data.
  return {
    pinnedThreads: sortPinnedThreadsForSidebar(pinned),
    activeThreads: workingShelfEnabled
      ? sortInboxForSidebar(active)
      : sortThreadsForSidebar(active),
    workingThreads: sortWorkingThreadsBySend(working),
    snoozedThreads: snoozed.toSorted(
      (left, right) =>
        firstValidTimestampMs(left.snoozedUntil ?? null) -
        firstValidTimestampMs(right.snoozedUntil ?? null),
    ),
    settledThreads: sortSettledThreads(settled),
    appSearchThreads: sortThreadsForSidebar(appSearchThreads),
    snoozeNow: preciseNow,
  };
}

export default function Sidebar({ routeReveal }: { routeReveal: SidebarRouteReveal }) {
  const sidebarAccountStyle = useSidebarAccountStyle();
  // Archived Stave spaces (and their threads) leave the sidebar; they come
  // back through New project → Stave.
  const { projects, archivedProjectKeys, appProjectKeys } = useListedProjects();
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const sidebarMode = useUiStateStore((store) => store.sidebarMode);
  const appsNewThreadTarget = useAppsNewThreadTarget((state) => state.target);
  // Rows read their own live shell; the list holds still while a thread streams.
  const threads = useQuietThreadShells();
  const threadListing = useThreadListingCapabilities();
  const reservedThreadOrderKeys = {
    pinned: new Map(
      threads.map((thread) => [
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        thread.pinOrderKey ?? null,
      ]),
    ),
    active: new Map(
      threads.map((thread) => [
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        thread.activeOrderKey ?? null,
      ]),
    ),
  };
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
  const confirmThreadArchive = useClientSettings((s) => s.confirmThreadArchive);
  const sidebarProjectSortOrder = useClientSettings((s) => s.sidebarProjectSortOrder);
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const workingShelfEnabled = useClientSettings((s) => s.sidebarWorkingShelfEnabled);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const threadActions = useThreadActions();
  const {
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    confirmAndUnpinThread,
    setThreadAutoSettle,
    markThreadUnread,
    archiveThread,
    deleteThread,
  } = threadActions;
  const { forkThreadAtLatestTurn } = useForkThread();
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) => {
      toastManager.add({
        type: "success",
        title: "Path copied",
        description: path,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const { copyToClipboard: copyBranchToClipboard } = useCopyToClipboard<{ branch: string }>({
    target: "branch name",
    onCopy: ({ branch }) => {
      toastManager.add({
        type: "success",
        title: "Branch copied",
        description: branch,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy branch",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{ threadId: ThreadId }>({
    onCopy: ({ threadId }) => {
      toastManager.add({
        type: "success",
        title: "Thread ID copied",
        description: threadId,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy thread ID",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const newThreadContext = useHandleNewThread();
  const openAddProjectCommandPalette = () => openCommandPalette({ open: "add-project" });
  const environments = useEnvironmentIdentities();
  const serverConfigs = useServerConfigs();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const acknowledgeWoke = useAcknowledgeThreadWoke();
  const routeTarget = useThreadRouteTarget();
  const routeDraftThread = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const routeThreadRef = resolveActiveThreadRouteRef(routeTarget, routeDraftThread);
  const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;
  // An open subagent highlights the ancestor row that stands in for it.
  const routeRowThreadKey =
    routeThreadRef === null
      ? null
      : scopedThreadKey(
          scopeThreadRef(
            routeThreadRef.environmentId,
            resolveSidebarRowThreadId(
              routeThreadRef.threadId,
              routeThreadRef.environmentId,
              threads,
            ),
          ),
        );
  const routeTargetRef = useRef(routeTarget);
  const routeThreadKeyRef = useRef(routeThreadKey);

  const environmentLabelById = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const environmentMachineById = useEnvironmentMachines();
  const orderedProjects = orderItemsByPreferredIds({
    items: projects,
    preferredIds: projectOrder,
    getId: getProjectOrderKey,
    getPreferenceIds: (project) => [
      getProjectOrderKey(project),
      legacyProjectCwdPreferenceKey(project.workspaceRoot),
    ],
  });
  const sidebarSegmentation = useSidebarSegmentation();
  const unsortedProjectGroups = snapshotsPerAccount(
    sidebarSegmentation,
    buildSidebarProjectSnapshots,
  )({
    projects: sidebarProjectSortOrder === "manual" ? orderedProjects : projects,
    groupScratchProjects: true,
    settings: projectGroupingSettings,
    primaryEnvironmentId,
    resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
  });
  const projectGroups = sortSidebarV2ProjectGroups(
    unsortedProjectGroups,
    threads,
    sidebarProjectSortOrder,
    threadListing,
  );
  const {
    tree: sagaTree,
    navigationProjects,
    nest: nestSagaProjects,
  } = useSagaSidebarTree(projectGroups);
  const [collapsedProjectKeys, setCollapsedProjectKeys] = useState<ReadonlySet<string>>(new Set());
  const navigationProjectByKey = new Map(
    navigationProjects.map((project) => [project.projectKey, project]),
  );
  const toggleProject = (key: string) =>
    setCollapsedProjectKeys((old) => {
      const next = new Set(old);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const projectGroupsRef = useRef(projectGroups);
  const providerEntriesByEnvironment = useAtomValue(sidebarProviderEntriesAtom);
  const projectByKey = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project]),
  );
  const projectDisplayNameByKey = new Map(
    projectGroups.flatMap((group) =>
      group.memberProjects.map(
        (project) => [`${project.environmentId}:${project.id}`, group.displayName] as const,
      ),
    ),
  );

  const nowMinute = useNowMinute();
  // Snooze wake times are second-precise, so classifying with the quantized
  // minute would hold a woken thread on the shelf for up to a minute.
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);

  const persistedProjectScopeKey = useUiStateStore((store) => store.sidebarProjectScopeKey);
  const setPersistedProjectScopeKey = useUiStateStore((store) => store.setSidebarProjectScopeKey);
  // A selection made under one scope can hold threads the next scope hides.
  const setProjectScopeKey = (key: string | null) => {
    clearSelection();
    setPersistedProjectScopeKey(key);
  };
  const projectScopeKey = resolveSidebarProjectScopeKey({
    groups: projectGroups,
    key: persistedProjectScopeKey,
    settings: projectGroupingSettings,
  });
  const projectScopeItems = [
    { value: "all", label: "All projects" },
    ...nameGroupsByAccount(sidebarSegmentation, projectGroups).map((project) => ({
      value: project.projectKey,
      label: project.displayName,
    })),
  ];
  const showProjectEnvironments = projectGroupsSpanEnvironments(projectGroups);
  const scratchMachineLabelFor = (
    thread: Pick<SidebarThreadSummary, "environmentId" | "projectId">,
  ) => {
    if (!showProjectEnvironments) return null;
    const project = projectByKey.get(`${thread.environmentId}:${thread.projectId}`);
    if (
      !project ||
      !isScratchProject(project, serverConfigs.get(thread.environmentId)?.scratchWorkspaceRoot)
    ) {
      return null;
    }
    return environmentLabelById.get(thread.environmentId) ?? null;
  };
  const projectGroupByScopeKey = new Map(
    projectGroups.map((project) => [project.projectKey, project] as const),
  );
  const selectedProjectScopeItem =
    projectScopeItems.find((item) => item.value === (projectScopeKey ?? "all")) ??
    projectScopeItems[0]!;
  const [projectScopeMenuState, dispatchProjectScopeMenu] = useReducer(
    reduceSidebarProjectScopeMenuState,
    { open: false, query: "" },
  );
  const projectScopeFilter = useComboboxFilter();
  const filteredProjectScopeItems = filterSidebarProjectScopeItems({
    items: projectScopeItems,
    query: projectScopeMenuState.query,
    matches: (item, query) =>
      projectScopeFilter.contains(item, query, (candidate) => candidate.label),
  });
  const scopedProjectGroup =
    projectScopeKey === null
      ? null
      : (projectGroups.find((project) => project.projectKey === projectScopeKey) ?? null);
  const scopedProjectKeys =
    scopedProjectGroup === null
      ? null
      : new Set(
          scopedProjectGroup.memberProjectRefs.map(
            (projectRef) => `${projectRef.environmentId}:${projectRef.projectId}`,
          ),
        );
  const allProjectSnapshotsReady = useAllEnvironmentProjectSnapshotsReady();
  const allProjectConfigsReady = useAtomValue(environmentProjects.projectConfigsReadyAtom);
  useEffect(() => {
    const nextKey = resolveSidebarProjectScopeKey({
      groups: projectGroups,
      key: persistedProjectScopeKey,
      settings: projectGroupingSettings,
      canClearMissingScope: allProjectSnapshotsReady && allProjectConfigsReady,
    });
    if (nextKey !== persistedProjectScopeKey) {
      clearSelection();
      setPersistedProjectScopeKey(nextKey);
    }
  }, [
    allProjectConfigsReady,
    allProjectSnapshotsReady,
    clearSelection,
    persistedProjectScopeKey,
    projectGroups,
    projectGroupingSettings,
    setPersistedProjectScopeKey,
  ]);
  const routeDraftIdForRows = routeTarget?.kind === "draft" ? routeTarget.draftId : null;
  const visibleDraftSessionCount = useComposerDraftStore((store) => {
    let count = 0;
    for (const [draftKey, session] of Object.entries(store.draftThreadsByThreadKey)) {
      if (session.promotedTo != null) {
        continue;
      }
      if (!composerDraftHasUserContent(store.draftsByThreadKey[draftKey])) {
        continue;
      }
      if (
        scopedProjectKeys !== null &&
        !scopedProjectKeys.has(`${session.environmentId}:${session.projectId}`)
      ) {
        continue;
      }
      count += 1;
    }
    return count;
  });

  const openProjectSettings = useStableCallback(
    (projectGroup: SidebarProjectSnapshot, projectRef?: ScopedProjectRef) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      void router.navigate({
        to: "/projects/$projectKey",
        params: {
          projectKey:
            projectGroup.settingsProjectKey ??
            getSidebarProjectSettingsKey(
              projectGroup,
              projectGroupingSettings,
              projects,
              projectRef,
            ),
        },
      });
    },
  );
  // Safari can send a click after Ctrl+click opens settings. Ignore that one
  // selection, then clear the guard when the picker opens again.
  const suppressNextScopeChangeRef = useRef(false);
  const highlightedProjectScopeKeyRef = useRef<string | null>(null);
  const handleProjectSettings = useStableCallback(
    (
      event: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLInputElement>,
      projectGroup: SidebarProjectSnapshot,
    ) => {
      event.preventDefault();
      event.stopPropagation();
      suppressNextScopeChangeRef.current = true;
      dispatchProjectScopeMenu({ type: "project-settings-opened" });
      openProjectSettings(projectGroup);
    },
  );

  // Settled threads stay in the live shell stream (settled ≠ archived), so
  // the partition works directly off live shells: no archived-snapshot
  // merging. Drag holds belong to the rendered account/project list. Archived threads remain hidden here —
  // archive keeps its original "remove from sidebar" meaning.
  const {
    pinnedThreads,
    activeThreads,
    workingThreads,
    snoozedThreads,
    settledThreads,
    appSearchThreads,
    snoozeNow,
  } = partitionForkSidebarThreads({
    threads,
    scopedProjectKeys,
    archivedProjectKeys,
    appProjectKeys,
    serverConfigs,
    listing: threadListing,
    workingShelfEnabled,
    clockKey: `${nowMinute}:${snoozeWakeTick}`,
  });

  const threadSearchInputRef = useRef<HTMLInputElement>(null);
  const [threadSearchQuery, setThreadSearchQuery] = useState("");
  const [searchHighlightKey, setSearchHighlightKey] = useState<string | null>(null);
  const isSearchingThreads = threadSearchQuery.trim().length > 0;
  const searchableThreads = [
    ...pinnedThreads,
    ...activeThreads,
    ...workingThreads,
    ...snoozedThreads,
    ...settledThreads,
    ...appSearchThreads,
  ];
  const searchEnvironmentIds = useConnectedEnvironmentIds();
  const threadSearch = useThreadSearch(searchEnvironmentIds, threadSearchQuery);

  // History, the command palette, and links can open a thread the project
  // scope hides or the list has scrolled away. A remount starts the list at
  // the top, so each mount also scrolls to the open thread once, without
  // widening the scope.
  const mountRevealOwed = useRef(true);
  const revealRouteRow = useStableCallback(() => {
    const pendingKey = pendingSidebarRouteReveal(routeReveal, routeRowThreadKey);
    // Search results replace the thread list; reveal once the list returns.
    if (isSearchingThreads) return;
    const revealKey = pendingKey ?? (mountRevealOwed.current ? routeRowThreadKey : null);
    if (revealKey === null) return;
    const thread = threads.find(
      (candidate) =>
        scopedThreadKey(scopeThreadRef(candidate.environmentId, candidate.id)) === revealKey,
    );
    if (thread === undefined) return;
    if (
      pendingKey !== null &&
      scopedProjectKeys !== null &&
      filterSidebarV2VisibleThreads([thread], scopedProjectKeys, threadListing).length === 0 &&
      filterSidebarV2VisibleThreads([thread], null, threadListing).length === 1 &&
      // App threads and archived Stave spaces stay off this list in every scope.
      !appProjectKeys.has(`${thread.environmentId}:${thread.projectId}`) &&
      !archivedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`)
    ) {
      // The row renders under the widened scope; scroll on that pass.
      setProjectScopeKey(null);
      return;
    }
    const activeRow = document.querySelector('[data-sidebar="content"] [aria-current="page"]');
    if (!activeRow) return;
    completeSidebarRouteReveal(routeReveal);
    mountRevealOwed.current = false;
    activeRow.scrollIntoView({ block: "nearest" });
  });
  useEffect(revealRouteRow, [
    revealRouteRow,
    routeRowThreadKey,
    threads,
    projectScopeKey,
    isSearchingThreads,
  ]);

  // Ranked across environments as the palette ranks them, so one
  // environment's list does not sit above another's better matches; rows
  // already shown keep their places while slower environments answer.
  const threadByMatchKey =
    threadSearch.matches.length === 0
      ? null
      : new Map(
          searchableThreads.map((thread) => [
            threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
            thread,
          ]),
        );
  const rankedServerMatches =
    threadByMatchKey === null
      ? []
      : rankMessageMatches(
          threadSearch.matches,
          (match) => {
            const thread = threadByMatchKey.get(threadSearchMatchKey(match));
            return thread ? threadSearchSubject(thread, null) : undefined;
          },
          foldSearchQuery(threadSearchQuery),
          Date.now(),
          // A list filter, as on mobile: a pick would move rows unexplained.
          { picks: false },
        );
  const serverMatchByKey = new Map(
    rankedServerMatches.map((match) => [threadSearchMatchKey(match), match] as const),
  );
  const [shownMessageOrder, setShownMessageOrder] = useState<ShownOrder | null>(null);
  const messageOrder = nextShownOrder(
    shownMessageOrder,
    threadSearch.query,
    [...serverMatchByKey.keys()],
    Number.POSITIVE_INFINITY,
  );
  if (messageOrder !== shownMessageOrder) setShownMessageOrder(messageOrder);
  const { titleMatches: threadTitleResults, contentMatches: threadContentResults } =
    searchSidebarThreads(searchableThreads, threadSearchQuery, new Set(messageOrder.keys));
  const threadSearchResults = [...threadTitleResults, ...threadContentResults];
  // Only rows listed for their messages show one, and open find on it.
  const threadSearchMatchByKey = new Map(
    threadContentResults.flatMap((thread) => {
      const key = threadSearchMatchKey({
        environmentId: thread.environmentId,
        threadId: thread.id,
      });
      const match = serverMatchByKey.get(key);
      return match ? [[key, match] as const] : [];
    }),
  );
  const threadSearchResultKeys = threadSearchResults.map((thread) =>
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
  );

  // The highlight follows its thread, so rows that arrive late do not move
  // it under Enter; a new query starts at the top.
  const activeSearchResultIndex = Math.max(
    0,
    searchHighlightKey === null ? 0 : threadSearchResultKeys.indexOf(searchHighlightKey),
  );
  const setActiveSearchResultIndex = (index: number | ((index: number) => number)) =>
    setSearchHighlightKey(
      threadSearchResultKeys[
        typeof index === "function" ? index(activeSearchResultIndex) : index
      ] ?? null,
    );
  const threadSearchResultOrderKey = threadSearchResultKeys.join("\0");

  // Keyed on the result list too, so a new list scrolls its highlighted (top)
  // result back into view even when that row is unchanged.
  useEffect(() => {
    if (!isSearchingThreads) return;
    const activeKey = threadSearchResultOrderKey.split("\0")[activeSearchResultIndex];
    if (!activeKey) return;
    document
      .querySelector(`[data-search-result-key="${globalThis.CSS.escape(activeKey)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeSearchResultIndex, isSearchingThreads, threadSearchResultOrderKey]);

  const nextSnoozeWakeAt = snoozedThreads[0]?.snoozedUntil ?? null;
  useEffect(
    () => scheduleSnoozeWake(nextSnoozeWakeAt, () => bumpSnoozeWakeTick((tick) => tick + 1)),
    [nextSnoozeWakeAt],
  );

  const [settledTail, setSettledTail] = useState({
    scopeKey: projectScopeKey,
    count: SETTLED_TAIL_INITIAL_COUNT,
  });
  if (settledTail.scopeKey !== projectScopeKey) {
    setSettledTail({ scopeKey: projectScopeKey, count: SETTLED_TAIL_INITIAL_COUNT });
  }
  const settledVisibleCount =
    settledTail.scopeKey === projectScopeKey ? settledTail.count : SETTLED_TAIL_INITIAL_COUNT;
  const setSettledVisibleCount = (update: (count: number) => number) =>
    setSettledTail((current) => ({ scopeKey: current.scopeKey, count: update(current.count) }));
  const visibleSettledThreads = (() => {
    if (settledThreads.length <= settledVisibleCount) return settledThreads;
    const visible = settledThreads.slice(0, settledVisibleCount);
    if (routeRowThreadKey !== null) {
      const routeThread = settledThreads
        .slice(settledVisibleCount)
        .find(
          (thread) =>
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeRowThreadKey,
        );
      if (routeThread !== undefined) visible.push(routeThread);
    }
    return visible;
  })();
  const hiddenSettledCount = settledThreads.length - visibleSettledThreads.length;
  const showMoreSettled = () => setSettledVisibleCount((count) => count + SETTLED_TAIL_PAGE_COUNT);
  const [settledShelfExpanded, setSettledShelfExpanded] = useLocalStorage(
    SETTLED_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const toggleSettledShelf = () => setSettledShelfExpanded((value) => !value);
  const renderedSettledThreads = (() => {
    if (settledShelfExpanded) return visibleSettledThreads;
    if (routeRowThreadKey === null) return EMPTY_THREADS;
    const routeThread = visibleSettledThreads.find(
      (thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeRowThreadKey,
    );
    return routeThread === undefined ? EMPTY_THREADS : [routeThread];
  })();

  const [snoozedShelfExpanded, setSnoozedShelfExpanded] = useLocalStorage(
    SNOOZED_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const toggleSnoozedShelf = () => setSnoozedShelfExpanded((value) => !value);
  const visibleSnoozedThreads = (() => {
    if (snoozedShelfExpanded) return snoozedThreads;
    if (routeRowThreadKey === null) return EMPTY_THREADS;
    const routeThread = snoozedThreads.find(
      (thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeRowThreadKey,
    );
    return routeThread === undefined ? EMPTY_THREADS : [routeThread];
  })();

  const [workingShelfExpanded, setWorkingShelfExpanded] = useLocalStorage(
    WORKING_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const toggleWorkingShelf = () => setWorkingShelfExpanded((value) => !value);
  const visibleWorkingThreads = (() => {
    if (workingShelfExpanded) return workingThreads;
    if (routeRowThreadKey === null) return EMPTY_THREADS;
    const routeThread = workingThreads.find(
      (thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeRowThreadKey,
    );
    return routeThread === undefined ? EMPTY_THREADS : [routeThread];
  })();

  const scopedSagaTree = (() => {
    if (!scopedProjectKeys) return sagaTree;
    const matches = (node: (typeof sagaTree)[number]) =>
      node.group.memberProjectRefs.some((ref) =>
        scopedProjectKeys.has(`${ref.environmentId}:${ref.projectId}`),
      );
    return sagaTree.flatMap((node) => {
      const children = node.children.filter(matches);
      return matches(node) || children.length ? [{ ...node, children }] : [];
    });
  })();
  const [projectSettledShelves, setProjectSettledShelves] = useState<
    Readonly<Record<string, { expanded: boolean; limit: number }>>
  >({});
  const settledByProject = (() => {
    const entries = new Map<
      string,
      ReturnType<typeof projectSettledPage<EnvironmentThreadShell>>
    >();
    for (const node of scopedSagaTree.flatMap((root) => [root, ...root.children])) {
      const rows = settledThreads.filter((thread) =>
        node.group.memberProjectRefs.some(
          (ref) => ref.environmentId === thread.environmentId && ref.projectId === thread.projectId,
        ),
      );
      entries.set(
        node.group.key,
        projectSettledPage(
          rows,
          projectSettledShelves[node.group.key],
          routeRowThreadKey,
          SETTLED_TAIL_INITIAL_COUNT,
        ),
      );
    }
    return entries;
  })();
  const nestedSettledThreads = [...settledByProject.values()].flatMap((page) => page.visible);
  const sidebarSegments = useSidebarSegments({
    segmentation: sidebarSegmentation,
    projects,
    pinnedThreads,
    activeThreads,
    workingThreads,
    visibleWorkingThreads,
    snoozedThreads,
    visibleSnoozedThreads,
    settledThreads,
    renderedSettledThreads,
    nestedSettledThreads,
    scopedSagaTree,
    scopedProjectKeys,
    nestSagaProjects,
    collapsedProjectKeys,
    settledVisibleCount,
    settledPageCount: SETTLED_TAIL_PAGE_COUNT,
    workingShelfExpanded,
    snoozedShelfExpanded,
    settledShelfExpanded,
    toggleWorkingShelf,
    toggleSnoozedShelf,
    toggleSettledShelf,
    showMoreSettled,
    routeThreadKey: routeRowThreadKey,
  });
  const orderedThreads = (() => {
    if (sidebarSegments.segments !== null) {
      return flattenSegmentsForNavigation(sidebarSegments.segments);
    }
    const rows = [
      ...pinnedThreads,
      ...activeThreads,
      ...visibleWorkingThreads,
      ...visibleSnoozedThreads,
      ...(nestSagaProjects ? nestedSettledThreads : renderedSettledThreads),
    ];
    if (!nestSagaProjects) return rows;
    return sagaSidebarThreadOrder(scopedSagaTree, collapsedProjectKeys, rows);
  })();
  const orderedThreadKeys = orderedThreads.map((thread) =>
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
  );
  const orderedThreadKeysRef = useRef(orderedThreadKeys);
  const threadByKey = new Map(
    orderedThreads.map(
      (thread) =>
        [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
    ),
  );
  // Handlers read these through refs: depending on per-update Map/Set
  // identities would give every row a fresh callback prop on each shell
  // event and defeat row memoization during streaming.
  const threadByKeyRef = useRef(threadByKey);
  const handleNewThreadRef = useRef(newThreadContext.handleNewThread);
  const settledThreadKeys = new Set(
    settledThreads.map((thread) =>
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
    ),
  );
  const settledThreadKeysRef = useRef(settledThreadKeys);
  const snoozedThreadKeys = new Set(
    snoozedThreads.map((thread) =>
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
    ),
  );
  const snoozedThreadKeysRef = useRef(snoozedThreadKeys);

  const jumpLabelByKey = (() => {
    const mapping = new Map<string, string>();
    for (const [index, threadKey] of orderedThreadKeys.entries()) {
      const jumpCommand = threadJumpCommandForIndex(index);
      if (!jumpCommand) break;
      const label = shortcutLabelForCommand(keybindings, jumpCommand);
      if (label) mapping.set(threadKey, label);
    }
    return mapping;
  })();
  const { showThreadJumpHints: showJumpHints, updateThreadJumpHintsVisibility } =
    useThreadJumpHintVisibility();

  const navigateToThread = (threadRef: ScopedThreadRef) => {
    if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0) {
      clearSelection();
    }
    setSelectionAnchor(scopedThreadKey(threadRef));
    if (isMobile) {
      setOpenMobile(false);
    }
    return router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
    });
  };

  const queuePendingFileDrop = useSidebarPendingFileDropStore((s) => s.queuePendingFileDrop);
  const clearPendingFileDrop = useSidebarPendingFileDropStore((s) => s.clearPendingFileDrop);
  const handleThreadFileDrop = async (threadRef: ScopedThreadRef, files: File[]) => {
    const dropId = queuePendingFileDrop({ threadRef, files });
    const landedBefore =
      router.buildLocation({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      }).pathname === router.state.location.pathname;
    if (landedBefore) return;

    try {
      await navigateToThread(threadRef);
      const landed =
        router.buildLocation({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        }).pathname === router.state.location.pathname;
      if (!landed) clearPendingFileDrop(dropId);
    } catch {
      clearPendingFileDrop(dropId);
    }
  };

  const navigateToDraft = (draftId: DraftId) => {
    clearSelection();
    if (isMobile) {
      setOpenMobile(false);
    }
    void router.navigate({ to: "/draft/$draftId", params: { draftId } });
  };

  const clearThreadSearch = () => {
    setThreadSearchQuery("");
    setSearchHighlightKey(null);
  };
  const selectThreadSearchResult = (thread: EnvironmentThreadShell) => {
    const ref = scopeThreadRef(thread.environmentId, thread.id);
    // A row listed for a message match opens find on it, as the palette does.
    const match = threadSearchMatchByKey.get(
      threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
    );
    const query = threadSearch.query;
    clearThreadSearch();
    navigateToThread(ref);
    if (match) requestThreadFindQuery(scopedThreadKey(ref), findForMessageMatch(match, query));
  };
  const handleThreadSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape" && isSearchingThreads) {
      event.preventDefault();
      event.stopPropagation();
      clearThreadSearch();
      return;
    }
    if (threadSearchResults.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveSearchResultIndex((index) => (index + 1) % threadSearchResults.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveSearchResultIndex(
        (index) => (index - 1 + threadSearchResults.length) % threadSearchResults.length,
      );
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const result = threadSearchResults[activeSearchResultIndex];
      if (result) selectThreadSearchResult(result);
    }
  };

  const [renamingThreadKey, setRenamingThreadKey] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const startThreadRename = (threadRef: ScopedThreadRef, title: string) => {
    if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) return;
    setRenamingThreadKey(scopedThreadKey(threadRef));
    setRenamingTitle(title);
  };
  const cancelThreadRename = () => setRenamingThreadKey(null);
  const commitThreadRename = (threadRef: ScopedThreadRef, title: string, originalTitle: string) => {
    void (async () => {
      if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) return;
      const trimmed = title.trim();
      setRenamingThreadKey(null);
      if (trimmed.length === 0) {
        toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
        return;
      }
      if (trimmed === originalTitle) return;
      const result = await updateThreadMetadata({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, title: trimmed },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to rename thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };

  const handleThreadClick = (event: ReactMouseEvent, threadRef: ScopedThreadRef) => {
    if (isSidebarNestedLinkClick(event.target)) return;
    const isMac = isMacPlatform(navigator.platform);
    const isModClick = isMac ? event.metaKey : event.ctrlKey;
    const threadKey = scopedThreadKey(threadRef);
    if (isModClick) {
      event.preventDefault();
      toggleThreadSelection(threadKey);
      return;
    }
    if (event.shiftKey) {
      event.preventDefault();
      rangeSelectTo(threadKey, orderedThreadKeysRef.current);
      return;
    }
    if (isTrailingDoubleClick(event.detail)) {
      return;
    }
    navigateToThread(threadRef);
  };

  const settlingThreadKeysRef = useRef(new Set<string>());
  // Callers snapshot the plan BEFORE the command mutates the partition;
  // background parks never navigate (null plan).
  const planForwardNavigation = (
    threadKey: string,
    coParkingKeys?: ReadonlySet<string>,
  ): (() => void) | null => {
    if (routeThreadKeyRef.current !== threadKey) return null;
    const shell = threadByKeyRef.current.get(threadKey);
    const orderedKeys = orderedThreadKeysRef.current;
    const settledKeys = settledThreadKeysRef.current;
    const snoozedKeys = snoozedThreadKeysRef.current;
    const currentIndex = orderedKeys.indexOf(threadKey);
    const nextCardKey =
      currentIndex === -1
        ? null
        : ([...orderedKeys.slice(currentIndex + 1), ...orderedKeys.slice(0, currentIndex)].find(
            (key) => !settledKeys.has(key) && !snoozedKeys.has(key) && !coParkingKeys?.has(key),
          ) ?? null);
    const nextThread = nextCardKey ? threadByKeyRef.current.get(nextCardKey) : null;
    return nextThread
      ? () => navigateToThread(scopeThreadRef(nextThread.environmentId, nextThread.id))
      : shell
        ? () =>
            void handleNewThreadRef.current(scopeProjectRef(shell.environmentId, shell.projectId))
        : () => void router.navigate({ to: "/" });
  };

  const settleFromDrag = async (threadRef: ScopedThreadRef) => {
    const key = scopedThreadKey(threadRef);
    if (settlingThreadKeysRef.current.has(key)) return null;
    settlingThreadKeysRef.current.add(key);
    const navigate = planForwardNavigation(key);
    const settle = async () => {
      const result = await settleThread(threadRef);
      if (
        result._tag === "Success" &&
        shouldNavigateAfterThreadPark({
          threadKey: key,
          currentThreadKey: routeThreadKeyRef.current,
          action: "settle",
          now: new Date().toISOString(),
          thread: readThreadShell(threadRef),
        })
      )
        navigate?.();
      return result;
    };
    return await settle().finally(() => {
      settlingThreadKeysRef.current.delete(key);
    });
  };
  const attemptSettle = (
    threadRef: ScopedThreadRef,
    opts: { coSettlingKeys?: ReadonlySet<string> } = {},
  ) => {
    void (async () => {
      const threadKey = scopedThreadKey(threadRef);
      if (settlingThreadKeysRef.current.has(threadKey)) return;
      settlingThreadKeysRef.current.add(threadKey);
      const settleAndAdvance = async () => {
        const navigateAfterSettle = planForwardNavigation(threadKey, opts.coSettlingKeys);
        const result = await settleThread(threadRef);
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to settle thread",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return;
        }
        if (
          shouldNavigateAfterThreadPark({
            threadKey,
            currentThreadKey: routeThreadKeyRef.current,
            action: "settle",
            now: new Date().toISOString(),
            thread: readThreadShell(threadRef),
          })
        ) {
          navigateAfterSettle?.();
        }
      };
      return await settleAndAdvance().finally(() => {
        settlingThreadKeysRef.current.delete(threadKey);
      });
    })();
  };
  useEffect(() => registerSettleAndAdvance(attemptSettle), [attemptSettle]);
  const settleThreads = (threadKeys: readonly string[]) => {
    const coSettlingKeys = new Set(threadKeys);
    for (const threadKey of threadKeys) {
      const thread = threadByKeyRef.current.get(threadKey);
      if (!thread || thread.settledOverride === "settled") continue;
      attemptSettle(scopeThreadRef(thread.environmentId, thread.id), { coSettlingKeys });
    }
  };
  const attemptUnsettle = (threadRef: ScopedThreadRef) => {
    void (async () => {
      const result = await unsettleThread(threadRef);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to un-settle thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };
  const attemptUnsnooze = (threadRef: ScopedThreadRef) => {
    void (async () => {
      const result = await unsnoozeThread(threadRef);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to wake thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };
  const orderedPinnedThreads = pinnedThreads;
  const sectionByThreadKey = (() => {
    const map = new Map<string, SidebarSection>();
    const add = (list: readonly EnvironmentThreadShell[], section: SidebarSection) => {
      for (const thread of list) {
        map.set(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), section);
      }
    };
    add(pinnedThreads, "pinned");
    add(activeThreads, "active");
    add(workingThreads, "working");
    add(snoozedThreads, "snoozed");
    add(settledThreads, "settled");
    return map;
  })();
  const sectionByThreadKeyRef = useRef(sectionByThreadKey);
  // Handlers read the latest values through these refs; they update after commit.
  useLayoutEffect(() => {
    routeTargetRef.current = routeTarget;
    routeThreadKeyRef.current = routeThreadKey;
    projectGroupsRef.current = projectGroups;
    orderedThreadKeysRef.current = orderedThreadKeys;
    threadByKeyRef.current = threadByKey;
    handleNewThreadRef.current = newThreadContext.handleNewThread;
    settledThreadKeysRef.current = settledThreadKeys;
    snoozedThreadKeysRef.current = snoozedThreadKeys;
    sectionByThreadKeyRef.current = sectionByThreadKey;
  });
  const sweepSensorRef = useRef<SidebarPointerSensor | null>(null);
  useEffect(() => () => sweepSensorRef.current?.cancel(), []);
  const [actionSweep, setActionSweep] = useState<{
    action: SidebarSweepAction;
    keys: ReadonlySet<string>;
  } | null>(null);
  const startActionSweep = useStableCallback(
    (threadRef: ScopedThreadRef, action: SidebarSweepAction, event: PointerEvent) => {
      const originKey = scopedThreadKey(threadRef);
      const originSection = sectionByThreadKeyRef.current.get(originKey);
      // Every thread row, across sections and account segments, sits in the
      // sidebar's scroll viewport in display order.
      const list =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')
          : null;
      const canApply = (key: string) => {
        const thread = threadByKeyRef.current.get(key);
        const capabilities =
          thread && serverConfigs.get(thread.environmentId)?.environment.capabilities;
        return (
          thread !== undefined &&
          sectionByThreadKeyRef.current.get(key) === originSection &&
          (action === "unsnooze"
            ? capabilities?.threadSnooze === true
            : capabilities?.threadSettlement === true)
        );
      };
      let targetKey: string | null = null;
      let sweptKeys: string[] = [];
      const sweepTo = (key: string | null) => {
        if (key === null || key === targetKey) return;
        targetKey = key;
        sweptKeys = resolveSidebarSweepKeys(orderedThreadKeysRef.current, originKey, key, canApply);
        setActionSweep({ action, keys: new Set(sweptKeys) });
      };
      sweepSensorRef.current?.cancel();
      sweepSensorRef.current = new SidebarPointerSensor({
        active: originKey,
        event,
        options: {
          distance: SIDEBAR_DRAG_DISTANCE,
          onAttach: () => {},
          onFinish: () => {
            sweepSensorRef.current = null;
            setActionSweep(null);
          },
        },
        onPending: () => {},
        onStart: () => sweepTo(originKey),
        onMove: ({ y }) => sweepTo(list && sidebarThreadKeyAtY(list, y)),
        onEnd: () => {
          const keys = sweptKeys.filter(canApply);
          if (action === "settle") {
            settleThreads(keys);
            return;
          }
          for (const key of keys) {
            const ref = parseScopedThreadKey(key);
            if (ref === null) continue;
            if (action === "unsettle") attemptUnsettle(ref);
            else attemptUnsnooze(ref);
          }
        },
        onCancel: () => {},
        onAbort: () => {},
      });
    },
  );
  const attemptPin = (threadRef: ScopedThreadRef) => {
    void (async () => {
      // Fresh pins take the top of the arranged run: pinThread computes a
      // key before the smallest key across ALL pinned shells — including
      // snoozed pins hidden from this list, whose keys are still part of
      // the run — so the new pin can't land beneath a hidden head.
      const result = await pinThread(threadRef);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to pin thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };
  const attemptUnpin = (threadRef: ScopedThreadRef) => {
    void (async () => {
      const result = await confirmAndUnpinThread(threadRef);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to unpin thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    })();
  };

  const snoozingThreadKeysRef = useRef(new Set<string>());
  const performSnooze = async (
    threadRef: ScopedThreadRef,
    preset: Pick<SnoozePreset, "snoozedUntil">,
    opts: { coSnoozingKeys?: ReadonlySet<string> } = {},
  ) => {
    const threadKey = scopedThreadKey(threadRef);
    if (snoozingThreadKeysRef.current.has(threadKey)) {
      return { status: "skipped" } as const;
    }
    snoozingThreadKeysRef.current.add(threadKey);
    const snooze = async () => {
      const navigateAfterSnooze = planForwardNavigation(threadKey, opts.coSnoozingKeys);
      const result = await snoozeThread(threadRef, preset.snoozedUntil);
      if (result._tag === "Failure") {
        return isAtomCommandInterrupted(result)
          ? ({ status: "interrupted" } as const)
          : ({ status: "failure", error: squashAtomCommandFailure(result) } as const);
      }
      if (
        shouldNavigateAfterThreadPark({
          threadKey,
          currentThreadKey: routeThreadKeyRef.current,
          action: "snooze",
          now: new Date().toISOString(),
          thread: readThreadShell(threadRef),
        })
      ) {
        navigateAfterSnooze?.();
      }
      return { status: "success" } as const;
    };
    return await snooze().finally(() => {
      snoozingThreadKeysRef.current.delete(threadKey);
    });
  };
  const attemptSnooze = (
    threadRef: ScopedThreadRef,
    preset: Pick<SnoozePreset, "snoozedUntil">,
    opts: { coSnoozingKeys?: ReadonlySet<string> } = {},
  ) => {
    void (async () => {
      const outcome = await performSnooze(threadRef, preset, opts);
      if (outcome.status === "failure") {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to snooze thread",
            description:
              outcome.error instanceof Error ? outcome.error.message : "An error occurred.",
          }),
        );
        return;
      }
    })();
  };

  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
  const squireTrack = useSquireTrack();
  const handleMultiSelectContextMenu = useStableCallback(
    async (position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const selectedThreadKeys = [...useThreadSelectionStore.getState().selectedThreadKeys];
      const threadKeys = selectedThreadKeys.filter((threadKey) =>
        threadByKeyRef.current.has(threadKey),
      );
      if (threadKeys.length === 0) return;
      const count = threadKeys.length;
      const selectionNow = new Date();
      const selectedThreads = threadKeys.flatMap((threadKey) => {
        const thread = threadByKeyRef.current.get(threadKey);
        return thread ? [thread] : [];
      });
      const settlingThreads = selectedThreads.filter(
        (thread) => thread.settledOverride !== "settled",
      );
      const canSnoozeSelection = selectedThreads.every(
        (thread) =>
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSnooze === true &&
          canSnooze(thread, { now: selectionNow.toISOString() }),
      );
      const titleRegenerationThreads = selectedThreads.filter(
        (thread) =>
          serverConfigs.get(thread.environmentId)?.environment.capabilities
            .threadTitleRegeneration === true,
      );
      const regeneratableTitleThreads = titleRegenerationThreads.filter(
        (thread) => thread.titleRegeneration == null,
      );
      const titleRegenerationMenuItem = buildBulkTitleRegenerationContextMenuItem({
        supportedCount: titleRegenerationThreads.length,
        actionableCount: regeneratableTitleThreads.length,
      });
      const pinnedSelectedThreads = selectedThreads.filter(
        (thread) =>
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadPinning ===
            true && thread.pinnedAt != null,
      );
      const unpinMenuItem = buildBulkUnpinContextMenuItem({
        pinnedCount: pinnedSelectedThreads.length,
      });
      const snoozePresets = resolveSnoozePresets(new Date(), timestampFormat);
      const squireTrackMenu = readSquireSelectionTrackMenu(selectedThreads);
      const clicked = await settlePromise(() =>
        api.contextMenu.show(
          [
            ...(unpinMenuItem
              ? [{ ...unpinMenuItem, disabled: !canOperateThreads(pinnedSelectedThreads) }]
              : []),
            {
              id: "settle",
              label: `Settle (${count})`,
              disabled: settlingThreads.length === 0 || !canOperateThreads(settlingThreads),
            },
            ...(canSnoozeSelection
              ? [
                  {
                    id: "snooze",
                    label: `Snooze (${count})`,
                    disabled: !canOperateThreads(selectedThreads),
                    children: [
                      ...snoozePresets.map((preset) => ({
                        id: `snooze:${preset.id}`,
                        label: `${preset.label} (${preset.whenLabel})`,
                        disabled: !canOperateThreads(selectedThreads),
                      })),
                      {
                        id: "snooze:custom",
                        label: "Custom…",
                        separatorBefore: true,
                        disabled: !canOperateThreads(selectedThreads),
                      },
                    ],
                  },
                ]
              : []),
            ...(titleRegenerationMenuItem
              ? [
                  {
                    ...titleRegenerationMenuItem,
                    disabled:
                      titleRegenerationMenuItem.disabled ||
                      !canOperateThreads(regeneratableTitleThreads),
                  },
                ]
              : []),
            ...(squireTrackMenu ? buildSquireTrackMenuItems(squireTrackMenu.state) : []),
            { id: "mark-unread", label: `Mark unread (${count})` },
            {
              id: "delete",
              label: `Delete (${count})`,
              destructive: true,
              disabled: !canOperateThreads(selectedThreads),
            },
          ],
          position,
        ),
      );
      if (clicked._tag === "Failure" || clicked.value === null) return;
      const actionTargets =
        clicked.value === "unpin"
          ? pinnedSelectedThreads
          : clicked.value === "regenerate-title"
            ? regeneratableTitleThreads
            : clicked.value === "settle"
              ? settlingThreads.flatMap((thread) => {
                  const current = threadByKeyRef.current.get(
                    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
                  );
                  return current && current.settledOverride !== "settled" ? [current] : [];
                })
              : selectedThreads;
      if (clicked.value === "settle" && actionTargets.length === 0) return;
      if (clicked.value !== "mark-unread" && !checkThreadOperations(actionTargets)) return;
      if (squireTrack.handleThreadMenu(squireTrackMenu, clicked.value)) {
        clearSelection();
        return;
      }
      if (clicked.value?.startsWith("snooze:")) {
        const preset =
          clicked.value === "snooze:custom"
            ? await requestCustomSnooze()
            : snoozePresets.find((candidate) => `snooze:${candidate.id}` === clicked.value);
        if (preset) {
          const coSnoozingKeys = new Set(threadKeys);
          clearSelection();
          const outcomes = await Promise.all(
            selectedThreads.map(async (thread) => {
              const threadRef = scopeThreadRef(thread.environmentId, thread.id);
              const outcome = await performSnooze(threadRef, preset, { coSnoozingKeys });
              return { outcome, threadRef };
            }),
          );
          const snoozedThreadRefs = outcomes.flatMap(({ outcome, threadRef }) =>
            outcome.status === "success" ? [threadRef] : [],
          );
          const failures = outcomes.flatMap(({ outcome }) =>
            outcome.status === "failure" ? [outcome.error] : [],
          );

          if (failures.length > 0) {
            const firstError = failures[0];
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title:
                  snoozedThreadRefs.length > 0
                    ? `Failed to snooze ${failures.length} thread${failures.length === 1 ? "" : "s"}`
                    : "Failed to snooze threads",
                description:
                  firstError instanceof Error ? firstError.message : "An error occurred.",
              }),
            );
          }
        }
        return;
      }
      if (clicked.value === "unpin") {
        for (const thread of pinnedSelectedThreads) {
          attemptUnpin(scopeThreadRef(thread.environmentId, thread.id));
        }
        clearSelection();
        return;
      }
      if (clicked.value === "regenerate-title") {
        for (const thread of regeneratableTitleThreads) {
          const result = await updateThreadMetadata({
            environmentId: thread.environmentId,
            input: { threadId: thread.id, regenerateTitle: true },
          });
          if (result._tag === "Success") continue;
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to regenerate thread titles",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return;
        }
        clearSelection();
        return;
      }
      if (clicked.value === "settle") {
        settleThreads(
          actionTargets.map((thread) =>
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          ),
        );
        clearSelection();
        return;
      }
      if (clicked.value === "mark-unread") {
        for (const threadKey of threadKeys) {
          const thread = threadByKeyRef.current.get(threadKey);
          if (thread) markThreadUnread(scopeThreadRef(thread.environmentId, thread.id));
        }
        clearSelection();
        return;
      }
      if (clicked.value !== "delete") return;
      if (confirmThreadDelete) {
        const confirmed = await settlePromise(() =>
          api.dialogs.confirm(
            [
              `Delete ${count} thread${count === 1 ? "" : "s"}?`,
              "This permanently clears conversation history for these threads.",
            ].join("\n"),
            { variant: "destructive" },
          ),
        );
        if (confirmed._tag === "Failure" || !confirmed.value) return;
      }
      if (
        !checkThreadOperations(
          threadKeys.flatMap((threadKey) => {
            const thread = threadByKeyRef.current.get(threadKey);
            return thread ? [thread] : [];
          }),
        )
      )
        return;
      const { deletedThreadKeys, firstFailure } = await deleteSelectedThreadEntries({
        entries: threadKeys.map((threadKey) => ({ threadKey })),
        delete: async ({ threadKey }, deletedThreadKeys) => {
          const thread = threadByKeyRef.current.get(threadKey);
          if (!thread) return null;
          return deleteThread(scopeThreadRef(thread.environmentId, thread.id), {
            deletedThreadKeys,
          });
        },
      });
      if (firstFailure !== null) {
        const firstError = squashAtomCommandFailure(firstFailure);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to delete threads",
            description: firstError instanceof Error ? firstError.message : "An error occurred.",
          }),
        );
      }
      removeFromSelection(
        getThreadKeysToDeselectAfterDelete(selectedThreadKeys, deletedThreadKeys, (threadKey) => {
          const threadRef = parseScopedThreadKey(threadKey);
          return threadRef !== null && readThreadShell(threadRef) !== null;
        }),
      );
    },
  );

  const handleDraftContextMenu = useStableCallback(
    (draftId: DraftId, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        const session = useComposerDraftStore.getState().getDraftSession(draftId);
        if (!api || !session || session.promotedTo) return;
        const projectGroup = projectGroupsRef.current.find((group) =>
          group.memberProjectRefs.some(
            (ref) =>
              ref.environmentId === session.environmentId && ref.projectId === session.projectId,
          ),
        );
        const workspacePath =
          session.worktreePath ??
          projectByKey.get(`${session.environmentId}:${session.projectId}`)?.workspaceRoot;
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            buildDraftActionMenuItems({
              hasPath: Boolean(workspacePath),
              hasBranch: Boolean(session.branch),
              hasProject: projectGroup != null,
            }),
            position,
          ),
        );
        if (clicked._tag === "Failure") return;
        switch (clicked.value) {
          case "project-settings":
            if (projectGroup)
              openProjectSettings(projectGroup, {
                environmentId: session.environmentId,
                projectId: session.projectId,
              });
            return;
          case "copy-path":
            if (workspacePath) copyPathToClipboard(workspacePath, { path: workspacePath });
            return;
          case "copy-branch":
            if (session.branch) copyBranchToClipboard(session.branch, { branch: session.branch });
            return;
          case "discard": {
            // The menu can stay open while the draft sends; discarding a
            // promoting draft would strand the send.
            const current = useComposerDraftStore.getState().getDraftSession(draftId);
            if (current && !current.promotedTo) discardComposerDraft(draftId);
            return;
          }
        }
      })();
    },
  );

  const handleThreadContextMenu = useStableCallback(
    (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        const threadKey = scopedThreadKey(threadRef);
        const selectionState = useThreadSelectionStore.getState();
        if (selectionState.hasSelection() && selectionState.selectedThreadKeys.has(threadKey)) {
          await handleMultiSelectContextMenu(position);
          return;
        }
        const thread = threadByKeyRef.current.get(threadKey);
        if (!thread) return;
        const threadWorkspacePath =
          thread.worktreePath ??
          projectByKey.get(`${thread.environmentId}:${thread.projectId}`)?.workspaceRoot ??
          null;
        const supportsSettlement =
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSettlement ===
          true;
        const supportsSnooze =
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSnooze === true;
        const supportsPinning =
          serverConfigs.get(thread.environmentId)?.environment.capabilities.threadPinning === true;
        const supportsAutoSettleOptOut =
          serverConfigs.get(thread.environmentId)?.environment.capabilities
            .threadAutoSettleOptOut === true;
        const supportsTitleRegeneration =
          serverConfigs.get(thread.environmentId)?.environment.capabilities
            .threadTitleRegeneration === true;
        const isRegeneratingTitle = thread.titleRegeneration != null;
        const isSettled = settledThreadKeysRef.current.has(threadKey);
        const isSnoozed = snoozedThreadKeysRef.current.has(threadKey);
        const isPinned = thread.pinnedAt != null;
        const snoozePresets = resolveSnoozePresets(new Date(), timestampFormat);
        const threadProjectGroup =
          projectGroupsRef.current.find((project) =>
            project.memberProjectRefs.some(
              (projectRef) =>
                projectRef.environmentId === thread.environmentId &&
                projectRef.projectId === thread.projectId,
            ),
          ) ?? null;
        const squireTrackMenu = readSquireThreadTrackMenu(thread);
        const clicked = await settlePromise(() =>
          api.contextMenu.show(
            buildThreadActionMenuItems({
              canOperate: readEnvironmentScope(
                threadRef.environmentId,
                AuthOrchestrationOperateScope,
              ),
              branch: thread.branch ?? null,
              projectFilter: threadProjectGroup
                ? {
                    label: threadProjectGroup.displayName,
                    isActive: projectScopeKey === threadProjectGroup.projectKey,
                  }
                : null,
              isPinned,
              isSettled,
              autoSettleEnabled: thread.autoSettleDisabledAt == null,
              isSnoozed,
              canSnoozeNow: canSnooze(thread, { now: new Date().toISOString() }),
              isRegeneratingTitle,
              isRunning: !threadRuntimeCanArchive(thread.runtime),
              canForkNow: readForkAtLatestTurn(threadRef).blockReason === null,
              canShareWithGuest:
                appAtomRegistry.get(canShareWithGuestAtom(threadRef.environmentId)) &&
                isGuestShareableThread(
                  thread,
                  projectByKey.get(`${thread.environmentId}:${thread.projectId}`),
                ),
              supports: {
                settlement: supportsSettlement,
                autoSettleOptOut: supportsAutoSettleOptOut,
                snooze: supportsSnooze,
                pinning: supportsPinning,
                titleRegeneration: supportsTitleRegeneration,
                fork: readEnvironmentSupportsForking(thread.environmentId),
              },
              snoozePresets,
              squireTrack: squireTrackMenu
                ? { isSquireThread: thread.squire != null, menu: squireTrackMenu.state }
                : null,
            }),
            position,
          ),
        );
        if (clicked._tag === "Failure" || clicked.value === null) return;
        if (threadActionRequiresOperate(clicked.value) && !checkThreadOperations([thread])) return;
        if (squireTrack.handleThreadMenu(squireTrackMenu, clicked.value)) return;
        if (clicked.value?.startsWith("snooze:")) {
          const preset =
            clicked.value === "snooze:custom"
              ? await requestCustomSnooze()
              : snoozePresets.find((candidate) => `snooze:${candidate.id}` === clicked.value);
          if (preset) attemptSnooze(threadRef, preset);
          return;
        }
        switch (clicked.value) {
          case "filter-by-project":
            if (threadProjectGroup) {
              setProjectScopeKey(
                projectScopeKey === threadProjectGroup.projectKey
                  ? null
                  : threadProjectGroup.projectKey,
              );
            }
            return;
          case "project-settings":
            if (threadProjectGroup)
              openProjectSettings(threadProjectGroup, {
                environmentId: threadRef.environmentId,
                projectId: thread.projectId,
              });
            return;
          case "new-thread-on-branch": {
            const result = await settlePromise(() =>
              handleNewThreadRef.current(scopeProjectRef(thread.environmentId, thread.projectId), {
                branch: thread.branch,
                worktreePath: thread.worktreePath,
                envMode: thread.worktreePath ? "worktree" : "local",
                startFromOrigin: false,
              }),
            );
            if (result._tag === "Failure") {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Could not create thread",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          case "fork":
            // Toasts its own block reason / failure; nothing to report here.
            await forkThreadAtLatestTurn(threadRef);
            return;
          case "settle":
            attemptSettle(threadRef);
            return;
          case "unsettle":
            attemptUnsettle(threadRef);
            return;
          case "unsnooze":
            attemptUnsnooze(threadRef);
            return;
          case "pin":
            attemptPin(threadRef);
            return;
          case "unpin":
            attemptUnpin(threadRef);
            return;
          case "auto-settle:enabled":
          case "auto-settle:disabled": {
            const result = await setThreadAutoSettle(
              threadRef,
              clicked.value === "auto-settle:enabled",
            );
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to update auto-settle",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          case "rename":
            startThreadRename(threadRef, thread.title);
            return;
          case "share-guest":
            openGuestShareDialog(threadRef);
            return;
          case "regenerate-title": {
            if (isRegeneratingTitle) return;
            const result = await updateThreadMetadata({
              environmentId: threadRef.environmentId,
              input: { threadId: threadRef.threadId, regenerateTitle: true },
            });
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to regenerate thread title",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
            }
            return;
          }
          case "mark-unread":
            markThreadUnread(threadRef);
            return;
          case "copy-path":
            if (!threadWorkspacePath) {
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Path unavailable",
                  description: "This thread does not have a workspace path to copy.",
                }),
              );
              return;
            }
            copyPathToClipboard(threadWorkspacePath, { path: threadWorkspacePath });
            return;
          case "copy-branch":
            if (thread.branch) {
              copyBranchToClipboard(thread.branch, { branch: thread.branch });
            }
            return;
          case "copy-thread-id":
            copyThreadIdToClipboard(thread.id, { threadId: thread.id });
            return;
          case "archive": {
            if (confirmThreadArchive) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(`Archive thread "${thread.title}"?`),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            let didArchive = false;
            const result = await archiveThread(threadRef, {
              onArchived: () => {
                didArchive = true;
              },
            });
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: didArchive
                    ? "Thread archived, but navigation failed"
                    : "Failed to archive thread",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
              return;
            }
            return;
          }
          case "delete": {
            if (confirmThreadDelete) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(
                  [
                    `Delete thread "${thread.title}"?`,
                    "This permanently clears conversation history for this thread.",
                  ].join("\n"),
                  { variant: "destructive" },
                ),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            const result = await deleteThread(threadRef);
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to delete thread",
                  description: error instanceof Error ? error.message : "An error occurred.",
                }),
              );
              return;
            }
            return;
          }
          default:
            return;
        }
      })();
    },
  );

  // Stave space rows offer Archive straight from the sidebar, through the
  // same single confirmation space settings opens.
  const [spaceConfirmation, setSpaceConfirmation] = useState<
    | (StaveSpaceConfirmation & {
        environmentId: EnvironmentId;
        projectId: string;
      })
    | null
  >(null);
  const landAfterStaveArchive = useStaveArchiveLanding();
  const handleProjectHeaderContextMenu = (
    event: ReactMouseEvent,
    project: SidebarProjectSnapshot,
  ) => {
    const entries = project.memberProjects.flatMap((member) => {
      const entry = readStaveSpaceLifecycleMenuEntry(member);
      return entry ? [{ member, entry }] : [];
    });
    // A plain project's header has no other menu, so Track alone opens one.
    const squireMenus = project.memberProjects.flatMap((member) => {
      const menu = readSquireContainerTrackMenu(
        member.environmentId,
        squireContainerTarget(member),
      );
      const items = menu ? buildSquireTrackMenuItems(menu.state) : [];
      return menu && items.length > 0 ? [{ member, menu, items }] : [];
    });
    if (entries.length === 0 && squireMenus.length === 0) return;
    event.preventDefault();
    const position = { x: event.clientX, y: event.clientY };
    void (async () => {
      const api = readLocalApi();
      if (!api) return;
      // Several checkouts each track separately, in their own environment's Squires.
      const squireItems: ContextMenuItem[] =
        squireMenus.length === 1
          ? squireMenus[0]!.items.map((item) => ({ ...item, id: `squire:0|${item.id}` }))
          : squireMenus.map(({ member, items }, index) => ({
              id: `squire:${index}`,
              label: member.environmentLabel ?? member.workspaceRoot,
              icon: "eye",
              children: items.map((item) => ({
                ...item,
                id: `squire:${index}|${item.id}`,
                ...(item.children
                  ? {
                      children: item.children.map((child) => ({
                        ...child,
                        id: `squire:${index}|${child.id}`,
                      })),
                    }
                  : {}),
              })),
            }));
      const items: ContextMenuItem[] = [
        ...(entries.length > 0
          ? [{ id: "settings", label: "Space settings", icon: "settings" }]
          : []),
        ...entries.map(({ member, entry }, index) => ({
          id: `lifecycle:${index}`,
          label:
            entries.length > 1
              ? `${entry.title} (${member.environmentLabel ?? member.workspaceRoot})`
              : entry.title,
          icon: "archive",
          disabled: entry.disabled,
          ...(index === 0 ? { separatorBefore: true } : {}),
        })),
        ...squireItems.map((item, index) =>
          index === 0 && entries.length > 0 ? { ...item, separatorBefore: true } : item,
        ),
      ];
      const clicked = await settlePromise(() => api.contextMenu.show(items, position));
      if (clicked._tag === "Failure" || !clicked.value) return;
      const squireClick = /^squire:(\d+)\|(.+)$/.exec(clicked.value);
      if (squireClick) {
        const chosen: SquireContainerTrackMenu | null =
          squireMenus[Number(squireClick[1])]?.menu ?? null;
        squireTrack.handleContainerMenu(chosen, squireClick[2]!);
        return;
      }
      if (clicked.value === "settings") {
        openProjectSettings(project);
        return;
      }
      const chosen = entries[Number(clicked.value.slice("lifecycle:".length))];
      if (!chosen || chosen.entry.disabled) return;
      setSpaceConfirmation({
        title: chosen.entry.title,
        operation: chosen.entry.operation,
        sagaId: chosen.entry.sagaId,
        environmentId: chosen.member.environmentId,
        projectId: chosen.member.id,
      });
    })();
  };
  // An archived space leaves the sidebar, so leave a route inside it for the
  // saga it left, or home (as settings does). Runs on the operation's
  // success; the dialog then closes itself. The route's thread is read from
  // the store: the sidebar's own list no longer holds an archived space's threads.
  const handleSpaceConfirmationFinished = () => {
    if (spaceConfirmation?.operation.kind !== "archiveSpace") return;
    const route = routeTargetRef.current;
    const location =
      route?.kind === "server"
        ? readThreadShell(route.threadRef)
        : route?.kind === "draft"
          ? useComposerDraftStore.getState().getDraftSession(route.draftId)
          : null;
    if (
      location?.environmentId !== spaceConfirmation.environmentId ||
      location.projectId !== spaceConfirmation.projectId
    )
      return;
    landAfterStaveArchive(spaceConfirmation);
  };

  const routeTerminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (sidebarMode === "apps") return; // AppsSidebar walks its own rows.
      if (event.defaultPrevented || event.repeat || isCommandPaletteOpen() || isModelPickerOpen()) {
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: routeTerminalOpen,
          modelPickerOpen: isModelPickerOpen(),
          isWeb: !isElectron,
          isDesktop: isElectron,
        },
      });
      const navigateToThreadKey = (targetThreadKey: string | null) => {
        if (!targetThreadKey) return false;
        const targetThread = threadByKey.get(targetThreadKey);
        if (!targetThread) return false;
        event.preventDefault();
        event.stopPropagation();
        navigateToThread(scopeThreadRef(targetThread.environmentId, targetThread.id));
        return true;
      };
      const traversalDirection = threadTraversalDirectionFromCommand(command);
      if (traversalDirection !== null) {
        navigateToThreadKey(
          resolveAdjacentThreadId({
            threadIds: orderedThreadKeys,
            currentThreadId: routeRowThreadKey,
            direction: traversalDirection,
          }),
        );
        return;
      }
      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) return;
      navigateToThreadKey(orderedThreadKeys[jumpIndex] ?? null);
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [
    keybindings,
    navigateToThread,
    orderedThreadKeys,
    routeRowThreadKey,
    routeTerminalOpen,
    sidebarMode,
    threadByKey,
  ]);

  const shortcutModifiers = useShortcutModifierState();
  const terminalFocused = useTerminalFocus();
  const shouldShowJumpHintsNow = shouldShowThreadJumpHintsForModifiers(
    shortcutModifiers,
    keybindings,
    {
      platform: navigator.platform,
      context: {
        terminalFocus: terminalFocused,
        terminalOpen: routeTerminalOpen,
        modelPickerOpen: isModelPickerOpen(),
        isWeb: !isElectron,
        isDesktop: isElectron,
      },
    },
  );
  useEffect(() => {
    updateThreadJumpHintsVisibility(shouldShowJumpHintsNow);
  }, [shouldShowJumpHintsNow, updateThreadJumpHintsVisibility]);

  const handleNewThreadClick = (event?: ReactMouseEvent) => {
    if (sidebarMode === "apps") {
      if (isMobile) setOpenMobile(false);
      if (appsNewThreadTarget !== null) void newThreadContext.handleNewThread(appsNewThreadTarget);
      return;
    }
    if (shouldCreateNewThreadInCurrentProject(event?.shiftKey ?? false, projectGroups.length)) {
      if (isMobile) setOpenMobile(false);
      void startNewThreadFromContext({
        activeDraftThread: newThreadContext.activeDraftThread,
        activeThread: newThreadContext.activeThread ?? undefined,
        defaultProjectRef: newThreadContext.defaultProjectRef,
        handleNewThread: newThreadContext.handleNewThread,
      });
      return;
    }
    if (isMobile) setOpenMobile(false);
    openCommandPalette({ open: "new-thread-in" });
  };

  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.new") ??
    (projectGroups.length <= 1 ? shortcutLabelForCommand(keybindings, "chat.newLocal") : undefined);
  const newThreadInProjectShortcutLabel = shortcutLabelForCommand(keybindings, "chat.newLocal");
  return (
    <>
      <ThreadContextDragGhost />
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent
        className="min-h-full"
        fixedHeader={
          <SidebarGroup className="z-[1]">
            <SidebarThreadHeader
              modeSwitch={<AppsModeSwitch />}
              showScopeRow={sidebarMode === "projects" && projectGroups.length > 0}
              scopePicker={
                <Combobox
                  items={projectScopeItems}
                  filteredItems={filteredProjectScopeItems}
                  autoHighlight
                  itemToStringLabel={(item) => item.label}
                  isItemEqualToValue={(a, b) => a.value === b.value}
                  open={projectScopeMenuState.open}
                  onOpenChange={(open) => {
                    if (open) suppressNextScopeChangeRef.current = false;
                    dispatchProjectScopeMenu({ type: "open-changed", open });
                  }}
                  onItemHighlighted={(item) => {
                    highlightedProjectScopeKeyRef.current = item?.value ?? null;
                  }}
                  value={selectedProjectScopeItem}
                  onValueChange={(item) => {
                    if (suppressNextScopeChangeRef.current) {
                      suppressNextScopeChangeRef.current = false;
                      return;
                    }
                    if (!item) return;
                    setProjectScopeKey(item.value === "all" ? null : item.value);
                  }}
                >
                  <ComboboxTrigger
                    render={
                      <SidebarScopeTrigger
                        kind="projects"
                        selectedLabel={scopedProjectGroup?.displayName ?? null}
                        icon={
                          scopedProjectGroup ? (
                            <ProjectFavicon
                              project={scopedProjectGroup}
                              className="size-4 shrink-0"
                            />
                          ) : undefined
                        }
                      />
                    }
                  />
                  <ComboboxPopup
                    align="start"
                    className="max-w-[min(18rem,var(--available-width))] overflow-hidden"
                  >
                    <ComboboxSearchInput
                      aria-label="Search projects"
                      placeholder="Search projects..."
                      value={projectScopeMenuState.query}
                      onKeyDown={(event) => {
                        if (
                          event.defaultPrevented ||
                          event.nativeEvent.isComposing ||
                          event.ctrlKey ||
                          event.altKey ||
                          event.metaKey ||
                          (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))
                        ) {
                          return;
                        }
                        const scopeKey = highlightedProjectScopeKeyRef.current;
                        const project = scopeKey ? projectGroupByScopeKey.get(scopeKey) : null;
                        if (project) handleProjectSettings(event, project);
                      }}
                      onChange={(event) =>
                        dispatchProjectScopeMenu({
                          type: "query-changed",
                          query: event.target.value,
                        })
                      }
                    />
                    <ComboboxEmpty>No matching projects.</ComboboxEmpty>
                    <ComboboxList>
                      {(item: (typeof projectScopeItems)[number]) => {
                        const project = projectGroupByScopeKey.get(item.value) ?? null;
                        return (
                          <ComboboxItem
                            key={item.value}
                            hideIndicator
                            value={item}
                            onContextMenu={(event) => {
                              if (project) handleProjectSettings(event, project);
                            }}
                          >
                            {project ? (
                              <ProjectFavicon project={project} className="size-4 shrink-0" />
                            ) : (
                              <FolderIcon className="size-4 shrink-0" />
                            )}
                            <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
                            {project && showProjectEnvironments ? (
                              <ProjectEnvironmentBadge
                                group={project}
                                primaryEnvironmentId={primaryEnvironmentId}
                                machineByEnvironmentId={environmentMachineById}
                              />
                            ) : null}
                            {project ? (
                              <StaveLifecycleBadge
                                notices={project.memberProjects.map((member) => member.notice)}
                              />
                            ) : null}
                            {project ? (
                              <Button
                                size="icon-xs"
                                variant="ghost-muted"
                                tabIndex={-1}
                                aria-hidden="true"
                                title={`Project settings for ${project.displayName}`}
                                className="ml-auto"
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={(event) => {
                                  void handleProjectSettings(event, project);
                                }}
                              >
                                <SettingsIcon className="size-3.5" />
                              </Button>
                            ) : null}
                          </ComboboxItem>
                        );
                      }}
                    </ComboboxList>
                  </ComboboxPopup>
                </Combobox>
              }
              onScopeAdd={openAddProjectCommandPalette}
              onNewThread={handleNewThreadClick}
              newThreadDisabled={
                sidebarMode === "apps" ? appsNewThreadTarget === null : projects.length === 0
              }
              newThreadShortcutLabel={newThreadShortcutLabel}
              newThreadInProjectShortcutLabel={newThreadInProjectShortcutLabel}
              showNewThreadInProjectHint={sidebarMode === "projects" && projectGroups.length > 1}
              searchInputRef={threadSearchInputRef}
              searchQuery={threadSearchQuery}
              onSearchQueryChange={(value) => {
                setThreadSearchQuery(value);
                setSearchHighlightKey(null);
              }}
              onSearchKeyDown={handleThreadSearchKeyDown}
              isSearching={isSearchingThreads}
              searchResultCount={threadSearchResults.length}
              activeSearchResultIndex={activeSearchResultIndex}
              onClearSearch={clearThreadSearch}
            />
          </SidebarGroup>
        }
      >
        <SidebarGroup className="flex-1" role="presentation">
          {isSearchingThreads ? (
            threadSearchResults.length > 0 ? (
              <TooltipProvider
                key="sidebar-thread-search-tooltips-150"
                delay={150}
                closeDelay={0}
                timeout={400}
              >
                <ul
                  id="sidebar-thread-search-results"
                  role="listbox"
                  aria-label="Thread search results"
                  className="flex flex-col gap-px"
                >
                  {threadSearchResults.map((thread, index) => {
                    const threadKey = scopedThreadKey(
                      scopeThreadRef(thread.environmentId, thread.id),
                    );
                    return (
                      <SidebarSearchResultRow
                        isSettled={settledThreadKeys.has(threadKey)}
                        key={threadKey}
                        thread={thread}
                        project={
                          projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null
                        }
                        projectDisplayName={
                          projectDisplayNameByKey.get(
                            `${thread.environmentId}:${thread.projectId}`,
                          ) ?? null
                        }
                        environmentLabel={environmentLabelById.get(thread.environmentId) ?? null}
                        environmentMachine={
                          environmentMachineById.get(thread.environmentId) ?? "server"
                        }
                        providerEntryByInstanceId={
                          providerEntriesByEnvironment.get(thread.environmentId) ??
                          EMPTY_PROVIDER_ENTRIES
                        }
                        isHighlighted={activeSearchResultIndex === index}
                        isRouteActive={routeRowThreadKey === threadKey}
                        resultId={`sidebar-thread-search-result-${index}`}
                        searchMatch={
                          threadSearchMatchByKey.get(
                            threadSearchMatchKey({
                              environmentId: thread.environmentId,
                              threadId: thread.id,
                            }),
                          ) ?? null
                        }
                        searchQuery={threadSearchQuery}
                        searchMatchQuery={threadSearch.query}
                        onHighlight={() => setActiveSearchResultIndex(index)}
                        onSelect={() => selectThreadSearchResult(thread)}
                        onFileDropThreads={handleThreadFileDrop}
                      />
                    );
                  })}
                </ul>
              </TooltipProvider>
            ) : (
              <p
                role="status"
                className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground"
              >
                {threadSearch.isPending ? "Searching thread messages…" : "No threads found"}
              </p>
            )
          ) : null}
          <SquiresSidebarGroup isSearching={isSearchingThreads} />
          {!isSearchingThreads && sidebarMode === "apps" ? <AppsSidebar /> : null}
          {!isSearchingThreads && sidebarMode === "projects" ? (
            <TooltipProvider
              key="sidebar-thread-tooltips-150"
              delay={150}
              closeDelay={0}
              timeout={400}
            >
              <SidebarSegments
                view={sidebarSegments}
                orderedThreads={orderedThreads}
                orderedPinnedThreads={orderedPinnedThreads}
                ref={null}
                // VoiceOver treats an exposed list as an interaction boundary,
                // which hides its rows from ordinary linear navigation. The one
                // list is presentational; account lists stay labeled lists.
                role={sidebarSegments.segments === null ? "presentation" : "list"}
                className={cn(
                  "flex flex-col gap-px",
                  actionSweep !== null && "**:pointer-events-none",
                  // One flat list grows to the sidebar's height so its shelves
                  // can sit at the bottom when the inbox is sparse.
                  sidebarSegments.segments === null &&
                    !nestSagaProjects &&
                    pinnedThreads.length +
                      activeThreads.length +
                      workingThreads.length +
                      snoozedThreads.length +
                      settledThreads.length >
                      0 &&
                    "flex-1",
                )}
              >
                {(segment) => {
                  const { pinnedThreads, orderedPinnedThreads, activeThreads } = segment;
                  const { workingThreads, snoozedThreads, settledThreads } = segment;
                  const { scopedSagaTree } = segment;
                  const { scopedProjectKeys, snoozedShelfExpanded, settledShelfExpanded } = segment;
                  const { workingShelfExpanded, toggleWorkingShelf } = segment;
                  const { toggleSnoozedShelf, toggleSettledShelf } = segment;
                  const renderThreadRow = (
                    thread: EnvironmentThreadShell,
                    section: SidebarSection,
                  ) => {
                    const threadKey = scopedThreadKey(
                      scopeThreadRef(thread.environmentId, thread.id),
                    );
                    const isCard =
                      section === "active" || section === "pinned" || section === "working";
                    const rowVariant = isCard ? "card" : "slim";
                    return (
                      <ScopedSortableThreadRow
                        key={threadKey}
                        thread={thread}
                        // The Working shelf (beta) follows live status: never a drag source.
                        // Operate scope is enforced per row inside ScopedSortableThreadRow.
                        dragDisabled={renamingThreadKey === threadKey || section === "working"}
                      >
                        {(sortable, dropVerb, dragOverPinned) => (
                          <SidebarThreadRow
                            // Keyed per variant on purpose: when a thread settles,
                            // the card fades out in place and the slim row fades
                            // in at its settled position instead of one element
                            // FLIP-sliding through every row in between (rows here
                            // are translucent, so a crossing row reads as text
                            // painted over text).
                            key={`${threadKey}:${rowVariant}`}
                            thread={thread}
                            variant={rowVariant}
                            nested={nestSagaProjects}
                            variantAction={
                              section === "snoozed"
                                ? "unsnooze"
                                : section === "settled"
                                  ? "unsettle"
                                  : "settle"
                            }
                            settlementSupported={
                              serverConfigs.get(thread.environmentId)?.environment.capabilities
                                .threadSettlement === true
                            }
                            snoozeSupported={
                              serverConfigs.get(thread.environmentId)?.environment.capabilities
                                .threadSnooze === true
                            }
                            pinningSupported={
                              serverConfigs.get(thread.environmentId)?.environment.capabilities
                                .threadPinning === true
                            }
                            isPinned={thread.pinnedAt != null}
                            sortable={sortable}
                            dropVerb={dropVerb}
                            dragOverPinned={dragOverPinned}
                            sweepAction={
                              actionSweep?.keys.has(threadKey) ? actionSweep.action : null
                            }
                            snoozeWakeLabelText={
                              section === "snoozed" && thread.snoozedUntil != null
                                ? snoozeWakeLabel(thread.snoozedUntil, {
                                    now: new Date().toISOString(),
                                  })
                                : null
                            }
                            wokeAt={threadWokeAt(thread, { now: snoozeNow })}
                            isActive={routeRowThreadKey === threadKey}
                            isRouteThread={routeThreadKey === threadKey}
                            openPullRequestsInRightPanel={routeThreadRef !== null}
                            jumpLabel={
                              showJumpHints ? (jumpLabelByKey.get(threadKey) ?? null) : null
                            }
                            currentEnvironmentId={primaryEnvironmentId}
                            environmentLabel={
                              environmentLabelById.get(thread.environmentId) ?? null
                            }
                            environmentMachine={
                              environmentMachineById.get(thread.environmentId) ?? "server"
                            }
                            scratchMachineLabel={scratchMachineLabelFor(thread)}
                            project={
                              projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ??
                              null
                            }
                            projectDisplayName={
                              projectDisplayNameByKey.get(
                                `${thread.environmentId}:${thread.projectId}`,
                              ) ?? null
                            }
                            providerEntryByInstanceId={
                              providerEntriesByEnvironment.get(thread.environmentId) ??
                              EMPTY_PROVIDER_ENTRIES
                            }
                            timestampFormat={timestampFormat}
                            onThreadClick={handleThreadClick}
                            onThreadActivate={navigateToThread}
                            onStartRename={startThreadRename}
                            onRenameTitleChange={setRenamingTitle}
                            onCommitRename={commitThreadRename}
                            onCancelRename={cancelThreadRename}
                            isRenaming={renamingThreadKey === threadKey}
                            renamingTitle={renamingThreadKey === threadKey ? renamingTitle : ""}
                            onContextMenu={handleThreadContextMenu}
                            canFork={
                              readForkAtLatestTurn(scopeThreadRef(thread.environmentId, thread.id))
                                .blockReason === null
                            }
                            onFork={forkThreadAtLatestTurn}
                            onSettle={attemptSettle}
                            onActionSweepStart={startActionSweep}
                            onUnsettle={attemptUnsettle}
                            onSnooze={attemptSnooze}
                            onUnsnooze={attemptUnsnooze}
                            onUnpin={attemptUnpin}
                            onAcknowledgeWoke={acknowledgeWoke}
                            onFileDropThreads={handleThreadFileDrop}
                          />
                        )}
                      </ScopedSortableThreadRow>
                    );
                  };
                  const renderShelfRows = (
                    rows: readonly EnvironmentThreadShell[],
                    section: "working" | "snoozed" | "settled",
                    expanded: boolean,
                  ) => {
                    const partition = partitionShelfRows(
                      rows,
                      (thread) =>
                        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) ===
                        routeRowThreadKey,
                    );
                    const renderGroup = (group: readonly EnvironmentThreadShell[], key: string) =>
                      group.length ? (
                        <li
                          key={`${section}:${key}`}
                          data-sidebar-motion-skip
                          className="list-none [&:has(>[data-slot=collapsible]:empty)]:hidden"
                        >
                          <SidebarHierarchyPanel open={expanded}>
                            <SidebarMotionList>
                              {group.map((thread) => renderThreadRow(thread, section))}
                            </SidebarMotionList>
                          </SidebarHierarchyPanel>
                        </li>
                      ) : null;
                    // Keep the selected row in its original position and mounted while
                    // the portions on either side fold away.
                    return [
                      renderGroup(partition.before, "before"),
                      partition.current ? renderThreadRow(partition.current, section) : null,
                      renderGroup(partition.after, "after"),
                    ];
                  };
                  if (nestSagaProjects) {
                    const renderNode = (
                      node: (typeof sagaTree)[number],
                      parent: SidebarProjectSnapshot | null = null,
                      ancestorsExpanded = true,
                    ): ReactNode => {
                      const nested = parent !== null;
                      const project = navigationProjectByKey.get(node.group.key);
                      if (!project) return null;
                      const closed = collapsedProjectKeys.has(node.group.key);
                      const matches = (thread: EnvironmentThreadShell) =>
                        node.group.memberProjectRefs.some(
                          (ref) =>
                            ref.environmentId === thread.environmentId &&
                            ref.projectId === thread.projectId,
                        );
                      const settledExpanded =
                        settledByProject.get(node.group.key)?.expanded ?? false;
                      const settledPage = projectSettledPage(
                        settledThreads.filter(matches),
                        {
                          expanded: true,
                          limit:
                            projectSettledShelves[node.group.key]?.limit ??
                            SETTLED_TAIL_INITIAL_COUNT,
                        },
                        routeRowThreadKey,
                        SETTLED_TAIL_INITIAL_COUNT,
                      );
                      return (
                        <li
                          key={node.group.key}
                          style={sidebarAccountStyle(
                            project.memberProjects.map((member) => member.environmentId),
                          )}
                          className={nested ? "lecturn-hierarchy-branch list-none" : "list-none"}
                        >
                          <div
                            data-thread-selection-safe
                            className="lecturn-project-header flex items-center gap-1 pt-2"
                            onContextMenu={(event) =>
                              handleProjectHeaderContextMenu(event, project)
                            }
                          >
                            <button
                              type="button"
                              data-lecturn-hover
                              className="rounded p-1 text-muted-foreground hover:bg-sidebar-row-hover"
                              aria-label={`${closed ? "Expand" : "Collapse"} ${project.displayName}`}
                              aria-expanded={!closed}
                              onClick={() => toggleProject(node.group.key)}
                            >
                              <ChevronDownIcon
                                className={cn(
                                  "lecturn-hierarchy-chevron size-3.5",
                                  closed && "-rotate-90",
                                )}
                              />
                            </button>
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <button
                                    type="button"
                                    data-lecturn-hover
                                    className={cn(
                                      "flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left text-xs font-medium",
                                      project.stave?.isSaga
                                        ? "text-primary"
                                        : "text-sidebar-foreground",
                                    )}
                                    onClick={() => {
                                      if (project.stave?.isSaga) {
                                        if (isMobile) setOpenMobile(false);
                                        void router.navigate({
                                          to: "/sagas/$environmentId/$projectId",
                                          params: {
                                            environmentId: project.environmentId,
                                            projectId: project.id,
                                          },
                                          search: { view: "board" },
                                        });
                                      } else toggleProject(node.group.key);
                                    }}
                                  >
                                    {project.stave ? (
                                      <StaveIcon
                                        role="img"
                                        aria-label={
                                          project.stave.isSaga ? "Stave saga" : "Stave space"
                                        }
                                        className="size-4 shrink-0 text-primary"
                                      />
                                    ) : null}
                                    {!project.stave ||
                                    project.projectIcon ||
                                    project.faviconPath ? (
                                      <ProjectFavicon
                                        project={project}
                                        className="size-4 shrink-0"
                                      />
                                    ) : null}
                                    <span className="min-w-0 truncate">
                                      <span
                                        className={
                                          project.stave?.isSaga ? "lecturn-saga-sheen" : undefined
                                        }
                                      >
                                        {project.displayName}
                                      </span>
                                      {project.stave ? (
                                        <span className="ml-1 text-3xs font-normal text-muted-foreground">
                                          ·{" "}
                                          {environmentLabelById.get(project.environmentId) ??
                                            project.environmentId}
                                        </span>
                                      ) : null}
                                    </span>
                                  </button>
                                }
                              />
                              <TooltipPopup side="right">
                                {project.stave ? (
                                  <p>{project.stave.isSaga ? "Stave saga" : "Stave space"}</p>
                                ) : null}
                                <p>
                                  {environmentLabelById.get(project.environmentId) ??
                                    project.environmentId}
                                </p>
                                <p className="max-w-80 break-all text-xs">
                                  {project.workspaceRoot}
                                </p>
                              </TooltipPopup>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <button
                                    type="button"
                                    data-lecturn-hover
                                    className="rounded px-1 text-xs text-muted-foreground hover:bg-sidebar-row-hover"
                                    aria-label={`New thread in ${project.displayName}`}
                                    onClick={() =>
                                      void newThreadContext.handleNewThread(
                                        scopeProjectRef(project.environmentId, project.id),
                                      )
                                    }
                                  >
                                    <PlusIcon className="size-3.5" />
                                  </button>
                                }
                              />
                              <TooltipPopup>
                                New conversation in {project.displayName}. Starts when you send a
                                message.
                              </TooltipPopup>
                            </Tooltip>
                            {serverConfigs.get(project.environmentId)?.environment.capabilities
                              .threadDecisions === true ? (
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <button
                                      type="button"
                                      data-lecturn-hover
                                      className="rounded px-1 text-xs text-muted-foreground hover:bg-sidebar-row-hover"
                                      aria-label={`Decisions for ${project.displayName}`}
                                      onClick={() =>
                                        void router.navigate({
                                          to: "/decisions/$environmentId/$projectId",
                                          params: {
                                            environmentId: project.environmentId,
                                            projectId: project.id,
                                          },
                                        })
                                      }
                                    >
                                      D
                                    </button>
                                  }
                                />
                                <TooltipPopup>Project decisions</TooltipPopup>
                              </Tooltip>
                            ) : null}
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <button
                                    type="button"
                                    data-lecturn-hover
                                    className="rounded px-1 text-xs text-muted-foreground hover:bg-sidebar-row-hover"
                                    aria-label={`Settings for ${project.displayName}`}
                                    onClick={() => openProjectSettings(project)}
                                  >
                                    <SettingsIcon aria-hidden className="size-3.5" />
                                  </button>
                                }
                              />
                              <TooltipPopup>
                                {project.stave?.isSaga
                                  ? "Saga settings"
                                  : project.stave
                                    ? "Space settings"
                                    : "Project settings"}
                              </TooltipPopup>
                            </Tooltip>
                          </div>
                          <SidebarHierarchyPanel open={!closed}>
                            <ul className="flex flex-col">
                              <SidebarDragScope
                                reservedKeys={reservedThreadOrderKeys}
                                actions={threadActions}
                                lists={{
                                  pinned: orderedPinnedThreads.filter(matches),
                                  active: activeThreads.filter(matches),
                                  working: workingThreads.filter(matches),
                                  snoozed: snoozedThreads.filter(matches),
                                  settled: settledThreads.filter(matches),
                                }}
                                enabled={
                                  ancestorsExpanded &&
                                  !closed &&
                                  !("collapsed" in segment && segment.collapsed)
                                }
                                retainCurrentSettled={false}
                                workingExpanded={workingShelfExpanded}
                                {...(workingShelfEnabled ? { sortInbox: sortInboxForSidebar } : {})}
                                snoozedExpanded={snoozedShelfExpanded}
                                settledExpanded={settledExpanded}
                                settledLimit={settledPage.limit}
                                routeThreadKey={routeRowThreadKey}
                                onSettle={settleFromDrag}
                              >
                                {({ pinned, active, working = [], snoozed, settled }) => {
                                  if (
                                    !pinned.length &&
                                    !active.length &&
                                    !working.length &&
                                    !snoozed.length &&
                                    !settled.length
                                  )
                                    return null;
                                  const settledPage = projectSettledPage(
                                    settled,
                                    {
                                      expanded: true,
                                      limit:
                                        projectSettledShelves[node.group.key]?.limit ??
                                        SETTLED_TAIL_INITIAL_COUNT,
                                    },
                                    routeRowThreadKey,
                                    SETTLED_TAIL_INITIAL_COUNT,
                                  );
                                  return (
                                    <>
                                      <li className="lecturn-hierarchy-conversations list-none">
                                        <SidebarMotionList>
                                          <SidebarDragBoundary
                                            marker="pinned-header"
                                            label="Pinned"
                                          />
                                          {pinned.map((thread) =>
                                            renderThreadRow(thread, "pinned"),
                                          )}
                                          <SidebarDragBoundary
                                            marker="pinned-divider"
                                            label="Active"
                                          />
                                          <SidebarDragBoundary
                                            marker="active-placeholder"
                                            label="Active"
                                          />
                                          {active.map((thread) =>
                                            renderThreadRow(thread, "active"),
                                          )}
                                          {working.length ? (
                                            <SidebarDragBoundary
                                              marker="working-header"
                                              label="Working"
                                            />
                                          ) : null}
                                          {working.map((thread) => {
                                            const key = scopedThreadKey(
                                              scopeThreadRef(thread.environmentId, thread.id),
                                            );
                                            return (
                                              <li
                                                key={key}
                                                data-sidebar-motion-skip
                                                className="list-none [&:has(>[data-slot=collapsible]:empty)]:hidden"
                                              >
                                                <SidebarHierarchyPanel
                                                  open={
                                                    workingShelfExpanded ||
                                                    key === routeRowThreadKey
                                                  }
                                                >
                                                  <SidebarMotionList>
                                                    {renderThreadRow(thread, "working")}
                                                  </SidebarMotionList>
                                                </SidebarHierarchyPanel>
                                              </li>
                                            );
                                          })}
                                          {snoozed.length ? (
                                            <SidebarDragBoundary
                                              marker="snoozed-header"
                                              label="Snoozed"
                                            />
                                          ) : null}
                                          {snoozed.map((thread) => {
                                            const key = scopedThreadKey(
                                              scopeThreadRef(thread.environmentId, thread.id),
                                            );
                                            return (
                                              <li
                                                key={key}
                                                data-sidebar-motion-skip
                                                className="list-none [&:has(>[data-slot=collapsible]:empty)]:hidden"
                                              >
                                                <SidebarHierarchyPanel
                                                  open={
                                                    snoozedShelfExpanded ||
                                                    key === routeRowThreadKey
                                                  }
                                                >
                                                  <SidebarMotionList>
                                                    {renderThreadRow(thread, "snoozed")}
                                                  </SidebarMotionList>
                                                </SidebarHierarchyPanel>
                                              </li>
                                            );
                                          })}
                                        </SidebarMotionList>
                                      </li>
                                      <SidebarDragBoundary
                                        marker="settled-header"
                                        label="Settled"
                                        className="lecturn-hierarchy-branch lecturn-hierarchy-settled"
                                      >
                                        <button
                                          type="button"
                                          data-thread-selection-safe
                                          data-lecturn-hover
                                          className="lecturn-settled-label flex w-full items-center gap-1.5 rounded px-1 py-2 text-left text-xs font-medium"
                                          aria-expanded={settledExpanded}
                                          aria-label={`Settled threads in ${project.displayName} (${settledPage.total})`}
                                          onClick={() =>
                                            setProjectSettledShelves((old) => ({
                                              ...old,
                                              [node.group.key]: {
                                                expanded: !settledExpanded,
                                                limit: settledPage.limit,
                                              },
                                            }))
                                          }
                                        >
                                          <ChevronDownIcon
                                            aria-hidden
                                            className={cn(
                                              "lecturn-hierarchy-chevron size-3.5",
                                              !settledExpanded && "-rotate-90",
                                            )}
                                          />
                                          <CircleCheckIcon aria-hidden className="size-3.5" />
                                          Settled{" "}
                                          <span className="tabular-nums">
                                            ({settledPage.total})
                                          </span>
                                        </button>
                                      </SidebarDragBoundary>
                                      <li
                                        data-sidebar-motion-skip
                                        className="lecturn-hierarchy-branch lecturn-hierarchy-settled list-none"
                                      >
                                        <ul>
                                          <SidebarDragBoundary
                                            marker="settled-placeholder"
                                            label="Settled"
                                          />
                                        </ul>
                                        <SidebarHierarchyPanel open={settledExpanded}>
                                          <ul className="flex flex-col">
                                            <li className="lecturn-hierarchy-conversations list-none">
                                              <SidebarMotionList>
                                                {settledPage.visible.map((thread) =>
                                                  renderThreadRow(thread, "settled"),
                                                )}
                                              </SidebarMotionList>
                                            </li>
                                            {settledPage.hidden > 0 ? (
                                              <li className="list-none pl-7">
                                                <button
                                                  type="button"
                                                  data-thread-selection-safe
                                                  data-lecturn-hover
                                                  className="lecturn-settled-label rounded px-2 py-1 text-xs"
                                                  onClick={() =>
                                                    setProjectSettledShelves((old) => ({
                                                      ...old,
                                                      [node.group.key]: {
                                                        expanded: true,
                                                        limit:
                                                          settledPage.limit +
                                                          SETTLED_TAIL_PAGE_COUNT,
                                                      },
                                                    }))
                                                  }
                                                >
                                                  Show{" "}
                                                  {Math.min(
                                                    settledPage.hidden,
                                                    SETTLED_TAIL_PAGE_COUNT,
                                                  )}{" "}
                                                  more
                                                </button>
                                              </li>
                                            ) : null}
                                          </ul>
                                        </SidebarHierarchyPanel>
                                      </li>
                                    </>
                                  );
                                }}
                              </SidebarDragScope>
                              {node.children.map((child) =>
                                renderNode(child, project, ancestorsExpanded && !closed),
                              )}
                            </ul>
                          </SidebarHierarchyPanel>
                        </li>
                      );
                    };
                    return (
                      <>
                        <SidebarDraftBlock
                          projectByKey={projectByKey}
                          projectDisplayNameByKey={projectDisplayNameByKey}
                          scopedProjectKeys={scopedProjectKeys}
                          routeDraftId={routeDraftIdForRows}
                          onNavigateToDraft={navigateToDraft}
                          onDraftContextMenu={handleDraftContextMenu}
                        />
                        <li
                          data-thread-selection-safe
                          className="lecturn-projects-heading flex list-none items-center gap-2 px-2 py-2 text-xs text-muted-foreground"
                        >
                          <span className="mr-auto font-medium">Projects</span>
                          {workingThreads.length ? (
                            <button
                              type="button"
                              data-lecturn-hover
                              aria-expanded={workingShelfExpanded}
                              onClick={toggleWorkingShelf}
                              data-testid="sidebar-working-shelf-toggle"
                              className="flex items-center gap-1"
                            >
                              <ChevronDownIcon
                                aria-hidden
                                className={cn(
                                  "lecturn-hierarchy-chevron size-3",
                                  !workingShelfExpanded && "-rotate-90",
                                )}
                              />
                              Working ({workingThreads.length})
                            </button>
                          ) : null}
                          {snoozedThreads.length ? (
                            <button
                              type="button"
                              data-lecturn-hover
                              aria-expanded={snoozedShelfExpanded}
                              onClick={toggleSnoozedShelf}
                              className="flex items-center gap-1"
                            >
                              <ChevronDownIcon
                                aria-hidden
                                className={cn(
                                  "lecturn-hierarchy-chevron size-3",
                                  !snoozedShelfExpanded && "-rotate-90",
                                )}
                              />
                              Snoozed ({snoozedThreads.length})
                            </button>
                          ) : null}
                        </li>
                        <li className="list-none">
                          <ul>{scopedSagaTree.map((node) => renderNode(node))}</ul>
                        </li>
                      </>
                    );
                  }
                  return (
                    <SidebarDragScope
                      reservedKeys={reservedThreadOrderKeys}
                      actions={threadActions}
                      lists={{
                        pinned: pinnedThreads,
                        active: activeThreads,
                        working: workingThreads,
                        snoozed: snoozedThreads,
                        settled: settledThreads,
                      }}
                      enabled={!("collapsed" in segment && segment.collapsed)}
                      workingExpanded={workingShelfExpanded}
                      {...(workingShelfEnabled ? { sortInbox: sortInboxForSidebar } : {})}
                      snoozedExpanded={snoozedShelfExpanded}
                      settledExpanded={settledShelfExpanded}
                      settledLimit={
                        sidebarSegments.segments?.find(
                          (candidate) => candidate.settledThreads === settledThreads,
                        )?.settledVisibleCount ?? settledVisibleCount
                      }
                      routeThreadKey={routeRowThreadKey}
                      onSettle={settleFromDrag}
                    >
                      {({
                        pinned: orderedPinnedThreads,
                        active: activeThreads,
                        working: workingThreads = [],
                        snoozed: snoozedThreads,
                        settled: settledThreads,
                      }) => {
                        const items: ReactNode[] = [
                          <SidebarDraftBlock
                            key="draft-sessions"
                            projectByKey={projectByKey}
                            projectDisplayNameByKey={projectDisplayNameByKey}
                            scopedProjectKeys={scopedProjectKeys}
                            routeDraftId={routeDraftIdForRows}
                            onNavigateToDraft={navigateToDraft}
                            onDraftContextMenu={handleDraftContextMenu}
                          />,
                          <SidebarDragBoundary key="pins" marker="pinned-header" label="Pinned" />,
                          ...orderedPinnedThreads.map((thread) =>
                            renderThreadRow(thread, "pinned"),
                          ),
                        ];
                        if (
                          !orderedPinnedThreads.length &&
                          !activeThreads.length &&
                          !workingThreads.length &&
                          !snoozedThreads.length &&
                          !settledThreads.length
                        )
                          return items[0];
                        items.push(
                          <SidebarDragBoundary
                            key="active"
                            marker="pinned-divider"
                            label="Active"
                          />,
                        );
                        items.push(
                          <SidebarDragBoundary
                            key="empty-active"
                            marker="active-placeholder"
                            label="Active"
                          />,
                        );
                        for (const thread of activeThreads) {
                          items.push(renderThreadRow(thread, "active"));
                        }
                        // Working shelf (beta): busy threads that do not need the
                        // user fold away below the inbox. Live status keeps them
                        // cards; the header carries the count while collapsed.
                        if (workingThreads.length > 0) {
                          items.push(
                            <SidebarDragBoundary
                              marker="working-header"
                              label="Working"
                              key="working-shelf-header"
                              className="mt-auto list-none"
                            >
                              <button
                                type="button"
                                onClick={toggleWorkingShelf}
                                aria-expanded={workingShelfExpanded}
                                data-testid="sidebar-working-shelf-toggle"
                                className="mb-1 mt-3 flex w-full cursor-pointer items-center gap-2 px-2.5 text-left"
                              >
                                <span className="text-xs font-medium text-sidebar-muted-foreground/60">
                                  {workingShelfExpanded
                                    ? "Working"
                                    : `Working (${workingThreads.length})`}
                                </span>
                                <span className="h-px flex-1 bg-sidebar-border/60" />
                                <ChevronDownIcon
                                  aria-hidden
                                  className={cn(
                                    "lecturn-hierarchy-chevron size-3 text-muted-foreground/50",
                                    workingShelfExpanded && "rotate-180",
                                  )}
                                />
                              </button>
                            </SidebarDragBoundary>,
                          );
                          items.push(
                            ...renderShelfRows(workingThreads, "working", workingShelfExpanded),
                          );
                        }
                        // Snoozed shelf: between the inbox and Settled — out of the
                        // way, never gone. The header always renders while anything
                        // is snoozed (the count is the whole footprint when
                        // collapsed); rows only when expanded. Vanishes entirely at
                        // count 0.
                        if (snoozedThreads.length > 0) {
                          items.push(
                            <SidebarDragBoundary
                              marker="snoozed-header"
                              label="Snoozed"
                              key="snoozed-shelf-header"
                              className={cn("list-none", workingThreads.length === 0 && "mt-auto")}
                            >
                              <button
                                type="button"
                                onClick={toggleSnoozedShelf}
                                aria-expanded={snoozedShelfExpanded}
                                data-testid="sidebar-snoozed-shelf-toggle"
                                className="mb-1 mt-3 flex w-full cursor-pointer items-center gap-2 px-2.5 text-left"
                              >
                                <span className="text-xs font-medium text-sidebar-muted-foreground/60">
                                  {snoozedShelfExpanded
                                    ? "Snoozed"
                                    : `Snoozed (${snoozedThreads.length})`}
                                </span>
                                <span className="h-px flex-1 bg-info/20" />
                                <ChevronDownIcon
                                  aria-hidden
                                  className={cn(
                                    "lecturn-hierarchy-chevron size-3 text-info-foreground",
                                    snoozedShelfExpanded && "rotate-180",
                                  )}
                                />
                              </button>
                            </SidebarDragBoundary>,
                          );
                          items.push(
                            ...renderShelfRows(snoozedThreads, "snoozed", snoozedShelfExpanded),
                          );
                        }
                        {
                          items.push(
                            <SidebarDragBoundary
                              marker="settled-header"
                              label="Settled"
                              key="settled-shelf-header"
                              className={cn(
                                "list-none",
                                workingThreads.length + snoozedThreads.length === 0 && "mt-auto",
                              )}
                            >
                              <button
                                type="button"
                                onClick={toggleSettledShelf}
                                aria-expanded={settledShelfExpanded}
                                data-testid="sidebar-settled-shelf-toggle"
                                className="mb-1 mt-3 flex w-full cursor-pointer items-center gap-2 px-2.5 text-left"
                              >
                                <span className="text-xs font-medium text-muted-foreground/50">
                                  {settledShelfExpanded
                                    ? "Settled"
                                    : `Settled (${settledThreads.length})`}
                                </span>
                                <span className="h-px flex-1 bg-sidebar-border/60" />
                                <ChevronDownIcon
                                  aria-hidden
                                  className={cn(
                                    "lecturn-hierarchy-chevron size-3 text-muted-foreground/50",
                                    settledShelfExpanded && "rotate-180",
                                  )}
                                />
                              </button>
                            </SidebarDragBoundary>,
                          );
                        }
                        const expandedSettledRows = projectSettledPage(
                          settledThreads,
                          {
                            expanded: true,
                            limit:
                              sidebarSegments.segments?.find(
                                (candidate) =>
                                  candidate.id === ("id" in segment ? segment.id : null),
                              )?.settledVisibleCount ?? settledVisibleCount,
                          },
                          routeRowThreadKey,
                          SETTLED_TAIL_INITIAL_COUNT,
                        ).visible;
                        items.push(
                          ...renderShelfRows(expandedSettledRows, "settled", settledShelfExpanded),
                        );
                        items.push(
                          <SidebarDragBoundary
                            key="empty-settled"
                            marker="settled-placeholder"
                            label="Settled"
                          />,
                        );
                        return (
                          <li className="flex flex-1 list-none flex-col">
                            <SidebarMotionList className="flex-1">{items}</SidebarMotionList>
                          </li>
                        );
                      }}
                    </SidebarDragScope>
                  );
                }}
                {!nestSagaProjects && settledShelfExpanded && hiddenSettledCount > 0 ? (
                  <li className="list-none">
                    <button
                      type="button"
                      onClick={showMoreSettled}
                      className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground/55 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                    >
                      <PlusIcon aria-hidden className="size-4 shrink-0" />
                      Show {Math.min(hiddenSettledCount, SETTLED_TAIL_PAGE_COUNT)} more
                    </button>
                  </li>
                ) : null}
              </SidebarSegments>
            </TooltipProvider>
          ) : null}
          {!isSearchingThreads &&
          sidebarMode === "projects" &&
          visibleDraftSessionCount === 0 &&
          pinnedThreads.length +
            activeThreads.length +
            workingThreads.length +
            snoozedThreads.length +
            settledThreads.length ===
            0 ? (
            <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground/60">
              {projects.length === 0 ? (
                <>
                  <span>No projects yet</span>
                  <button
                    type="button"
                    onClick={openAddProjectCommandPalette}
                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-2xs font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                  >
                    <PlusIcon className="-mx-0.5 size-3" />
                    Add project
                  </button>
                </>
              ) : scopedProjectGroup ? (
                `No threads in ${scopedProjectGroup.displayName} yet`
              ) : (
                "No threads yet"
              )}
            </div>
          ) : null}
        </SidebarGroup>
      </SidebarContent>
      {spaceConfirmation ? (
        <StaveConfirmDialog
          environmentId={spaceConfirmation.environmentId}
          title={spaceConfirmation.title}
          operation={spaceConfirmation.operation}
          onClose={() => setSpaceConfirmation(null)}
          onFinished={handleSpaceConfirmationFinished}
          closeOnFinish
        />
      ) : null}
      <SidebarChromeFooter />
    </>
  );
}

import {
  SidebarDragScope,
  ScopedSortableThreadRow,
  SidebarDragBoundary,
  SidebarMotionList,
  type SortableThreadRowBag,
} from "./sidebar/SidebarDragScope";
import { AccountMark } from "./sidebar/AccountMark";
import { accountByEnvironmentIdAtom } from "../cloud/connectAccounts";
import { useRevealActiveThread } from "./sidebar/useRevealActiveThread";
import { useSidebarAccountStyle } from "./sidebar/useSidebarAccountStyle";
import {
  resolveThreadPullRequestRef,
  selectThreadPullRequestWatches,
  threadPullRequestLinks,
} from "@lecturn/client-runtime/state/threadPullRequests";
import { PullRequestGlyph } from "./pullRequest/pullRequestIcons";
import { usePullRequestWatches } from "../state/pullRequestWatch";
import type { PullRequestWatch } from "@lecturn/contracts";
import { StaveIcon } from "./StaveIcon";
import { projectSettledPage } from "./sidebarSettledGroups";
import { StaveLifecycleBadge } from "./stave/StaveLifecycleBadge";
import { describeStaveWorkspace } from "./stave/staveWorkspaceContext.logic";
import { StaveConfirmDialog } from "./stave/StaveConfirmDialog";
import {
  readStaveSpaceLifecycleMenuEntry,
  useStaveArchiveLanding,
  type StaveSpaceConfirmation,
} from "./stave/staveSpaceLifecycle";
import { ThreadHoverCard, ThreadHoverCardPopup } from "./ThreadHoverCard";
import {
  setThreadChangeRequestSnapshot,
  ThreadTerminalStatusButton,
} from "./ThreadStatusIndicators";
import { ThreadContextDragGhost } from "./chat/ThreadContextDragGhost";
import { discardComposerDraft } from "../lib/discardComposerDraft";
import { SidebarPointerSensor } from "./Sidebar.pointer";
import { requestCustomSnooze } from "./CustomSnoozeDialog";
import { useSupportsMultiplePullRequests } from "~/hooks/useSupportsMultiplePullRequests";
import { resolveThreadCurrentPullRequestLink } from "@lecturn/shared/threadPullRequests";
import { useAtomValue } from "@effect/atom-react";
import { replaceComposerContextReferences } from "@lecturn/shared/composerContextReferences";
import * as Schema from "effect/Schema";
import { CSS } from "@dnd-kit/utilities";
import {
  canSnooze,
  effectiveSnoozed,
  threadWokeAt,
} from "@lecturn/client-runtime/state/thread-settled";
import { createInboxReturnTracker } from "@lecturn/client-runtime/state/thread-inbox";
import { formatDiffCount } from "@lecturn/client-runtime/diff-count";
import {
  resolveSettledThreadTimestamp,
  sortSettledThreads,
} from "@lecturn/client-runtime/state/thread-sort";
import {
  threadSearchMatchKey,
  type EnvironmentThreadSearchMatch,
} from "@lecturn/client-runtime/state/thread-search";
import {
  resolveThreadProviderStack,
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
  type EnvironmentMachineKind,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ThreadId,
} from "@lecturn/contracts";
import type { TimestampFormat } from "@lecturn/contracts/settings";
import {
  AlarmClockIcon,
  AlarmClockOffIcon,
  ArrowRightLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  ClockIcon,
  FolderIcon,
  GitBranchIcon,
  GitForkIcon,
  ListFilterIcon,
  MessageCircleQuestionIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SettingsIcon,
  ShieldQuestionIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useParams, useRouter } from "@tanstack/react-router";

import { useRightPanelStore } from "../rightPanelStore";
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
import { useOpenPrLink } from "../lib/openPullRequestLink";
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
  useProject,
  readThreadShell,
  useProjects,
  useThreadShells,
} from "../state/entities";
import { resolveThreadGitTarget } from "../lib/threadGitTarget";
import { readForkAtLatestTurn, useForkThread } from "../hooks/useForkThread";
import { environmentServerConfigsAtom, primaryServerKeybindingsAtom } from "../state/server";
import { environmentProjects } from "../state/projects";
import { vcsEnvironment } from "../state/vcs";
import { threadEnvironment } from "../state/threads";
import { useEnvironmentQuery } from "../state/query";
import { useThreadSearch } from "../state/queries";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import {
  buildThreadRouteParams,
  resolveActiveThreadRouteRef,
  resolveThreadRouteTarget,
} from "../threadRoutes";
import { formatRelativeTimeLabel, parseTimestampDate } from "../timestampFormat";
import type { SidebarThreadSummary } from "../types";
import { isScratchProject } from "@lecturn/client-runtime/state/projects";
import type { EnvironmentProject } from "@lecturn/client-runtime/state/shell";
import { cn } from "~/lib/utils";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { ProjectEnvironmentBadge } from "./ProjectEnvironmentBadge";
import {
  buildDraftActionMenuItems,
  buildThreadActionMenuItems,
  threadActionRequiresOperate,
} from "./threadActionMenu.logic";
import {
  type SidebarDropVerb,
  type SidebarSection,
  filterSidebarV2VisibleThreads,
  buildBulkTitleRegenerationContextMenuItem,
  buildBulkUnpinContextMenuItem,
  deleteSelectedThreadEntries,
  filterSidebarProjectScopeItems,
  firstValidTimestampMs,
  hasUnseenCompletion,
  isSidebarNestedLinkClick,
  isSidebarThreadWorking,
  isTrailingDoubleClick,
  orderItemsByPreferredIds,
  reduceSidebarProjectScopeMenuState,
  resolveAdjacentThreadId,
  resolveSidebarSweepKeys,
  resolveSidebarThreadSection,
  resolveSidebarRowAccessibility,
  resolveSidebarThreadStatus,
  resolveThreadLastVisitedAt,
  searchSidebarThreads,
  shouldCreateNewThreadInCurrentProject,
  shouldNavigateAfterThreadPark,
  shouldRecedeSidebarThread,
  sidebarThreadKeyAtY,
  sortInboxThreadsByReturn,
  sortPinnedThreadsForSidebar,
  sortSidebarV2ProjectGroups,
  sortThreadsForSidebar,
  sortWorkingThreadsBySend,
  useThreadJumpHintVisibility,
  useRetainedValue,
  useSidebarRowSubscriptionLease,
} from "./Sidebar.logic";
import { resolveLocalCheckoutBranchMismatch } from "./BranchToolbar.logic";
import {
  ThreadPullRequestBadgeControl,
  ThreadPullRequestsMiniList,
  ThreadWorktreeIndicator,
  prStatusIndicator,
  resolveThreadPullRequestBadge,
  type ThreadPr,
  terminalStatusFromRunningIds,
  threadChangeRequestSnapshotsAtom,
  type ThreadChangeRequestSnapshot,
  type TerminalStatusIndicator,
  useLinkedThreadPullRequest,
  ThreadSearchPullRequestNumber,
} from "./ThreadStatusIndicators";
import { resolveSnoozePresets, snoozeWakeLabel, type SnoozePreset } from "./Sidebar.snooze";
import { ProjectFavicon, type ProjectFaviconProject } from "./ProjectFavicon";
import { ThreadSearchMatchExcerpt } from "./ThreadSearchMatch";
import { makeWorkspaceFileDropHandlers } from "./chat/workspaceFileDrop";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import { getTriggerDisplayModelLabel } from "./chat/providerIconUtils";
import {
  deriveProviderEntriesByEnvironment,
  shouldShowInstanceBadge,
  type ProviderInstanceEntry,
} from "../providerInstances";
import { useThreadRunningTerminalIds } from "../state/terminalSessions";
import { useStableCallback } from "../hooks/useStableCallback";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Button, InlineButton } from "./ui/button";
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
import { useListedProjects } from "./stave/useListedProjects";
import { sagaSidebarThreadOrder } from "./stave/staveSaga.logic";
import { SidebarContent, SidebarGroup, useSidebar } from "./ui/sidebar";
import { snapshotsPerAccount, useSidebarSegmentation } from "./sidebar/accountProjectGroups";
import { SidebarSegments, useSegmentOwnsEnvironment } from "./sidebar/SidebarSegments";
import { flattenSegmentsForNavigation, nameGroupsByAccount } from "./sidebar/sidebarSegments.logic";
import { useSidebarSegments } from "./sidebar/useSidebarSegments";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { SidebarHierarchyPanel } from "./sidebar/SidebarHierarchyPanel";
import { partitionShelfRows } from "./sidebar/sidebarShelfRows";
import { SidebarHeaderIconButton, SidebarThreadHeader } from "./sidebar/SidebarThreadHeader";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuShortcut, MenuTrigger } from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { MiddleTruncate } from "./ui/middle-truncate";
import {
  composerDraftHasUserContent,
  DraftId,
  useComposerDraftStore,
  useThreadHasUnsentDraft,
  type ComposerThreadDraftState,
  type DraftSessionState,
} from "../composerDraftStore";

const EMPTY_PROVIDER_ENTRIES: ReadonlyMap<string, ProviderInstanceEntry> = new Map();
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

function compactSidebarTimeLabel(label: string): string {
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

function threadTimeLabel(thread: SidebarThreadSummary): string {
  const timestamp = thread.latestUserMessageAt ?? thread.updatedAt;
  return compactSidebarTimeLabel(formatRelativeTimeLabel(timestamp));
}

function settledTimeLabel(thread: SidebarThreadSummary): string {
  const timestamp = resolveSettledThreadTimestamp(thread);
  return timestamp === null ? "" : compactSidebarTimeLabel(formatRelativeTimeLabel(timestamp));
}

function JumpHintBadge(props: { label: string }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute right-1.5 top-1/2 z-10 inline-flex h-5 -translate-y-1/2 items-center rounded-full border border-border/80 bg-background/95 px-1.5 font-mono text-3xs font-medium tracking-tight text-foreground shadow-sm"
    >
      {props.label}
    </span>
  );
}

function terminalProcessLabel(count: number): string {
  return `${count} terminal ${count === 1 ? "process" : "processes"} running`;
}

function SidebarProviderStack(props: {
  thread: SidebarThreadSummary;
  providerEntryByInstanceId: ReadonlyMap<string, ProviderInstanceEntry>;
}) {
  const stack = resolveThreadProviderStack(props.thread);
  const currentInstanceId = stack[stack.length - 1]!;
  const currentEntry = props.providerEntryByInstanceId.get(currentInstanceId) ?? null;
  if (currentEntry === null) return null;
  const showInstanceBadge = shouldShowInstanceBadge(
    currentEntry,
    props.providerEntryByInstanceId.values(),
  );
  const current = (
    <ProviderInstanceIcon
      driverKind={currentEntry.driverKind}
      displayName={currentEntry.displayName}
      accentColor={currentEntry.accentColor}
      acpRegistryAgentId={currentEntry.acpRegistryAgentId}
      acpRegistryIconUrl={currentEntry.acpRegistryIconUrl}
      showBadge={showInstanceBadge}
      iconClassName="size-3.5 opacity-60"
      badgeClassName="right-[-0.1875rem] bottom-[-0.1875rem] h-3 min-w-3 px-0.5 text-5xs"
    />
  );
  if (stack.length === 1) {
    return <span className="inline-flex shrink-0 items-center">{current}</span>;
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {stack.slice(0, -1).map((instanceId) => {
        const entry = props.providerEntryByInstanceId.get(instanceId);
        if (entry === undefined) return null;
        return (
          <ProviderInstanceIcon
            key={instanceId}
            driverKind={entry.driverKind}
            displayName={entry.displayName}
            acpRegistryAgentId={entry.acpRegistryAgentId}
            acpRegistryIconUrl={entry.acpRegistryIconUrl}
            iconClassName="size-3 opacity-35 grayscale"
          />
        );
      })}
      <span className="relative z-10 inline-flex items-center">{current}</span>
    </span>
  );
}

function SidebarThreadTooltip({
  thread,
  project,
  projectDisplayName,
  staveWorkspace,
  environmentLabel,
  environmentMachine,
  providerEntry,
  providerEntryByInstanceId,
  showInstanceBadge,
  modelInstanceId,
  modelLabel,
  branchMismatch,
  terminalStatus,
  terminalProcessCount,
  pullRequest,
  pullRequestRepository,
  pullRequestWatches = [],
}: {
  thread: SidebarThreadSummary;
  project: ProjectFaviconProject | null;
  projectDisplayName: string | null;
  staveWorkspace: ReturnType<typeof describeStaveWorkspace>;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
  providerEntry: ProviderInstanceEntry | null;
  providerEntryByInstanceId: ReadonlyMap<string, ProviderInstanceEntry>;
  showInstanceBadge: boolean;
  modelInstanceId: string;
  modelLabel: string;
  branchMismatch: {
    threadBranch: string;
    currentBranch: string;
  } | null;
  terminalStatus: TerminalStatusIndicator | null;
  terminalProcessCount: number;
  pullRequest?: ThreadPr;
  pullRequestRepository?: string | undefined;
  pullRequestWatches?: readonly PullRequestWatch[];
}) {
  const driverKind = providerEntry?.driverKind ?? null;
  const previousProviderNames = thread.providerInstanceHistory
    .filter((instanceId) => instanceId !== modelInstanceId)
    .map((instanceId) => providerEntryByInstanceId.get(instanceId)?.displayName ?? instanceId);
  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(thread.environmentId);
  const showLinkedPullRequests = supportsMultiplePullRequests && thread.pullRequests.length > 0;
  const allRequests = threadPullRequestLinks(
    pullRequestWatches,
    pullRequest
      ? {
          ...pullRequest,
          repository: pullRequestRepository,
        }
      : null,
  );
  // The linked list below already names the thread's PRs; keep only the
  // watch details it cannot show.
  const requests = showLinkedPullRequests
    ? allRequests.filter((request) => request.watch !== undefined)
    : allRequests;
  return (
    <ThreadHoverCardPopup side="right" align="start" sideOffset={4}>
      <ThreadHoverCard
        title={thread.title}
        footer={
          showLinkedPullRequests ? (
            <div className="border-t border-border/60 pt-2 pl-0.5 text-xs text-muted-foreground">
              <ThreadPullRequestsMiniList pullRequests={thread.pullRequests} />
            </div>
          ) : null
        }
      >
        {thread.settledOverride === "settled" ? (
          <div className="lecturn-settled-label flex items-center gap-1.5 text-xs font-medium">
            <CircleCheckIcon aria-hidden className="size-3.5" /> Settled
          </div>
        ) : null}
        {projectDisplayName ? (
          <div className="flex min-w-0 items-center gap-2">
            {project ? <ProjectFavicon project={project} className="size-3 shrink-0" /> : null}
            <div className="min-w-0 truncate text-foreground/75">{projectDisplayName}</div>
          </div>
        ) : null}
        {environmentLabel ? (
          <div className="flex min-w-0 items-center gap-2">
            <EnvironmentMachineIcon
              kind={environmentMachine}
              className="size-3 shrink-0 stroke-muted-foreground"
            />
            <div className="min-w-0 truncate text-foreground/75">{environmentLabel}</div>
          </div>
        ) : null}
        {staveWorkspace ? (
          <div className="flex min-w-0 items-start gap-2">
            <StaveIcon className="mt-0.5 size-3 shrink-0 text-primary" />
            <div className="min-w-0 text-foreground/75">
              <div>{staveWorkspace.label}</div>
              <div className="mt-1 text-muted-foreground whitespace-pre-line wrap-break-word">
                {staveWorkspace.title}
              </div>
            </div>
          </div>
        ) : thread.branch ? (
          <div className="flex min-w-0 items-center gap-2">
            <GitBranchIcon className="size-3 shrink-0 stroke-muted-foreground" />
            <MiddleTruncate value={thread.branch} className="flex" />
          </div>
        ) : null}
        {requests.map((request) => (
          <div key={request.key} className="flex min-w-0 items-start gap-2">
            <PullRequestGlyph.pullRequest aria-hidden className="mt-0.5 size-3 shrink-0" />
            <div className="min-w-0 text-foreground/75">
              <div>
                {request.repository} #{request.number} · {request.state}
              </div>
              <div className="mt-1 wrap-break-word">{request.title}</div>
              {request.watch ? (
                <div className="mt-1 text-muted-foreground">
                  {request.watch.watching ? "Watching" : "Not watching"} · Manager{" "}
                  {request.watch.managerStatus}
                  {request.watch.observation
                    ? ` · CI ${request.watch.observation.checksState} · Required ${request.watch.observation.requiredChecks}`
                    : ""}
                  {request.watch.observation ? (
                    <div>
                      Observed {new Date(request.watch.observation.observedAt).toLocaleString()}
                    </div>
                  ) : null}
                  {request.watch.error ? <div>{request.watch.error}</div> : null}
                </div>
              ) : null}
            </div>
          </div>
        ))}
        {branchMismatch ? (
          <div className="flex min-w-0 items-start gap-2 text-warning">
            <CircleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0 stroke-current" />
            <div className="min-w-0 flex-1 wrap-break-word leading-5">
              You're currently checked out on another branch.
            </div>
          </div>
        ) : null}
        {driverKind ? (
          <div className="flex min-w-0 items-center gap-2">
            <ProviderInstanceIcon
              driverKind={driverKind}
              displayName={
                providerEntry?.displayName ?? thread.runtime?.providerName ?? modelInstanceId
              }
              accentColor={providerEntry?.accentColor}
              acpRegistryAgentId={providerEntry?.acpRegistryAgentId}
              acpRegistryIconUrl={providerEntry?.acpRegistryIconUrl}
              showBadge={showInstanceBadge && providerEntry?.accentColor !== undefined}
              badgeContent="none"
              badgeClassName="h-2 min-w-2 px-0"
              iconClassName="size-3 shrink-0 grayscale opacity-60"
            />
            <div className="min-w-0 truncate text-foreground/75">
              {showInstanceBadge && providerEntry
                ? `${modelLabel} · ${providerEntry.displayName}`
                : modelLabel}
            </div>
          </div>
        ) : null}
        {previousProviderNames.length > 0 ? (
          <div className="flex min-w-0 items-center gap-2">
            <ArrowRightLeftIcon className="size-3 shrink-0 stroke-muted-foreground" />
            <div className="min-w-0 truncate text-foreground/75">
              Handed off from {previousProviderNames.join(", ")}
            </div>
          </div>
        ) : null}
        {terminalStatus ? (
          <div className="flex min-w-0 items-center gap-2">
            <TerminalIcon
              aria-hidden
              className={cn("size-3 shrink-0", terminalStatus.colorClass)}
            />
            <div className="min-w-0 truncate text-foreground/75">
              {terminalProcessLabel(terminalProcessCount)}
            </div>
          </div>
        ) : null}
        {thread.runtime?.lastError ? (
          <div
            className={cn(
              "flex min-w-0 items-center gap-2",
              thread.runtime.lastErrorClass === "usage_limit" ? "text-warning" : "text-error",
            )}
          >
            <CircleAlertIcon className="size-3 shrink-0 stroke-current" />
            <div className="min-w-0 truncate">
              {thread.runtime.lastErrorClass === "usage_limit"
                ? "Usage limit reached"
                : "Error occurred"}
            </div>
          </div>
        ) : null}
      </ThreadHoverCard>
    </ThreadHoverCardPopup>
  );
}

function SnoozeMenuButton(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSnooze: (preset: Pick<SnoozePreset, "snoozedUntil">) => void;
  timestampFormat: TimestampFormat;
}) {
  const { open, onOpenChange, onSnooze, timestampFormat } = props;
  const presets = useMemo(
    () => (open ? resolveSnoozePresets(new Date(), timestampFormat) : []),
    [open, timestampFormat],
  );
  return (
    <Menu open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label="Snooze thread"
                  onClick={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                  className="inline-flex h-full cursor-pointer items-center gap-0.5 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
                />
              }
            />
          }
        >
          <ClockIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup>Snooze thread</TooltipPopup>
      </Tooltip>
      <MenuPopup side="bottom" align="end">
        {presets.map((preset) => (
          <MenuItem
            key={preset.id}
            onClick={(event) => {
              event.stopPropagation();
              onSnooze(preset);
            }}
          >
            {preset.label}
            <MenuShortcut>{preset.whenLabel}</MenuShortcut>
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem
          onClick={async (event) => {
            event.stopPropagation();
            const choice = await requestCustomSnooze();
            if (choice) onSnooze(choice);
          }}
        >
          Custom…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

const draftSurfaceClassName = "bg-warning/4 hover:bg-warning/8";
const draftPenClassName = "size-3 shrink-0 text-warning-foreground";

// Pointer travel before a press on a row's action button starts a sweep, the
// same distance a row drag needs. Shorter presses stay clicks.
const SIDEBAR_DRAG_DISTANCE = 6;

type SidebarSweepAction = "settle" | "unsettle" | "unsnooze";

const SidebarDraftRow = memo(function SidebarDraftRow(props: {
  draftId: DraftId;
  composer: ComposerThreadDraftState;
  project: ProjectFaviconProject | null;
  projectDisplayName: string | null;
  isActive: boolean;
  onNavigate: (draftId: DraftId) => void;
  onDiscard: (draftId: DraftId) => void;
  onContextMenu: (draftId: DraftId, position: { x: number; y: number }) => void;
}) {
  const { composer, draftId, onContextMenu, onDiscard, onNavigate } = props;
  const promptPreview =
    replaceComposerContextReferences(composer.prompt, (occurrence) => occurrence.label)
      .trim()
      .split("\n", 1)[0] ?? "";
  // images mirrors persistedAttachments once rehydration finishes; before
  // that only the persisted list is populated, hence max not sum.
  const attachmentCount =
    Math.max(composer.images.length, composer.persistedAttachments.length) +
    composer.files.length +
    composer.terminalContexts.length +
    composer.previewAnnotations.length +
    composer.reviewComments.length;
  const preview =
    promptPreview.length > 0
      ? promptPreview
      : `${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`;
  const accessibility = resolveSidebarRowAccessibility({
    title: preview,
    statusLabel: "Unsent draft",
    projectDisplayName: props.projectDisplayName,
    isActive: props.isActive,
  });
  const handleActivate = useCallback(() => onNavigate(draftId), [draftId, onNavigate]);
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      // Keys targeting the nested discard button belong to the button:
      // preventDefault here would swallow Space's synthesized click and
      // navigate instead of discarding.
      if ((event.target as HTMLElement).closest("button")) return;
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        onContextMenu(draftId, { x: rect.left, y: rect.bottom });
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onNavigate(draftId);
      }
    },
    [draftId, onContextMenu, onNavigate],
  );
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      onContextMenu(draftId, { x: event.clientX, y: event.clientY });
    },
    [draftId, onContextMenu],
  );
  const handleDiscard = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onDiscard(draftId);
    },
    [draftId, onDiscard],
  );
  return (
    <li className="list-none py-0.5">
      <div
        role="button"
        tabIndex={0}
        aria-label={accessibility.label}
        aria-current={accessibility.current}
        data-testid="sidebar-draft-row"
        className={cn(
          "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left text-sidebar-foreground outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.isActive ? "bg-sidebar-row-active" : draftSurfaceClassName,
        )}
        onClick={handleActivate}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
      >
        <span className="sr-only">{preview}</span>
        <div className="relative z-10 h-[4.875rem] px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)">
          <div className="flex h-5 min-w-0 items-center gap-1.5">
            <SquarePenIcon aria-hidden className={draftPenClassName} />
            {props.project ? (
              <ProjectFavicon project={props.project} className="size-4 shrink-0" />
            ) : null}
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-secondary-label">
              {props.projectDisplayName}
            </span>
            <span className="ml-auto flex h-5 min-w-5 shrink-0 items-center justify-end">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Discard draft"
                      onClick={handleDiscard}
                      className="pointer-events-none inline-flex cursor-pointer items-center rounded-md bg-transparent px-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:opacity-100"
                    >
                      <XIcon className="size-3" />
                    </button>
                  }
                />
                <TooltipPopup side="top">Discard draft</TooltipPopup>
              </Tooltip>
            </span>
          </div>
          <div aria-hidden className="mt-0.5 truncate text-sm font-medium text-foreground/90">
            {preview}
          </div>
        </div>
      </div>
    </li>
  );
});

interface SidebarDraftRowData {
  draftId: DraftId;
  session: DraftSessionState;
  composer: ComposerThreadDraftState;
}

const SidebarDraftBlock = memo(function SidebarDraftBlock(props: {
  projectByKey: ReadonlyMap<string, EnvironmentProject>;
  projectDisplayNameByKey: ReadonlyMap<string, string>;
  scopedProjectKeys: ReadonlySet<string> | null;
  routeDraftId: string | null;
  onNavigateToDraft: (draftId: DraftId) => void;
  onDraftContextMenu: (draftId: DraftId, position: { x: number; y: number }) => void;
}) {
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const draftsByThreadKey = useComposerDraftStore((store) => store.draftsByThreadKey);
  const ownsEnvironment = useSegmentOwnsEnvironment();
  const [frozenActive, setFrozenActive] = useState<{
    routeDraftId: string | null;
    row: SidebarDraftRowData | null;
  }>({ routeDraftId: null, row: null });
  if (frozenActive.routeDraftId !== props.routeDraftId) {
    let row: SidebarDraftRowData | null = null;
    if (props.routeDraftId !== null) {
      const draftId = DraftId.make(props.routeDraftId);
      const store = useComposerDraftStore.getState();
      const session = store.getDraftSession(draftId);
      const composer = store.getComposerDraft(draftId);
      row =
        session && session.promotedTo == null && composer && composerDraftHasUserContent(composer)
          ? { draftId, session, composer }
          : null;
    }
    setFrozenActive({ routeDraftId: props.routeDraftId, row });
  }
  const drafts = useMemo(() => {
    const rows: SidebarDraftRowData[] = [];
    for (const [draftKey, session] of Object.entries(draftThreadsByThreadKey)) {
      if (session.promotedTo != null || !ownsEnvironment(session.environmentId)) {
        continue;
      }
      if (
        props.scopedProjectKeys !== null &&
        !props.scopedProjectKeys.has(`${session.environmentId}:${session.projectId}`)
      ) {
        continue;
      }
      if (draftKey === props.routeDraftId) {
        if (frozenActive.routeDraftId === draftKey && frozenActive.row !== null) {
          rows.push(frozenActive.row);
        }
        continue;
      }
      const composer = draftsByThreadKey[draftKey];
      if (!composer || !composerDraftHasUserContent(composer)) {
        continue;
      }
      rows.push({ draftId: DraftId.make(draftKey), session, composer });
    }
    rows.sort((left, right) => right.session.createdAt.localeCompare(left.session.createdAt));
    return rows;
  }, [
    draftThreadsByThreadKey,
    draftsByThreadKey,
    frozenActive,
    ownsEnvironment,
    props.routeDraftId,
    props.scopedProjectKeys,
  ]);
  if (drafts.length === 0) {
    return null;
  }
  return (
    <>
      {drafts.map(({ composer, draftId, session }) => {
        const projectKey = `${session.environmentId}:${session.projectId}`;
        return (
          <SidebarDraftRow
            key={draftId}
            draftId={draftId}
            composer={composer}
            project={props.projectByKey.get(projectKey) ?? null}
            projectDisplayName={props.projectDisplayNameByKey.get(projectKey) ?? null}
            isActive={draftId === props.routeDraftId}
            onNavigate={props.onNavigateToDraft}
            onDiscard={discardComposerDraft}
            onContextMenu={props.onDraftContextMenu}
          />
        );
      })}
      <li
        aria-hidden
        data-testid="sidebar-draft-divider"
        className="mx-2.5 my-1.5 h-px list-none bg-sidebar-border/60"
      />
    </>
  );
});

const dropVerbBadge: Record<SidebarDropVerb, ReactNode> = {
  pin: (
    <>
      <PinIcon aria-hidden className="size-3" />
      Pin
    </>
  ),
  unpin: (
    <>
      <PinOffIcon aria-hidden className="size-3" />
      Unpin
    </>
  ),
  settle: (
    <>
      <CircleCheckIcon aria-hidden className="size-3" />
      Settle
    </>
  ),
  unsettle: (
    <>
      <Undo2Icon aria-hidden className="size-3" />
      Un-settle
    </>
  ),
  wake: (
    <>
      <AlarmClockOffIcon aria-hidden className="size-3" />
      Wake
    </>
  ),
};

const SidebarThreadRow = memo(function SidebarThreadRow(props: {
  thread: SidebarThreadSummary;
  variant: "card" | "slim";
  nested?: boolean;
  variantAction: SidebarSweepAction;
  settlementSupported: boolean;
  snoozeSupported: boolean;
  pinningSupported: boolean;
  isPinned: boolean;
  sortable?: SortableThreadRowBag | undefined;
  dropVerb: SidebarDropVerb | null;
  dragOverPinned: boolean;
  sweepAction: SidebarSweepAction | null;
  snoozeWakeLabelText: string | null;
  wokeAt: string | null;
  isActive: boolean;
  openPullRequestsInRightPanel: boolean;
  jumpLabel: string | null;
  currentEnvironmentId: string | null;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
  scratchMachineLabel: string | null;
  project: EnvironmentProject | null;
  projectDisplayName: string | null;
  providerEntryByInstanceId: ReadonlyMap<string, ProviderInstanceEntry>;
  timestampFormat: TimestampFormat;
  onThreadClick: (event: ReactMouseEvent, threadRef: ScopedThreadRef) => void;
  onThreadActivate: (threadRef: ScopedThreadRef) => void;
  onStartRename: (threadRef: ScopedThreadRef, title: string) => void;
  onRenameTitleChange: (title: string) => void;
  onCommitRename: (threadRef: ScopedThreadRef, title: string, originalTitle: string) => void;
  onCancelRename: () => void;
  isRenaming: boolean;
  renamingTitle: string;
  onContextMenu: (threadRef: ScopedThreadRef, position: { x: number; y: number }) => void;
  canFork: boolean;
  onFork: (threadRef: ScopedThreadRef) => Promise<boolean>;
  onSettle: (threadRef: ScopedThreadRef) => void;
  onActionSweepStart: (
    threadRef: ScopedThreadRef,
    action: SidebarSweepAction,
    event: PointerEvent,
  ) => void;
  onUnsettle: (threadRef: ScopedThreadRef) => void;
  onSnooze: (threadRef: ScopedThreadRef, preset: Pick<SnoozePreset, "snoozedUntil">) => void;
  onUnsnooze: (threadRef: ScopedThreadRef) => void;
  onUnpin: (threadRef: ScopedThreadRef) => void;
  onAcknowledgeWoke: (threadRef: ScopedThreadRef, visitedAt: string) => void;
  onFileDropThreads?: ((threadRef: ScopedThreadRef, files: File[]) => void) | undefined;
  changeRequestSnapshot: ThreadChangeRequestSnapshot | null;
  onChangeRequestSnapshot: (
    threadKey: string,
    snapshot: ThreadChangeRequestSnapshot | null,
  ) => void;
}) {
  const {
    isRenaming,
    changeRequestSnapshot,
    onChangeRequestSnapshot,
    onCancelRename,
    onCommitRename,
    onContextMenu,
    onAcknowledgeWoke,
    onFileDropThreads,
    onRenameTitleChange,
    onFork,
    onSettle,
    onActionSweepStart,
    onSnooze,
    onStartRename,
    onThreadActivate,
    onThreadClick,
    onUnsettle,
    onUnsnooze,
    onUnpin,
    openPullRequestsInRightPanel,
    renamingTitle,
    thread,
    variant,
    variantAction,
  } = props;
  const threadRef = useMemo(
    () => scopeThreadRef(thread.environmentId, thread.id),
    [thread.environmentId, thread.id],
  );
  const threadKey = scopedThreadKey(threadRef);
  const threadAccountId = useAtomValue(accountByEnvironmentIdAtom).get(thread.environmentId);
  const sidebarAccountStyle = useSidebarAccountStyle();
  const canOperateThread = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  useEffect(() => {
    if (!canOperateThread && isRenaming) onCancelRename();
  }, [canOperateThread, isRenaming, onCancelRename]);
  const { leaseLiveStatus, rowRef } = useSidebarRowSubscriptionLease(props.isActive);
  const [borderRow, setBorderRow] = useState<HTMLElement | null>(null);
  useRevealActiveThread(borderRow, props.isActive);
  const [borderVisible, setBorderVisible] = useState(false);
  const attachRow = useCallback(
    (node: HTMLElement | null) => {
      rowRef(node);
      setBorderRow(node);
    },
    [rowRef],
  );
  const isRegeneratingTitle = thread.titleRegeneration != null;
  const localLastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  const isSelected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));
  const openPrLink = useOpenPrLink();
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const terminalProcessCount = runningTerminalIds.length;
  const hasUnsentDraft = useThreadHasUnsentDraft(threadRef) && !props.isActive;
  const handleDiscardDraftClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      discardComposerDraft(threadRef);
    },
    [threadRef],
  );

  // The row's own project decides where git looks (a Stave space targets its
  // primary repo, not the space root); the project record's workspace root
  // only covers a project that has not loaded yet.
  const threadProject = useProject(
    useMemo(
      () => scopeProjectRef(thread.environmentId, thread.projectId),
      [thread.environmentId, thread.projectId],
    ),
  );
  const gitTarget = resolveThreadGitTarget({
    project: threadProject,
    thread,
    fallbackCwd: props.project?.workspaceRoot ?? null,
  });
  const gitCwd = gitTarget.cwd;
  const staveWorkspace = describeStaveWorkspace(threadProject);
  const pullRequestReference = resolveThreadPullRequestRef(thread, threadProject);
  const linkedPullRequestStatus = useLinkedThreadPullRequest(
    thread.environmentId,
    thread.linkedPullRequest,
    leaseLiveStatus,
    thread.pullRequests,
    // Stave projects infer a branch PR only from a single editable checkout.
    resolveThreadPullRequestRef(
      { linkedPullRequest: null, branchPullRequest: thread.branchPullRequest },
      threadProject,
    ),
  );
  const watches = usePullRequestWatches(leaseLiveStatus ? [thread.environmentId] : []);
  const gitStatus = useEnvironmentQuery(
    leaseLiveStatus && gitTarget.statusEnabled && gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd: gitCwd, includeRemote: false },
        })
      : null,
  );
  const visibleGitStatus = useRetainedValue(
    JSON.stringify([thread.environmentId, gitCwd]),
    gitStatus.data,
  );
  const pr = linkedPullRequestStatus?.pr ?? null;
  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(thread.environmentId);
  const currentLinkedPr = supportsMultiplePullRequests
    ? resolveThreadCurrentPullRequestLink(thread.pullRequests)
    : null;

  const watchProjects = useProjects();
  const pullRequestWatches = selectThreadPullRequestWatches({
    projects: watchProjects,
    environmentId: thread.environmentId,
    thread,
    watches: watches.values
      .filter(([environmentId]) => environmentId === thread.environmentId)
      .flatMap(([, snapshot]) => snapshot.watches),
  });
  const pullRequestLinks = threadPullRequestLinks(
    pullRequestWatches,
    pr
      ? {
          ...pr,
          repository: pullRequestReference?.repository,
        }
      : null,
  );

  const isUnread = hasUnseenCompletion({ ...thread, lastVisitedAt });
  const status = resolveSidebarThreadStatus(thread);
  useEffect(() => {
    if (!borderRow || status !== "working") return;
    let visible = false;
    const sync = () => setBorderVisible(visible && !document.hidden);
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            ([entry]) => {
              visible = entry?.isIntersecting === true;
              sync();
            },
            { root: borderRow.closest<HTMLElement>('[data-slot="scroll-area-viewport"]') },
          );
    observer?.observe(borderRow);
    document.addEventListener("visibilitychange", sync);
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", sync);
      setBorderVisible(false);
    };
  }, [borderRow, status]);
  const isInFlight =
    status === "working" || status === "waiting" || status === "approval" || status === "input";
  const lastVisitedDate = lastVisitedAt === undefined ? null : parseTimestampDate(lastVisitedAt);
  const wokeAtDate = props.wokeAt === null ? null : parseTimestampDate(props.wokeAt);
  const isWoke =
    wokeAtDate !== null &&
    (lastVisitedDate === null || lastVisitedDate < wokeAtDate) &&
    thread.settledOverride !== "settled";
  const shouldRecede = shouldRecedeSidebarThread({
    status,
    isUnread,
    isWoke,
    isActive: props.isActive,
    isSelected,
  });
  const topStatus =
    status === "working"
      ? {
          label: thread.goal?.status === "active" ? "Goal" : "Working",
          icon: "working" as const,
          className: "text-info",
        }
      : status === "waiting"
        ? {
            label: "Waiting",
            icon: "waiting" as const,
            className: "text-muted-foreground",
          }
        : status === "approval"
          ? {
              label: "Approval",
              icon: "approval" as const,
              className: "text-warning-foreground",
            }
          : status === "input"
            ? {
                label: "Input",
                icon: "input" as const,
                className: "text-indigo-600 dark:text-indigo-300",
              }
            : status === "limited"
              ? {
                  label: "Limited",
                  icon: "failed" as const,
                  className: "text-warning",
                }
              : status === "failed"
                ? {
                    label: "Failed",
                    icon: "failed" as const,
                    className: "text-error",
                  }
                : isWoke
                  ? {
                      label: "Woke",
                      icon: "woke" as const,
                      className: "text-warning",
                    }
                  : isUnread
                    ? {
                        label: "Done",
                        icon: "done" as const,
                        className: "text-success",
                      }
                    : null;
  const isWokeStatus = topStatus?.icon === "woke";

  const branchMismatch = resolveLocalCheckoutBranchMismatch({
    effectiveEnvMode: thread.worktreePath === null ? "local" : "worktree",
    activeWorktreePath: thread.worktreePath,
    activeThreadBranch: thread.branch,
    currentGitBranch: visibleGitStatus?.refName ?? null,
  });
  const prStatus = prStatusIndicator(pr, linkedPullRequestStatus?.sourceControlProvider);

  const modelInstanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  const providerEntry = props.providerEntryByInstanceId.get(modelInstanceId) ?? null;
  const showInstanceBadge =
    providerEntry !== null &&
    shouldShowInstanceBadge(providerEntry, props.providerEntryByInstanceId.values());
  const selectedModel = providerEntry?.models.find(
    (model) => model.slug === thread.modelSelection.model,
  );
  const modelLabel = selectedModel
    ? getTriggerDisplayModelLabel(selectedModel)
    : thread.modelSelection.model;

  const isRemote = thread.environmentId !== props.currentEnvironmentId;
  const showsScratchMachine = !thread.branch && props.scratchMachineLabel !== null;

  const detailsTooltip = (
    <SidebarThreadTooltip
      thread={thread}
      project={props.project}
      projectDisplayName={props.projectDisplayName}
      staveWorkspace={staveWorkspace}
      environmentLabel={props.environmentLabel}
      environmentMachine={props.environmentMachine}
      providerEntry={providerEntry}
      providerEntryByInstanceId={props.providerEntryByInstanceId}
      showInstanceBadge={showInstanceBadge}
      modelInstanceId={modelInstanceId}
      modelLabel={modelLabel}
      branchMismatch={branchMismatch}
      terminalStatus={terminalStatus}
      terminalProcessCount={terminalProcessCount}
      pullRequest={pr}
      pullRequestRepository={pullRequestReference?.repository}
      pullRequestWatches={pullRequestWatches}
    />
  );

  const handleClick = useCallback(
    (event: ReactMouseEvent) => {
      onThreadClick(event, threadRef);
    },
    [onThreadClick, threadRef],
  );
  const handleAcknowledgeWokeClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (props.wokeAt === null) return;
      onAcknowledgeWoke(threadRef, props.wokeAt);
    },
    [onAcknowledgeWoke, props.wokeAt, threadRef],
  );
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      onContextMenu(threadRef, { x: event.clientX, y: event.clientY });
    },
    [onContextMenu, threadRef],
  );
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onThreadActivate(threadRef);
    },
    [onThreadActivate, threadRef],
  );
  const handleDoubleClick = useCallback(
    (event: ReactMouseEvent) => {
      if (
        !readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope) ||
        isRenaming ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      if ((event.target as HTMLElement).closest("button, a, input")) return;
      event.preventDefault();
      onStartRename(threadRef, thread.title);
    },
    [isRenaming, onStartRename, thread.title, threadRef],
  );
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const fileDropHandlers = useMemo(
    () =>
      onFileDropThreads
        ? makeWorkspaceFileDropHandlers({
            setDragActive: setIsFileDragOver,
            addFiles: (files) => {
              onFileDropThreads(threadRef, files);
            },
            addFolders: () => {},
          })
        : null,
    [onFileDropThreads, threadRef],
  );
  useEffect(() => {
    if (!isFileDragOver) return;
    const clearFileDrag = () => setIsFileDragOver(false);
    window.addEventListener("dragend", clearFileDrag);
    return () => window.removeEventListener("dragend", clearFileDrag);
  }, [isFileDragOver]);
  const renameCommittedRef = useRef(false);
  useEffect(() => {
    if (isRenaming) renameCommittedRef.current = false;
  }, [isRenaming]);
  const handleRenameKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter") {
        event.preventDefault();
        renameCommittedRef.current = true;
        onCommitRename(threadRef, renamingTitle, thread.title);
      } else if (event.key === "Escape") {
        event.preventDefault();
        renameCommittedRef.current = true;
        onCancelRename();
      }
    },
    [onCancelRename, onCommitRename, renamingTitle, thread.title, threadRef],
  );
  const handleRenameBlur = useCallback(() => {
    if (!renameCommittedRef.current) {
      onCommitRename(threadRef, renamingTitle, thread.title);
    }
  }, [onCommitRename, renamingTitle, thread.title, threadRef]);
  const [isForking, setIsForking] = useState(false);
  const forkInFlightRef = useRef(false);
  const handleForkClick = async (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (forkInFlightRef.current) return;
    forkInFlightRef.current = true;
    setIsForking(true);
    try {
      await onFork(threadRef);
    } finally {
      forkInFlightRef.current = false;
      setIsForking(false);
    }
  };
  const handleSettleClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onSettle(threadRef);
    },
    [onSettle, threadRef],
  );
  const handleActionPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      if (!event.isPrimary || event.button !== 0) return;
      event.stopPropagation();
      onActionSweepStart(threadRef, variantAction, event.nativeEvent);
    },
    [onActionSweepStart, threadRef, variantAction],
  );
  const handleUnsettleClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onUnsettle(threadRef);
    },
    [onUnsettle, threadRef],
  );
  const handleUnsnoozeClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onUnsnooze(threadRef);
    },
    [onUnsnooze, threadRef],
  );
  const handleUnpinClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onUnpin(threadRef);
    },
    [onUnpin, threadRef],
  );
  const handleSnoozePreset = useCallback(
    (preset: Pick<SnoozePreset, "snoozedUntil">) => {
      onSnooze(threadRef, preset);
    },
    [onSnooze, threadRef],
  );
  const [snoozeMenuOpenRaw, setSnoozeMenuOpen] = useState(false);
  const showSnoozeButton =
    canOperateThread &&
    props.snoozeSupported &&
    canSnooze(thread, { now: new Date().toISOString() });
  const showHoverActions =
    (canOperateThread && props.settlementSupported) || showSnoozeButton || hasUnsentDraft;
  const snoozeMenuOpen = snoozeMenuOpenRaw && showSnoozeButton;
  useEffect(() => {
    if (!showSnoozeButton) setSnoozeMenuOpen(false);
  }, [showSnoozeButton]);
  const handlePrClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>, targetUrl?: string) => {
      const url = targetUrl ?? pr?.url ?? currentLinkedPr?.url;
      if (!url) return;
      const showInRightPanel = targetUrl !== undefined || openPullRequestsInRightPanel;
      const openedInRightPanel = openPrLink(event, url, showInRightPanel ? threadRef : undefined);
      if (openedInRightPanel && showInRightPanel && !props.isActive) {
        onThreadActivate(threadRef);
      }
    },
    [
      onThreadActivate,
      openPrLink,
      openPullRequestsInRightPanel,
      pr,
      currentLinkedPr,
      props.isActive,
      threadRef,
    ],
  );

  const rowSurfaceClassName = cn(
    "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    status === "working" && "lecturn-thread-active",
    status === "working" && borderVisible && "lecturn-thread-active-visible",
    variantAction === "unsettle" && "[&:not(:hover):not(:focus-within)_*]:text-secondary-label/70",
    props.isActive
      ? "bg-sidebar-row-active text-sidebar-foreground"
      : isSelected || props.sweepAction !== null
        ? "bg-sidebar-row-selected text-sidebar-foreground"
        : hasUnsentDraft
          ? cn(draftSurfaceClassName, "text-sidebar-foreground")
          : shouldRecede
            ? "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
            : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
    shouldRecede &&
      status === "working" &&
      "opacity-70 transition-opacity hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none",
    isFileDragOver && "ring-1 ring-inset ring-primary/70",
    isFileDragOver && !props.isActive && !isSelected && "bg-sidebar-row-hover",
    props.sortable?.isDragging &&
      "bg-sidebar bg-linear-to-b from-sidebar-row-active to-sidebar-row-active text-sidebar-foreground opacity-100 shadow-lg",
  );
  const sortable = props.sortable;
  const sortableRootProps = sortable
    ? {
        ref: sortable.setNodeRef,
        style: {
          transform: CSS.Translate.toString(sortable.transform),
          transition: sortable.transition,
          // A zero-height boundary also makes dnd-kit scale the source to
          // zero. Only projected peers use scaleY as a visibility sentinel.
          visibility:
            !sortable.isDragging && sortable.transform?.scaleY === 0
              ? ("hidden" as const)
              : undefined,
        },
        ...sortable.listeners,
      }
    : { style: {} };
  const destinationVerb = sortable?.isDragging
    ? props.dropVerb
    : props.sweepAction === "unsnooze"
      ? "wake"
      : props.sweepAction;
  const dragDestination =
    destinationVerb !== null ? (
      <span
        role="status"
        className="pointer-events-none ml-auto inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-1.5 text-2xs font-medium text-primary"
      >
        {dropVerbBadge[destinationVerb]}
      </span>
    ) : null;

  const accessibility = resolveSidebarRowAccessibility({
    title: thread.title,
    statusLabel: topStatus?.label ?? null,
    projectDisplayName: props.projectDisplayName,
    isActive: props.isActive,
  });

  const title =
    isRenaming && canOperateThread ? (
      <input
        autoFocus
        value={renamingTitle}
        aria-label="Thread title"
        onChange={(event) => onRenameTitleChange(event.target.value)}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={handleRenameKeyDown}
        onBlur={handleRenameBlur}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        className="min-w-0 flex-1 rounded-sm border border-input bg-card px-1 text-sm font-medium text-card-foreground outline-none focus:border-foreground"
      />
    ) : (
      <span
        aria-hidden
        className={cn(
          "min-w-0 flex-1 text-sm transition-opacity motion-reduce:transition-none",
          shouldRecede ? "font-normal" : "font-medium",
          variant === "card"
            ? cn(
                "truncate",
                shouldRecede
                  ? "text-secondary-label"
                  : isUnread || isWoke || status === "input"
                    ? "text-foreground"
                    : status === "failed"
                      ? "text-foreground/95"
                      : "text-foreground/90",
              )
            : cn(
                "truncate group-focus-within/sidebar-row:text-foreground group-hover/sidebar-row:text-foreground",
                shouldRecede
                  ? "text-secondary-label/70"
                  : props.isActive || isWoke || status === "input"
                    ? "text-foreground"
                    : isUnread
                      ? "text-muted-foreground"
                      : "text-secondary-label/70",
              ),
          variantAction === "unsettle" && "lecturn-settled-label",
          isRegeneratingTitle && "opacity-55",
        )}
      >
        {thread.title}
      </span>
    );
  const accessibleTitle = isRenaming ? null : <span className="sr-only">{thread.title}</span>;

  // Server-linked pull requests use the shared badge: a stack shows its layer
  // count and several unrelated links their total, colored by aggregate state;
  // either opens the thread's pull requests tab. Otherwise the watched and
  // branch PRs stay individual links. All are real links so cmd/ctrl+click and
  // middle-click open the host in the browser; a plain click still opens
  // Lecturn's pull request view.
  const prBadgeShape = supportsMultiplePullRequests
    ? resolveThreadPullRequestBadge(thread.pullRequests)
    : null;
  const handlePrListClick = useCallback(() => {
    useRightPanelStore.getState().open(threadRef, "pull-requests");
    if (!props.isActive) onThreadActivate(threadRef);
  }, [onThreadActivate, props.isActive, threadRef]);
  const multiplePrRepositories =
    new Set(pullRequestLinks.map((request) => request.repository)).size > 1;
  const prBadge =
    prBadgeShape !== null ? (
      <ThreadPullRequestBadgeControl
        render={<InlineButton />}
        badge={prBadgeShape}
        pullRequests={thread.pullRequests}
        number={pr?.number ?? currentLinkedPr?.number}
        url={pr?.url ?? currentLinkedPr?.url}
        status={prStatus}
        onOpenList={handlePrListClick}
        onOpenPullRequest={handlePrClick}
      />
    ) : pullRequestLinks.length > 0 ? (
      <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
        {pullRequestLinks.map((request) => {
          const presentation =
            request.state === "unknown"
              ? null
              : prStatusIndicator(
                  {
                    ...request,
                    state: request.state,
                    baseRef: request.watch?.observation?.baseBranch ?? "",
                    headRef: "",
                  },
                  linkedPullRequestStatus?.sourceControlProvider,
                );
          const context = request.repository || request.url;
          return (
            <a
              key={request.key}
              href={request.url}
              target="_blank"
              rel="noopener noreferrer"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => handlePrClick(event, request.url)}
              className={cn(
                "shrink-0 text-xs tabular-nums hover:underline",
                presentation?.colorClass ?? "text-muted-foreground",
              )}
              aria-label={`${context} #${request.number} · ${request.state}: ${request.title}`}
            >
              {multiplePrRepositories && request.repository ? `${request.repository} ` : ""}#
              {request.number}
            </a>
          );
        })}
      </span>
    ) : null;
  const terminalStatusIcon = (
    <ThreadTerminalStatusButton
      threadRef={threadRef}
      terminalIds={runningTerminalIds}
      onThreadActivate={onThreadActivate}
    />
  );
  const draftIndicator = hasUnsentDraft ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label="Unsent draft"
            data-testid={`sidebar-draft-indicator-${thread.id}`}
            className="inline-flex shrink-0 items-center"
          />
        }
      >
        <SquarePenIcon aria-hidden className={draftPenClassName} />
      </TooltipTrigger>
      <TooltipPopup side="top">Unsent draft</TooltipPopup>
    </Tooltip>
  ) : null;
  const showPin =
    props.isPinned && (!sortable?.isDragging || (props.dragOverPinned && props.dropVerb === null));
  const pinIndicator = showPin ? (
    props.pinningSupported && canOperateThread && !sortable?.isDragging ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="Unpin thread"
              onClick={handleUnpinClick}
              className="group/unpin inline-flex cursor-pointer items-center rounded-sm text-muted-foreground/65 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            />
          }
        >
          <PinIcon
            aria-hidden
            className="size-3 shrink-0 group-hover/unpin:hidden group-focus-visible/unpin:hidden"
          />
          <PinOffIcon
            aria-hidden
            className="hidden size-3 shrink-0 group-hover/unpin:block group-focus-visible/unpin:block"
          />
        </TooltipTrigger>
        <TooltipPopup>Unpin thread</TooltipPopup>
      </Tooltip>
    ) : (
      <PinIcon
        aria-label="Pinned"
        role="img"
        className="size-3 shrink-0 text-muted-foreground/65"
      />
    )
  ) : null;

  if (variant === "slim") {
    return (
      <li
        data-thread-item={threadKey}
        {...sortableRootProps}
        style={{
          ...("style" in sortableRootProps ? sortableRootProps.style : {}),
          ...sidebarAccountStyle([thread.environmentId]),
        }}
        {...(fileDropHandlers ?? {})}
        className={cn(
          "list-none [content-visibility:auto] [contain-intrinsic-size:auto_36px]",
          sortable?.isDragging && "relative z-20",
        )}
      >
        <Tooltip disabled={sortable?.isDragging}>
          <TooltipTrigger
            render={
              <div
                ref={attachRow}
                role="button"
                tabIndex={0}
                aria-label={accessibility.label}
                aria-current={accessibility.current}
                data-lecturn-thread-surface
                data-thread-project={`${thread.environmentId}:${thread.projectId}`}
                data-thread-account={threadAccountId}
                data-thread-active={props.isActive || undefined}
                data-account-selected={props.isActive || isSelected || undefined}
                data-testid="sidebar-row-slim"
                aria-busy={isRegeneratingTitle || undefined}
                className={cn(rowSurfaceClassName, "flex h-9 items-center gap-2.5 px-2.5")}
                onClick={handleClick}
                onDoubleClick={handleDoubleClick}
                onKeyDown={handleKeyDown}
                onContextMenu={handleContextMenu}
              />
            }
          >
            {accessibleTitle}
            {!props.nested && props.project ? (
              <ProjectFavicon project={props.project} className="size-4 shrink-0" />
            ) : null}
            {draftIndicator}
            {variantAction === "unsettle" ? (
              <CircleCheckIcon
                role="img"
                aria-label="Settled"
                className="lecturn-settled-label size-3.5 shrink-0"
              />
            ) : null}
            {title}
            <AccountMark environmentId={thread.environmentId} />
            {pinIndicator}
            {terminalStatusIcon}
            {isRegeneratingTitle ? (
              <span role="status" className="sr-only">
                Regenerating title
              </span>
            ) : null}
            {prBadge}
            {sortable?.isDragging ? (
              dragDestination
            ) : (
              <span
                className={cn(
                  "relative ml-auto flex h-6 min-w-8 shrink-0 items-center justify-end",
                  props.sweepAction !== null && "hidden",
                )}
              >
                <span
                  className={cn(
                    "inline-flex justify-end tabular-nums text-secondary-label transition-opacity",
                    !isWoke && "group-any-hover/sidebar-row:opacity-0",
                  )}
                >
                  {variantAction === "unsnooze" && props.snoozeWakeLabelText !== null ? (
                    <span className="text-xs text-info-foreground tabular-nums">
                      {props.snoozeWakeLabelText}
                    </span>
                  ) : isWoke ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            aria-label="Dismiss Woke notification"
                            onClick={handleAcknowledgeWokeClick}
                            className="inline-flex cursor-pointer items-center gap-1 rounded-sm text-xs font-medium text-warning-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                          >
                            <AlarmClockIcon aria-hidden className="size-3" />
                            <span role="status">Woke</span>
                          </button>
                        }
                      />
                      <TooltipPopup side="top">Dismiss Woke notification</TooltipPopup>
                    </Tooltip>
                  ) : (
                    <span className="text-xs">
                      {variantAction === "unsettle"
                        ? settledTimeLabel(thread)
                        : threadTimeLabel(thread)}
                    </span>
                  )}
                </span>
                {variantAction === "unsnooze" ? (
                  !props.snoozeSupported ? null : (
                    <button
                      type="button"
                      aria-label="Wake thread now"
                      onClick={handleUnsnoozeClick}
                      onPointerDown={handleActionPointerDown}
                      className={cn(
                        "pointer-events-none absolute inset-y-0 right-0 -mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100",
                        isWoke && "group-any-hover/sidebar-row:static",
                      )}
                    >
                      <AlarmClockOffIcon className="mb-px size-3" />
                    </button>
                  )
                ) : !props.settlementSupported ? null : variantAction === "unsettle" ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          aria-label="Un-settle thread"
                          onClick={handleUnsettleClick}
                          onPointerDown={handleActionPointerDown}
                          className={cn(
                            "pointer-events-none absolute inset-y-0 right-0 -mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100",
                            isWoke && "group-any-hover/sidebar-row:static",
                          )}
                        />
                      }
                    >
                      <Undo2Icon className="mb-px size-3.5" />
                    </TooltipTrigger>
                    <TooltipPopup side="top">Un-settle thread</TooltipPopup>
                  </Tooltip>
                ) : (
                  <button
                    type="button"
                    aria-label="Settle thread"
                    onClick={handleSettleClick}
                    onPointerDown={handleActionPointerDown}
                    className={cn(
                      "pointer-events-none absolute inset-y-0 right-0 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-2 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100",
                      isWoke && "group-any-hover/sidebar-row:static",
                    )}
                  >
                    <CheckIcon className="size-3" />
                  </button>
                )}
              </span>
            )}
            {props.sweepAction !== null ? dragDestination : null}
            {props.jumpLabel ? <JumpHintBadge label={props.jumpLabel} /> : null}
          </TooltipTrigger>
          {detailsTooltip}
        </Tooltip>
      </li>
    );
  }

  const diff = latestRunDiff(thread);

  return (
    <li
      data-thread-item={threadKey}
      {...sortableRootProps}
      style={{
        ...("style" in sortableRootProps ? sortableRootProps.style : {}),
        ...sidebarAccountStyle([thread.environmentId]),
      }}
      {...(fileDropHandlers ?? {})}
      className={cn(
        "list-none py-0.5 [content-visibility:auto] [contain-intrinsic-size:auto_78px]",
        sortable?.isDragging && "relative z-20",
      )}
    >
      <Tooltip disabled={snoozeMenuOpen || sortable?.isDragging}>
        <TooltipTrigger
          render={
            <div
              ref={attachRow}
              role="button"
              tabIndex={0}
              aria-label={accessibility.label}
              aria-current={accessibility.current}
              data-lecturn-thread-surface
              data-thread-project={`${thread.environmentId}:${thread.projectId}`}
              data-thread-account={threadAccountId}
              data-thread-active={props.isActive || undefined}
              data-account-selected={props.isActive || isSelected || undefined}
              data-testid="sidebar-row-card"
              aria-busy={isRegeneratingTitle || status === "working" || undefined}
              className={rowSurfaceClassName}
              onClick={handleClick}
              onDoubleClick={handleDoubleClick}
              onKeyDown={handleKeyDown}
              onContextMenu={handleContextMenu}
            />
          }
        >
          {accessibleTitle}
          <div
            className={cn(
              "relative z-10 px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)",
              props.nested ? "min-h-[3.25rem]" : "h-[4.875rem]",
            )}
          >
            <div className="flex h-5 min-w-0 items-center gap-1.5">
              {draftIndicator}
              {!props.nested && props.project ? (
                <ProjectFavicon project={props.project} className="size-4 shrink-0" />
              ) : null}
              {props.nested ? (
                title
              ) : props.projectDisplayName ? (
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-secondary-label text-xs",
                    shouldRecede ? "font-normal" : "font-medium",
                  )}
                >
                  {props.projectDisplayName}
                </span>
              ) : (
                <span className="flex-1" />
              )}
              <AccountMark environmentId={thread.environmentId} />
              {pinIndicator}
              {sortable?.isDragging ? (
                dragDestination
              ) : (
                <span
                  className={cn(
                    "group/sidebar-status-slot relative ml-auto flex h-5 min-w-8 shrink-0 items-stretch justify-end text-xs",
                    props.sweepAction !== null && "hidden",
                  )}
                >
                  <span
                    className={cn(
                      isWokeStatus
                        ? "pointer-events-auto"
                        : "pointer-events-none group-has-[:focus-visible]/sidebar-status-slot:absolute group-has-[:focus-visible]/sidebar-status-slot:right-0 group-has-[:focus-visible]/sidebar-status-slot:opacity-0 group-any-hover/sidebar-row:absolute group-any-hover/sidebar-row:right-0 group-any-hover/sidebar-row:opacity-0",
                      "flex items-center self-center justify-self-end tabular-nums text-secondary-label transition-opacity",
                      snoozeMenuOpen && "pointer-events-none absolute right-0 opacity-0",
                    )}
                  >
                    {topStatus && status !== "working" ? (
                      isWokeStatus ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <button
                                type="button"
                                aria-label="Dismiss Woke notification"
                                onClick={handleAcknowledgeWokeClick}
                                className={cn(
                                  "inline-flex cursor-pointer items-center gap-1 rounded-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                                  topStatus.className,
                                )}
                              >
                                <AlarmClockIcon aria-hidden className="size-4 shrink-0" />
                                <span role="status">{topStatus.label}</span>
                              </button>
                            }
                          />
                          <TooltipPopup side="top">Dismiss Woke notification</TooltipPopup>
                        </Tooltip>
                      ) : (
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 font-medium",
                            topStatus.className,
                          )}
                        >
                          {topStatus.icon === "working" ? (
                            <CircleDashedIcon aria-hidden className="size-4 shrink-0" />
                          ) : topStatus.icon === "waiting" ? (
                            <CircleDotDashedIcon aria-hidden className="size-4 shrink-0" />
                          ) : topStatus.icon === "input" ? (
                            <MessageCircleQuestionIcon aria-hidden className="size-4 shrink-0" />
                          ) : topStatus.icon === "approval" ? (
                            <ShieldQuestionIcon aria-hidden className="size-4 shrink-0" />
                          ) : topStatus.icon === "failed" ? (
                            <CircleAlertIcon aria-hidden className="size-4 shrink-0" />
                          ) : topStatus.icon === "done" ? (
                            <CircleCheckIcon aria-hidden className="size-4 shrink-0" />
                          ) : null}
                          {/* The label alone is the live region: a role="status"
                            wrapper around the ticking duration would make
                            screen readers announce every second. */}
                          <span role="status">{topStatus.label}</span>
                        </span>
                      )
                    ) : (
                      threadTimeLabel(thread)
                    )}
                  </span>
                  {props.settlementSupported || showSnoozeButton || hasUnsentDraft ? (
                    <span
                      className={cn(
                        // focus-visible, not focus-within: a mouse click leaves
                        // the Settle button focused, and a plain focus-within
                        // would keep the controls pinned over the status label
                        // once the pointer moves away (e.g. after a failed
                        // settle) instead of cross-fading back.
                        "pointer-events-none absolute inset-y-0 right-0 flex items-stretch opacity-0 transition-opacity has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:static has-[:focus-visible]:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:static group-any-hover/sidebar-row:opacity-100",
                        snoozeMenuOpen && "pointer-events-auto static opacity-100",
                      )}
                    >
                      {hasUnsentDraft ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <button
                                type="button"
                                aria-label="Discard draft"
                                onClick={handleDiscardDraftClick}
                                className="inline-flex cursor-pointer items-center rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
                              />
                            }
                          >
                            <XIcon className="size-3.5" />
                          </TooltipTrigger>
                          <TooltipPopup side="top">Discard draft</TooltipPopup>
                        </Tooltip>
                      ) : null}
                      {showSnoozeButton ? (
                        <SnoozeMenuButton
                          open={snoozeMenuOpen}
                          onOpenChange={setSnoozeMenuOpen}
                          onSnooze={handleSnoozePreset}
                          timestampFormat={props.timestampFormat}
                        />
                      ) : null}
                      {props.settlementSupported ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <button
                                type="button"
                                aria-label="Settle thread"
                                onClick={handleSettleClick}
                                onPointerDown={handleActionPointerDown}
                                className="-mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
                              />
                            }
                          >
                            <CheckIcon className="size-3.5" />
                            Settle
                          </TooltipTrigger>
                          <TooltipPopup>Settle thread</TooltipPopup>
                        </Tooltip>
                      ) : null}
                    </span>
                  ) : null}
                </span>
              )}
              {props.sweepAction !== null ? dragDestination : null}
            </div>
            {!props.nested ? (
              <div className="mt-1 flex min-w-0">
                {title}
                {isRegeneratingTitle ? (
                  <span role="status" className="sr-only">
                    Regenerating title
                  </span>
                ) : null}
              </div>
            ) : null}
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-secondary-label text-xs">
              {props.canFork && !sortable?.isDragging ? (
                <span className="flex shrink-0 items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          aria-label="Fork thread"
                          aria-busy={isForking || undefined}
                          disabled={isForking}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={handleForkClick}
                          className={cn(
                            "pointer-events-none inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-md bg-transparent text-muted-foreground opacity-0 outline-none transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring group-focus-visible/sidebar-row:pointer-events-auto group-focus-visible/sidebar-row:opacity-100 group-has-[:focus-visible]/sidebar-row:pointer-events-auto group-has-[:focus-visible]/sidebar-row:opacity-100 group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:opacity-100 disabled:cursor-wait",
                            isForking && "opacity-100",
                          )}
                        />
                      }
                    >
                      <GitForkIcon aria-hidden className="size-3.5" />
                    </TooltipTrigger>
                    <TooltipPopup side="top">
                      Fork thread at the latest completed reply
                    </TooltipPopup>
                  </Tooltip>
                </span>
              ) : null}
              {/* Stave threads span the space; their primary Git branch is only
                  one repo inside that workspace. */}
              {staveWorkspace && props.nested ? (
                <span className="flex-1" />
              ) : staveWorkspace ? (
                <>
                  <StaveIcon aria-hidden className="size-3 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1 truncate whitespace-nowrap">
                    {staveWorkspace.label}
                  </span>
                </>
              ) : thread.branch ? (
                <>
                  <ThreadWorktreeIndicator thread={thread} />
                  <span className="flex min-w-0 flex-1 text-muted-foreground/40">
                    <MiddleTruncate value={thread.branch} showTitle={false} />
                  </span>
                </>
              ) : showsScratchMachine ? (
                <>
                  <EnvironmentMachineIcon
                    aria-hidden
                    kind={props.environmentMachine}
                    className="size-3 shrink-0 text-muted-foreground/40"
                  />
                  <span className="min-w-0 flex-1 truncate text-muted-foreground/40">
                    {props.scratchMachineLabel}
                  </span>
                </>
              ) : (
                <span className="flex-1" />
              )}
              {terminalStatusIcon}
              {prBadge}
              {diff ? (
                <span className="shrink-0 font-mono">
                  <span className="text-diff-addition-foreground">
                    +{formatDiffCount(diff.insertions)}
                  </span>{" "}
                  <span className="text-diff-deletion-foreground">
                    −{formatDiffCount(diff.deletions)}
                  </span>
                </span>
              ) : null}
              <span
                aria-hidden
                className="pointer-events-none ml-auto inline-flex shrink-0 items-center gap-1"
              >
                {isRemote && !showsScratchMachine ? (
                  <span className="inline-flex shrink-0 items-center text-sidebar-muted-foreground/70">
                    <EnvironmentMachineIcon
                      aria-hidden
                      kind={props.environmentMachine}
                      className="size-3.5"
                    />
                  </span>
                ) : null}
                <SidebarProviderStack
                  thread={thread}
                  providerEntryByInstanceId={props.providerEntryByInstanceId}
                />
              </span>
            </div>
          </div>
          {props.jumpLabel ? <JumpHintBadge label={props.jumpLabel} /> : null}
        </TooltipTrigger>
        {detailsTooltip}
      </Tooltip>
    </li>
  );
});

function latestRunDiff(
  thread: SidebarThreadSummary,
): { insertions: number; deletions: number } | null {
  void thread;
  return null;
}

const SidebarSearchResultRow = memo(function SidebarSearchResultRow(props: {
  isSettled: boolean;
  thread: SidebarThreadSummary;
  project: EnvironmentProject | null;
  projectDisplayName: string | null;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
  providerEntryByInstanceId: ReadonlyMap<string, ProviderInstanceEntry>;
  isHighlighted: boolean;
  isRouteActive: boolean;
  resultId: string;
  searchMatch: EnvironmentThreadSearchMatch | null;
  searchQuery: string;
  onHighlight: () => void;
  onSelect: () => void;
  onFileDropThreads: (threadRef: ScopedThreadRef, files: File[]) => void;
}) {
  const { thread } = props;
  const accessibility = resolveSidebarRowAccessibility({
    title: thread.title,
    statusLabel: null,
    projectDisplayName: props.projectDisplayName,
    isActive: props.isRouteActive,
  });
  const threadRef = useMemo(
    () => scopeThreadRef(thread.environmentId, thread.id),
    [thread.environmentId, thread.id],
  );
  const { leaseLiveStatus, rowRef } = useSidebarRowSubscriptionLease(
    props.isHighlighted || props.isRouteActive,
  );
  const threadProject = useProject(
    useMemo(
      () => scopeProjectRef(thread.environmentId, thread.projectId),
      [thread.environmentId, thread.projectId],
    ),
  );
  const gitTarget = resolveThreadGitTarget({
    project: threadProject,
    thread,
    fallbackCwd: props.project?.workspaceRoot ?? null,
  });
  const gitCwd = gitTarget.cwd;
  const gitStatus = useEnvironmentQuery(
    leaseLiveStatus && gitTarget.statusEnabled && gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd: gitCwd, includeRemote: false },
        })
      : null,
  );
  const visibleGitStatus = useRetainedValue(
    JSON.stringify([thread.environmentId, gitCwd]),
    gitStatus.data,
  );
  const branchMismatch = resolveLocalCheckoutBranchMismatch({
    effectiveEnvMode: thread.worktreePath === null ? "local" : "worktree",
    activeWorktreePath: thread.worktreePath,
    activeThreadBranch: thread.branch,
    currentGitBranch: visibleGitStatus?.refName ?? null,
  });
  const modelInstanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  const providerEntry = props.providerEntryByInstanceId.get(modelInstanceId) ?? null;
  const showInstanceBadge =
    providerEntry !== null &&
    shouldShowInstanceBadge(providerEntry, props.providerEntryByInstanceId.values());
  const selectedModel = providerEntry?.models.find(
    (model) => model.slug === thread.modelSelection.model,
  );
  const modelLabel = selectedModel
    ? getTriggerDisplayModelLabel(selectedModel)
    : thread.modelSelection.model;
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const fileDropHandlers = useMemo(
    () =>
      makeWorkspaceFileDropHandlers({
        setDragActive: setIsFileDragOver,
        addFiles: (files) => {
          props.onFileDropThreads(threadRef, files);
        },
        addFolders: () => {},
      }),
    [props.onFileDropThreads, threadRef],
  );
  useEffect(() => {
    if (!isFileDragOver) return;
    const clearFileDrag = () => setIsFileDragOver(false);
    window.addEventListener("dragend", clearFileDrag);
    return () => window.removeEventListener("dragend", clearFileDrag);
  }, [isFileDragOver]);
  return (
    <li role="presentation" className="list-none" {...fileDropHandlers}>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              ref={rowRef}
              id={props.resultId}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={props.isHighlighted}
              aria-current={accessibility.current}
              aria-describedby={`${props.resultId}-pr`}
              aria-label={accessibility.label}
              onMouseMove={props.onHighlight}
              onClick={props.onSelect}
              className={cn(
                "group/sidebar-row group/v2-row flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1 text-left text-sm outline-none",
                props.isHighlighted || props.isRouteActive
                  ? "bg-sidebar-row-active text-sidebar-foreground"
                  : "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                isFileDragOver && "ring-1 ring-inset ring-primary/70",
                isFileDragOver && !props.isRouteActive && "bg-sidebar-row-hover",
              )}
            />
          }
        >
          {props.project ? (
            <ProjectFavicon
              project={props.project}
              className={cn(
                "size-4 shrink-0 transition-opacity",
                props.isSettled &&
                  !props.isRouteActive &&
                  !props.isHighlighted &&
                  "opacity-40 grayscale group-hover/sidebar-row:opacity-100 group-hover/sidebar-row:grayscale-0",
              )}
            />
          ) : null}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-2.5">
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  props.isSettled
                    ? "font-normal text-secondary-label/70 group-hover/sidebar-row:text-foreground"
                    : "font-medium text-foreground",
                  (props.isHighlighted || props.isRouteActive) && "text-foreground",
                  thread.titleRegeneration != null && "opacity-55",
                )}
              >
                {thread.title}
              </span>
              <span id={`${props.resultId}-pr`} className="contents">
                <ThreadSearchPullRequestNumber
                  thread={thread}
                  query={props.searchQuery}
                  enabled={leaseLiveStatus}
                  settled={props.isSettled}
                />
              </span>
              <span className="w-8 shrink-0 text-right text-xs text-muted-foreground/55 tabular-nums">
                {threadTimeLabel(thread)}
              </span>
            </span>
            {props.searchMatch ? (
              <ThreadSearchMatchExcerpt
                match={{
                  source: props.searchMatch.source,
                  snippet: props.searchMatch.snippet,
                  query: props.searchQuery,
                }}
              />
            ) : null}
          </span>
        </TooltipTrigger>
        <SidebarThreadTooltip
          thread={thread}
          project={props.project}
          projectDisplayName={props.projectDisplayName}
          staveWorkspace={describeStaveWorkspace(threadProject)}
          environmentLabel={props.environmentLabel}
          environmentMachine={props.environmentMachine}
          providerEntry={providerEntry}
          providerEntryByInstanceId={props.providerEntryByInstanceId}
          showInstanceBadge={showInstanceBadge}
          modelInstanceId={modelInstanceId}
          modelLabel={modelLabel}
          branchMismatch={branchMismatch}
          terminalStatus={terminalStatus}
          terminalProcessCount={runningTerminalIds.length}
        />
      </Tooltip>
    </li>
  );
});

export default function Sidebar() {
  const sidebarAccountStyle = useSidebarAccountStyle();
  // Archived Stave spaces (and their threads) leave the sidebar; they come
  // back through New project → Stave.
  const { projects, archivedProjectKeys } = useListedProjects();
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const threads = useThreadShells();
  const reservedThreadOrderKeys = useMemo(
    () => ({
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
    }),
    [threads],
  );
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
  const openAddProjectCommandPalette = useCallback(
    () => openCommandPalette({ open: "add-project" }),
    [],
  );
  const environments = useEnvironmentIdentities();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const toggleThreadSelection = useThreadSelectionStore((s) => s.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((s) => s.rangeSelectTo);
  const acknowledgeWoke = useAcknowledgeThreadWoke();
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeDraftThread = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const routeThreadRef = useMemo(
    () => resolveActiveThreadRouteRef(routeTarget, routeDraftThread),
    [routeDraftThread, routeTarget],
  );
  const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;
  const routeTargetRef = useRef(routeTarget);
  routeTargetRef.current = routeTarget;
  const routeThreadKeyRef = useRef(routeThreadKey);
  routeThreadKeyRef.current = routeThreadKey;

  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const environmentMachineById = useEnvironmentMachines();
  const orderedProjects = useMemo(
    () =>
      orderItemsByPreferredIds({
        items: projects,
        preferredIds: projectOrder,
        getId: getProjectOrderKey,
        getPreferenceIds: (project) => [
          getProjectOrderKey(project),
          legacyProjectCwdPreferenceKey(project.workspaceRoot),
        ],
      }),
    [projectOrder, projects],
  );
  const sidebarSegmentation = useSidebarSegmentation();
  const unsortedProjectGroups = useMemo(
    () =>
      snapshotsPerAccount(
        sidebarSegmentation,
        buildSidebarProjectSnapshots,
      )({
        projects: sidebarProjectSortOrder === "manual" ? orderedProjects : projects,
        groupScratchProjects: true,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
      }),
    [
      environmentLabelById,
      orderedProjects,
      primaryEnvironmentId,
      projectGroupingSettings,
      projects,
      sidebarProjectSortOrder,
      sidebarSegmentation,
    ],
  );
  const projectGroups = useMemo(
    () => sortSidebarV2ProjectGroups(unsortedProjectGroups, threads, sidebarProjectSortOrder),
    [sidebarProjectSortOrder, threads, unsortedProjectGroups],
  );
  const {
    tree: sagaTree,
    navigationProjects,
    nest: nestSagaProjects,
  } = useSagaSidebarTree(projectGroups);
  const [collapsedProjectKeys, setCollapsedProjectKeys] = useState<ReadonlySet<string>>(new Set());
  const navigationProjectByKey = useMemo(
    () => new Map(navigationProjects.map((project) => [project.projectKey, project])),
    [navigationProjects],
  );
  const toggleProject = (key: string) =>
    setCollapsedProjectKeys((old) => {
      const next = new Set(old);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const projectGroupsRef = useRef(projectGroups);
  projectGroupsRef.current = projectGroups;
  // Threads on non-primary environments (Lecturn Connect, hosted) resolve their
  // provider entry from their own environment's config: default instance ids
  // are driver slugs, so a flat map would collide across environments.
  const providerEntriesByEnvironment = useMemo(
    () =>
      deriveProviderEntriesByEnvironment(
        [...serverConfigs].map(
          ([environmentId, config]) => [environmentId, config.providers, config.settings] as const,
        ),
      ),
    [serverConfigs],
  );
  const projectByKey = useMemo(
    () => new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project])),
    [projects],
  );
  const projectDisplayNameByKey = useMemo(
    () =>
      new Map(
        projectGroups.flatMap((group) =>
          group.memberProjects.map(
            (project) => [`${project.environmentId}:${project.id}`, group.displayName] as const,
          ),
        ),
      ),
    [projectGroups],
  );

  const nowMinute = useNowMinute();
  const changeRequestSnapshotByKey = useAtomValue(threadChangeRequestSnapshotsAtom);
  // Snooze wake times are second-precise, so classifying with the quantized
  // minute would hold a woken thread on the shelf for up to a minute.
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);

  const persistedProjectScopeKey = useUiStateStore((store) => store.sidebarProjectScopeKey);
  const setProjectScopeKey = useUiStateStore((store) => store.setSidebarProjectScopeKey);
  const projectScopeKey = useMemo(
    () =>
      resolveSidebarProjectScopeKey({
        groups: projectGroups,
        key: persistedProjectScopeKey,
        settings: projectGroupingSettings,
      }),
    [persistedProjectScopeKey, projectGroups, projectGroupingSettings],
  );
  const projectScopeItems = useMemo(
    () => [
      { value: "all", label: "All projects" },
      ...nameGroupsByAccount(sidebarSegmentation, projectGroups).map((project) => ({
        value: project.projectKey,
        label: project.displayName,
      })),
    ],
    [projectGroups, sidebarSegmentation],
  );
  const showProjectEnvironments = useMemo(
    () => projectGroupsSpanEnvironments(projectGroups),
    [projectGroups],
  );
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
  const projectGroupByScopeKey = useMemo(
    () => new Map(projectGroups.map((project) => [project.projectKey, project] as const)),
    [projectGroups],
  );
  const selectedProjectScopeItem = useMemo(
    () =>
      projectScopeItems.find((item) => item.value === (projectScopeKey ?? "all")) ??
      projectScopeItems[0]!,
    [projectScopeItems, projectScopeKey],
  );
  const [projectScopeMenuState, dispatchProjectScopeMenu] = useReducer(
    reduceSidebarProjectScopeMenuState,
    { open: false, query: "" },
  );
  const projectScopeFilter = useComboboxFilter();
  const filteredProjectScopeItems = useMemo(
    () =>
      filterSidebarProjectScopeItems({
        items: projectScopeItems,
        query: projectScopeMenuState.query,
        matches: (item, query) =>
          projectScopeFilter.contains(item, query, (candidate) => candidate.label),
      }),
    [projectScopeFilter, projectScopeItems, projectScopeMenuState.query],
  );
  const scopedProjectGroup = useMemo(
    () =>
      projectScopeKey === null
        ? null
        : (projectGroups.find((project) => project.projectKey === projectScopeKey) ?? null),
    [projectGroups, projectScopeKey],
  );
  const scopedProjectKeys = useMemo(
    () =>
      scopedProjectGroup === null
        ? null
        : new Set(
            scopedProjectGroup.memberProjectRefs.map(
              (projectRef) => `${projectRef.environmentId}:${projectRef.projectId}`,
            ),
          ),
    [scopedProjectGroup],
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
      setProjectScopeKey(nextKey);
    }
  }, [
    allProjectConfigsReady,
    allProjectSnapshotsReady,
    persistedProjectScopeKey,
    projectGroups,
    projectGroupingSettings,
    setProjectScopeKey,
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
  useEffect(() => {
    clearSelection();
  }, [clearSelection, projectScopeKey]);

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
  const headerSearchRef = useRef<HTMLDivElement | null>(null);
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
    snoozeNow,
  } = useMemo(() => {
    void snoozeWakeTick;
    const preciseNow = new Date().toISOString();
    // sidebar roster (v2 models them as real threads with lineage). Archived
    // Stave spaces keep their threads out of the live list.
    const visible = filterSidebarV2VisibleThreads(threads, scopedProjectKeys).filter(
      (thread) => !archivedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`),
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
      snoozeNow: preciseNow,
    };
  }, [
    archivedProjectKeys,
    nowMinute,
    scopedProjectKeys,
    serverConfigs,
    snoozeWakeTick,
    threads,
    workingShelfEnabled,
  ]);

  const threadSearchInputRef = useRef<HTMLInputElement>(null);
  const [threadSearchQuery, setThreadSearchQuery] = useState("");
  const [activeSearchResultIndex, setActiveSearchResultIndex] = useState(0);
  const isSearchingThreads = threadSearchQuery.trim().length > 0;
  const searchableThreads = useMemo(
    () => [
      ...pinnedThreads,
      ...activeThreads,
      ...workingThreads,
      ...snoozedThreads,
      ...settledThreads,
    ],
    [activeThreads, pinnedThreads, settledThreads, snoozedThreads, workingThreads],
  );
  const searchEnvironmentIds = useConnectedEnvironmentIds();
  const threadSearch = useThreadSearch(searchEnvironmentIds, threadSearchQuery);
  const threadSearchMatchByKey = useMemo(
    () =>
      new Map(threadSearch.matches.map((match) => [threadSearchMatchKey(match), match] as const)),
    [threadSearch.matches],
  );
  const threadSearchResults = useMemo(
    () =>
      searchSidebarThreads(
        searchableThreads,
        threadSearchQuery,
        new Set(threadSearchMatchByKey.keys()),
      ),
    [searchableThreads, threadSearchQuery, threadSearchMatchByKey],
  );
  const threadSearchResultOrderKey = threadSearchResults
    .map((thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)))
    .join("\0");

  useEffect(() => {
    setActiveSearchResultIndex(0);
  }, [threadSearchResultOrderKey]);

  useEffect(() => {
    if (!isSearchingThreads) return;
    document
      .getElementById(`sidebar-thread-search-result-${activeSearchResultIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeSearchResultIndex, isSearchingThreads, threadSearchResultOrderKey]);

  useEffect(() => {
    const nextWakeAtMs =
      snoozedThreads.length > 0 && snoozedThreads[0]?.snoozedUntil != null
        ? Date.parse(snoozedThreads[0].snoozedUntil)
        : Number.NaN;
    if (Number.isNaN(nextWakeAtMs)) return;
    // setTimeout delays are signed 32-bit: anything larger overflows and fires
    // immediately, turning a far-future wake (event-condition snoozes synced
    // from elsewhere) into a tight re-arm loop.
    const delayMs = Math.min(Math.max(0, nextWakeAtMs - Date.now()) + 50, 2_147_483_647);
    const id = window.setTimeout(() => bumpSnoozeWakeTick((tick) => tick + 1), delayMs);
    return () => window.clearTimeout(id);
  }, [snoozedThreads]);

  const [settledVisibleCount, setSettledVisibleCount] = useState(SETTLED_TAIL_INITIAL_COUNT);
  const settledResetKey = projectScopeKey ?? "all";
  const lastSettledResetKeyRef = useRef(settledResetKey);
  if (lastSettledResetKeyRef.current !== settledResetKey) {
    lastSettledResetKeyRef.current = settledResetKey;
    setSettledVisibleCount(SETTLED_TAIL_INITIAL_COUNT);
  }
  const visibleSettledThreads = useMemo(() => {
    if (settledThreads.length <= settledVisibleCount) return settledThreads;
    const visible = settledThreads.slice(0, settledVisibleCount);
    if (routeThreadKey !== null) {
      const routeThread = settledThreads
        .slice(settledVisibleCount)
        .find(
          (thread) =>
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
        );
      if (routeThread !== undefined) visible.push(routeThread);
    }
    return visible;
  }, [routeThreadKey, settledThreads, settledVisibleCount]);
  const hiddenSettledCount = settledThreads.length - visibleSettledThreads.length;
  const showMoreSettled = useCallback(
    () => setSettledVisibleCount((count) => count + SETTLED_TAIL_PAGE_COUNT),
    [],
  );
  const [settledShelfExpanded, setSettledShelfExpanded] = useLocalStorage(
    SETTLED_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const toggleSettledShelf = useCallback(
    () => setSettledShelfExpanded((value) => !value),
    [setSettledShelfExpanded],
  );
  const renderedSettledThreads = useMemo(() => {
    if (settledShelfExpanded) return visibleSettledThreads;
    if (routeThreadKey === null) return EMPTY_THREADS;
    const routeThread = visibleSettledThreads.find(
      (thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
    );
    return routeThread === undefined ? EMPTY_THREADS : [routeThread];
  }, [routeThreadKey, settledShelfExpanded, visibleSettledThreads]);

  const [snoozedShelfExpanded, setSnoozedShelfExpanded] = useLocalStorage(
    SNOOZED_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const toggleSnoozedShelf = useCallback(
    () => setSnoozedShelfExpanded((value) => !value),
    [setSnoozedShelfExpanded],
  );
  const visibleSnoozedThreads = useMemo(() => {
    if (snoozedShelfExpanded) return snoozedThreads;
    if (routeThreadKey === null) return EMPTY_THREADS;
    const routeThread = snoozedThreads.find(
      (thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
    );
    return routeThread === undefined ? EMPTY_THREADS : [routeThread];
  }, [routeThreadKey, snoozedShelfExpanded, snoozedThreads]);

  const [workingShelfExpanded, setWorkingShelfExpanded] = useLocalStorage(
    WORKING_SHELF_EXPANDED_KEY,
    false,
    Schema.Boolean,
  );
  const toggleWorkingShelf = useCallback(
    () => setWorkingShelfExpanded((value) => !value),
    [setWorkingShelfExpanded],
  );
  const visibleWorkingThreads = useMemo(() => {
    if (workingShelfExpanded) return workingThreads;
    if (routeThreadKey === null) return EMPTY_THREADS;
    const routeThread = workingThreads.find(
      (thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
    );
    return routeThread === undefined ? EMPTY_THREADS : [routeThread];
  }, [routeThreadKey, workingShelfExpanded, workingThreads]);

  const scopedSagaTree = useMemo(() => {
    if (!scopedProjectKeys) return sagaTree;
    const matches = (node: (typeof sagaTree)[number]) =>
      node.group.memberProjectRefs.some((ref) =>
        scopedProjectKeys.has(`${ref.environmentId}:${ref.projectId}`),
      );
    return sagaTree.flatMap((node) => {
      const children = node.children.filter(matches);
      return matches(node) || children.length ? [{ ...node, children }] : [];
    });
  }, [sagaTree, scopedProjectKeys]);
  const [projectSettledShelves, setProjectSettledShelves] = useState<
    Readonly<Record<string, { expanded: boolean; limit: number }>>
  >({});
  const settledByProject = useMemo(() => {
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
          routeThreadKey,
          SETTLED_TAIL_INITIAL_COUNT,
        ),
      );
    }
    return entries;
  }, [scopedSagaTree, settledThreads, projectSettledShelves, routeThreadKey]);
  const nestedSettledThreads = useMemo(
    () => [...settledByProject.values()].flatMap((page) => page.visible),
    [settledByProject],
  );
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
    routeThreadKey,
  });
  const orderedThreads = useMemo(() => {
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
  }, [
    pinnedThreads,
    activeThreads,
    visibleWorkingThreads,
    visibleSnoozedThreads,
    renderedSettledThreads,
    nestedSettledThreads,
    nestSagaProjects,
    scopedSagaTree,
    collapsedProjectKeys,
    sidebarSegments.segments,
  ]);
  const orderedThreadKeys = useMemo(
    () =>
      orderedThreads.map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      ),
    [orderedThreads],
  );
  const orderedThreadKeysRef = useRef(orderedThreadKeys);
  orderedThreadKeysRef.current = orderedThreadKeys;
  const threadByKey = useMemo(
    () =>
      new Map(
        orderedThreads.map(
          (thread) =>
            [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
        ),
      ),
    [orderedThreads],
  );
  // Handlers read these through refs: depending on per-update Map/Set
  // identities would give every row a fresh callback prop on each shell
  // event and defeat row memoization during streaming.
  const threadByKeyRef = useRef(threadByKey);
  threadByKeyRef.current = threadByKey;
  const handleNewThreadRef = useRef(newThreadContext.handleNewThread);
  handleNewThreadRef.current = newThreadContext.handleNewThread;
  const settledThreadKeys = useMemo(
    () =>
      new Set(
        settledThreads.map((thread) =>
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        ),
      ),
    [settledThreads],
  );
  const settledThreadKeysRef = useRef(settledThreadKeys);
  settledThreadKeysRef.current = settledThreadKeys;
  const snoozedThreadKeys = useMemo(
    () =>
      new Set(
        snoozedThreads.map((thread) =>
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        ),
      ),
    [snoozedThreads],
  );
  const snoozedThreadKeysRef = useRef(snoozedThreadKeys);
  snoozedThreadKeysRef.current = snoozedThreadKeys;

  const jumpLabelByKey = useMemo(() => {
    const mapping = new Map<string, string>();
    for (const [index, threadKey] of orderedThreadKeys.entries()) {
      const jumpCommand = threadJumpCommandForIndex(index);
      if (!jumpCommand) break;
      const label = shortcutLabelForCommand(keybindings, jumpCommand);
      if (label) mapping.set(threadKey, label);
    }
    return mapping;
  }, [keybindings, orderedThreadKeys]);
  const { showThreadJumpHints: showJumpHints, updateThreadJumpHintsVisibility } =
    useThreadJumpHintVisibility();

  const navigateToThread = useCallback(
    (threadRef: ScopedThreadRef) => {
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
    },
    [clearSelection, isMobile, router, setOpenMobile, setSelectionAnchor],
  );

  const queuePendingFileDrop = useSidebarPendingFileDropStore((s) => s.queuePendingFileDrop);
  const clearPendingFileDrop = useSidebarPendingFileDropStore((s) => s.clearPendingFileDrop);
  const handleThreadFileDrop = useCallback(
    async (threadRef: ScopedThreadRef, files: File[]) => {
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
    },
    [clearPendingFileDrop, navigateToThread, queuePendingFileDrop, router],
  );

  const navigateToDraft = useCallback(
    (draftId: DraftId) => {
      clearSelection();
      if (isMobile) {
        setOpenMobile(false);
      }
      void router.navigate({ to: "/draft/$draftId", params: { draftId } });
    },
    [clearSelection, isMobile, router, setOpenMobile],
  );

  const clearThreadSearch = useCallback(() => {
    setThreadSearchQuery("");
    setActiveSearchResultIndex(0);
  }, []);
  const selectThreadSearchResult = useCallback(
    (thread: EnvironmentThreadShell) => {
      clearThreadSearch();
      navigateToThread(scopeThreadRef(thread.environmentId, thread.id));
    },
    [clearThreadSearch, navigateToThread],
  );
  const handleThreadSearchKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
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
    },
    [
      activeSearchResultIndex,
      clearThreadSearch,
      isSearchingThreads,
      selectThreadSearchResult,
      threadSearchResults,
    ],
  );

  const [renamingThreadKey, setRenamingThreadKey] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const startThreadRename = useCallback((threadRef: ScopedThreadRef, title: string) => {
    if (!readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)) return;
    setRenamingThreadKey(scopedThreadKey(threadRef));
    setRenamingTitle(title);
  }, []);
  const cancelThreadRename = useCallback(() => setRenamingThreadKey(null), []);
  const commitThreadRename = useCallback(
    (threadRef: ScopedThreadRef, title: string, originalTitle: string) => {
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
    },
    [updateThreadMetadata],
  );

  const handleThreadClick = useCallback(
    (event: ReactMouseEvent, threadRef: ScopedThreadRef) => {
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
    },
    [navigateToThread, rangeSelectTo, toggleThreadSelection],
  );

  const settlingThreadKeysRef = useRef(new Set<string>());
  // Callers snapshot the plan BEFORE the command mutates the partition;
  // background parks never navigate (null plan).
  const planForwardNavigation = useCallback(
    (threadKey: string, coParkingKeys?: ReadonlySet<string>): (() => void) | null => {
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
    },
    [navigateToThread, router],
  );

  const settleFromDrag = async (threadRef: ScopedThreadRef) => {
    const key = scopedThreadKey(threadRef);
    if (settlingThreadKeysRef.current.has(key)) return null;
    settlingThreadKeysRef.current.add(key);
    const navigate = planForwardNavigation(key);
    try {
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
    } finally {
      settlingThreadKeysRef.current.delete(key);
    }
  };
  const attemptSettle = useCallback(
    (threadRef: ScopedThreadRef, opts: { coSettlingKeys?: ReadonlySet<string> } = {}) => {
      void (async () => {
        const threadKey = scopedThreadKey(threadRef);
        if (settlingThreadKeysRef.current.has(threadKey)) return;
        settlingThreadKeysRef.current.add(threadKey);
        try {
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
        } finally {
          settlingThreadKeysRef.current.delete(threadKey);
        }
      })();
    },
    [planForwardNavigation, settleThread],
  );
  useEffect(() => registerSettleAndAdvance(attemptSettle), [attemptSettle]);
  const settleThreads = useCallback(
    (threadKeys: readonly string[]) => {
      const coSettlingKeys = new Set(threadKeys);
      for (const threadKey of threadKeys) {
        const thread = threadByKeyRef.current.get(threadKey);
        if (!thread || thread.settledOverride === "settled") continue;
        attemptSettle(scopeThreadRef(thread.environmentId, thread.id), { coSettlingKeys });
      }
    },
    [attemptSettle],
  );
  const attemptUnsettle = useCallback(
    (threadRef: ScopedThreadRef) => {
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
    },
    [unsettleThread],
  );
  const attemptUnsnooze = useCallback(
    (threadRef: ScopedThreadRef) => {
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
    },
    [unsnoozeThread],
  );
  const orderedPinnedThreads = pinnedThreads;
  const sectionByThreadKey = useMemo(() => {
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
  }, [activeThreads, pinnedThreads, settledThreads, snoozedThreads, workingThreads]);
  const sectionByThreadKeyRef = useRef(sectionByThreadKey);
  sectionByThreadKeyRef.current = sectionByThreadKey;
  // owns its own pointer sensor, separate from the row drag scope, and
  // unmounting the sidebar cancels it.
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
  const attemptPin = useCallback(
    (threadRef: ScopedThreadRef) => {
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
    },
    [pinThread],
  );
  const attemptUnpin = useCallback(
    (threadRef: ScopedThreadRef) => {
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
    },
    [confirmAndUnpinThread],
  );

  const snoozingThreadKeysRef = useRef(new Set<string>());
  const performSnooze = useCallback(
    async (
      threadRef: ScopedThreadRef,
      preset: Pick<SnoozePreset, "snoozedUntil">,
      opts: { coSnoozingKeys?: ReadonlySet<string> } = {},
    ) => {
      const threadKey = scopedThreadKey(threadRef);
      if (snoozingThreadKeysRef.current.has(threadKey)) {
        return { status: "skipped" } as const;
      }
      snoozingThreadKeysRef.current.add(threadKey);
      try {
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
      } finally {
        snoozingThreadKeysRef.current.delete(threadKey);
      }
    },
    [planForwardNavigation, snoozeThread],
  );
  const attemptSnooze = useCallback(
    (
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
    },
    [performSnooze],
  );

  const removeFromSelection = useThreadSelectionStore((s) => s.removeFromSelection);
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
              supports: {
                settlement: supportsSettlement,
                autoSettleOptOut: supportsAutoSettleOptOut,
                snooze: supportsSnooze,
                pinning: supportsPinning,
                titleRegeneration: supportsTitleRegeneration,
                fork: readEnvironmentSupportsForking(thread.environmentId),
              },
              snoozePresets,
            }),
            position,
          ),
        );
        if (clicked._tag === "Failure" || clicked.value === null) return;
        if (threadActionRequiresOperate(clicked.value) && !checkThreadOperations([thread])) return;
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
  const handleProjectHeaderContextMenu = useCallback(
    (event: ReactMouseEvent, project: SidebarProjectSnapshot) => {
      const entries = project.memberProjects.flatMap((member) => {
        const entry = readStaveSpaceLifecycleMenuEntry(member);
        return entry ? [{ member, entry }] : [];
      });
      if (entries.length === 0) return;
      event.preventDefault();
      const position = { x: event.clientX, y: event.clientY };
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        const items: ContextMenuItem[] = [
          { id: "settings", label: "Space settings", icon: "settings" },
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
        ];
        const clicked = await settlePromise(() => api.contextMenu.show(items, position));
        if (clicked._tag === "Failure" || !clicked.value) return;
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
    },
    [openProjectSettings],
  );
  // An archived space leaves the sidebar, so leave a route inside it for the
  // saga it left, or home (as settings does). Runs on the operation's
  // success; the dialog then closes itself. The route's thread is read from
  // the store: the sidebar's own list no longer holds an archived space's threads.
  const handleSpaceConfirmationFinished = useCallback(() => {
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
  }, [landAfterStaveArchive, spaceConfirmation]);

  const routeTerminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
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
            currentThreadId: routeThreadKey,
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
    routeTerminalOpen,
    routeThreadKey,
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

  const handleNewThreadClick = useCallback(
    (event?: ReactMouseEvent) => {
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
    },
    [isMobile, newThreadContext, projectGroups.length, setOpenMobile],
  );

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
              searchFieldRef={headerSearchRef}
              hasProjects={projectGroups.length > 0}
              projectScope={
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
                      <SidebarHeaderIconButton
                        label={
                          scopedProjectGroup
                            ? `Filter threads by project: ${scopedProjectGroup.displayName}`
                            : "Filter threads by project"
                        }
                      />
                    }
                  >
                    {scopedProjectGroup ? (
                      <span className="flex shrink-0">
                        <ProjectFavicon project={scopedProjectGroup} className="size-4" />
                      </span>
                    ) : (
                      <ListFilterIcon className="size-4" />
                    )}
                  </ComboboxTrigger>
                  <ComboboxPopup
                    align="start"
                    anchor={headerSearchRef}
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
              onNewProject={openAddProjectCommandPalette}
              onNewThread={handleNewThreadClick}
              newThreadDisabled={projects.length === 0}
              newThreadShortcutLabel={newThreadShortcutLabel}
              newThreadInProjectShortcutLabel={newThreadInProjectShortcutLabel}
              showNewThreadInProjectHint={projectGroups.length > 1}
              searchInputRef={threadSearchInputRef}
              searchQuery={threadSearchQuery}
              onSearchQueryChange={(value) => {
                setThreadSearchQuery(value);
                setActiveSearchResultIndex(0);
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
                        isRouteActive={routeThreadKey === threadKey}
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
          {!isSearchingThreads ? (
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
                  // An action sweep owns the pointer: rows it passes over
                  // neither show hover actions nor open tooltips, even
                  // controls that opt back in, like the Woke pill.
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
                    // Settled and snoozed are the ONLY things that collapse a
                    // row: every other thread is a full card. Density comes
                    // from users (or the auto rules) actually parking work,
                    // not from the sidebar second-guessing what still matters.
                    // Working rows stay cards so their live status shows.
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
                            isActive={routeThreadKey === threadKey}
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
                            changeRequestSnapshot={
                              changeRequestSnapshotByKey.get(threadKey) ?? null
                            }
                            onChangeRequestSnapshot={setThreadChangeRequestSnapshot}
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
                        routeThreadKey,
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
                        routeThreadKey,
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
                                routeThreadKey={routeThreadKey}
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
                                    routeThreadKey,
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
                                                    workingShelfExpanded || key === routeThreadKey
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
                                                    snoozedShelfExpanded || key === routeThreadKey
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
                      routeThreadKey={routeThreadKey}
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
                          routeThreadKey,
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

import { type SortableThreadRowBag } from "./SidebarDragScope";
import { AccountMark } from "./AccountMark";
import { accountByEnvironmentIdAtom } from "../../cloud/connectAccounts";
import { useRevealActiveThread } from "./useRevealActiveThread";
import { useSidebarAccountStyle } from "./useSidebarAccountStyle";
import {
  resolveThreadPullRequestRef,
  selectThreadPullRequestWatches,
  threadPullRequestLinks,
} from "@lecturn/client-runtime/state/threadPullRequests";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { usePullRequestWatches } from "../../state/pullRequestWatch";
import type { PullRequestWatch } from "@lecturn/contracts";
import { StaveIcon } from "../StaveIcon";
import { describeStaveWorkspace } from "../stave/staveWorkspaceContext.logic";
import { ThreadHoverCard, ThreadHoverCardPopup } from "../ThreadHoverCard";
import { ThreadTerminalStatusButton } from "../ThreadStatusIndicators";
import { discardComposerDraft } from "../../lib/discardComposerDraft";
import { requestCustomSnooze } from "../CustomSnoozeDialog";
import { useSupportsMultiplePullRequests } from "~/hooks/useSupportsMultiplePullRequests";
import { resolveThreadCurrentPullRequestLink } from "@lecturn/shared/threadPullRequests";
import { useAtomValue } from "@effect/atom-react";
import { CSS } from "@dnd-kit/utilities";
import {
  canSnooze,
  hasQueuedTurnStart,
  QUEUED_TURN_START_GRACE_MS,
} from "@lecturn/client-runtime/state/thread-settled";
import { formatDiffCount } from "@lecturn/client-runtime/diff-count";
import { resolveSettledThreadTimestamp } from "@lecturn/client-runtime/state/thread-sort";
import { type EnvironmentThreadSearchMatch } from "@lecturn/client-runtime/state/thread-search";
import { resolveThreadProviderStack } from "@lecturn/client-runtime/state/models";
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@lecturn/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentMachineKind,
  type ScopedThreadRef,
} from "@lecturn/contracts";
import type { TimestampFormat } from "@lecturn/contracts/settings";
import {
  AlarmClockIcon,
  AlarmClockOffIcon,
  ArrowRightLeftIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  ClockIcon,
  GitBranchIcon,
  GitForkIcon,
  MessageCircleQuestionIcon,
  PinIcon,
  PinOffIcon,
  ShieldQuestionIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import {
  memo,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { useRightPanelStore } from "../../rightPanelStore";
import { useOpenPrLink } from "../../lib/openPullRequestLink";
import { useUiStateStore } from "../../uiStateStore";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useProject, useProjects } from "../../state/entities";
import { resolveThreadGitTarget } from "../../lib/threadGitTarget";
import { vcsEnvironment } from "../../state/vcs";
import { useEnvironmentQuery } from "../../state/query";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { formatRelativeTimeLabel, parseTimestampDate } from "../../timestampFormat";
import type { SidebarThreadSummary } from "../../types";
import type { EnvironmentProject } from "@lecturn/client-runtime/state/shell";
import { cn } from "~/lib/utils";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import {
  type SidebarDropVerb,
  hasUnseenCompletion,
  resolveSidebarRowAccessibility,
  resolveSidebarThreadStatus,
  resolveThreadLastVisitedAt,
  shouldRecedeSidebarThread,
  useRetainedValue,
  useSidebarRowSubscriptionLease,
} from "../Sidebar.logic";
import { resolveLocalCheckoutBranchMismatch } from "../BranchToolbar.logic";
import {
  ThreadPullRequestBadgeControl,
  ThreadPullRequestsMiniList,
  ThreadWorktreeIndicator,
  prStatusIndicator,
  resolveThreadPullRequestBadge,
  type ThreadPr,
  terminalStatusFromRunningIds,
  type TerminalStatusIndicator,
  useLinkedThreadPullRequest,
  ThreadSearchPullRequestNumber,
} from "../ThreadStatusIndicators";
import { resolveSnoozePresets, type SnoozePreset } from "../Sidebar.snooze";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { ThreadSearchMatchExcerpt } from "../ThreadSearchMatch";
import { makeWorkspaceFileDropHandlers } from "../chat/workspaceFileDrop";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getTriggerDisplayModelLabel } from "../chat/providerIconUtils";
import { shouldShowInstanceBadge, type ProviderInstanceEntry } from "../../providerInstances";
import { useThreadRunningTerminalIds } from "../../state/terminalSessions";
import { InlineButton } from "../ui/button";
import { AppThreadBadge } from "../apps/AppThreadBadge";
import { JumpHintBadge } from "./JumpHintBadge";
import { SidebarRowStatusLine } from "./SidebarRowStatusLine";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuShortcut, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { MiddleTruncate } from "../ui/middle-truncate";
import { useThreadHasUnsentDraft } from "../../composerDraftStore";
import { useThreadShell } from "../../state/entities";

// The fields thread rows show. Provider status pushes refresh `checkedAt`,
// status and auth on every provider; leaving those out keeps each
// environment's map, and every memoized row, stable across them.
export type SidebarProviderEntry = Pick<
  ProviderInstanceEntry,
  | "instanceId"
  | "driverKind"
  | "enabled"
  | "displayName"
  | "accentColor"
  | "acpRegistryAgentId"
  | "acpRegistryIconUrl"
  | "models"
>;

function compactSidebarTimeLabel(label: string): string {
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

// Subscribes to the minute tick itself, so only the label re-renders each
// minute. The minute is passed as the clock so it is the formatter's input.
function RelativeTimeLabel(props: { timestamp: string | null }) {
  const nowMinute = useNowMinute();
  return props.timestamp === null
    ? null
    : compactSidebarTimeLabel(
        formatRelativeTimeLabel(props.timestamp, Date.parse(`${nowMinute}:00.000Z`)),
      );
}

function threadTimeTimestamp(thread: SidebarThreadSummary): string {
  return thread.latestUserMessageAt ?? thread.updatedAt;
}

function terminalProcessLabel(count: number): string {
  return `${count} terminal ${count === 1 ? "process" : "processes"} running`;
}

function SidebarProviderStack(props: {
  thread: SidebarThreadSummary;
  providerEntryByInstanceId: ReadonlyMap<string, SidebarProviderEntry>;
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
      size="compact"
      iconClassName="opacity-60"
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
  providerEntry: SidebarProviderEntry | null;
  providerEntryByInstanceId: ReadonlyMap<string, SidebarProviderEntry>;
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
            <div className="min-w-0 flex-1 wrap-break-word">
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
  const presets = open ? resolveSnoozePresets(new Date(), timestampFormat) : [];
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

export const draftSurfaceClassName = "bg-warning/4 hover:bg-warning/8";

export const draftPenClassName = "size-3 shrink-0 text-warning-foreground";

export type SidebarSweepAction = "settle" | "unsettle" | "unsnooze";

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

type SidebarThreadRowProps = {
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
  // Unlike isActive, never true for the ancestor standing in for an open
  // subagent: drafts and PR clicks care about which composer is on screen.
  isRouteThread: boolean;
  openPullRequestsInRightPanel: boolean;
  jumpLabel: string | null;
  currentEnvironmentId: string | null;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
  scratchMachineLabel: string | null;
  project: EnvironmentProject | null;
  projectDisplayName: string | null;
  providerEntryByInstanceId: ReadonlyMap<string, SidebarProviderEntry>;
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
};

export const SidebarThreadRow = memo(function SidebarThreadRow(props: SidebarThreadRowProps) {
  const {
    isRenaming,
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
    variant,
    variantAction,
  } = props;
  // The sidebar arranges rows from quiet shells, which hold still while a
  // thread streams; reading the live shell here re-renders only this row.
  const thread =
    useThreadShell(scopeThreadRef(props.thread.environmentId, props.thread.id)) ?? props.thread;
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
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
  const attachRow = (node: HTMLElement | null) => {
    rowRef(node);
    setBorderRow(node);
  };
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
  const hasUnsentDraft = useThreadHasUnsentDraft(threadRef) && !props.isRouteThread;
  const handleDiscardDraftClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    discardComposerDraft(threadRef);
  };

  // The row's own project decides where git looks (a Stave space targets its
  // primary repo, not the space root); the project record's workspace root
  // only covers a project that has not loaded yet.
  const threadProject = useProject(scopeProjectRef(thread.environmentId, thread.projectId));
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

  const handleClick = (event: ReactMouseEvent) => {
    onThreadClick(event, threadRef);
  };
  const handleAcknowledgeWokeClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (props.wokeAt === null) return;
    onAcknowledgeWoke(threadRef, props.wokeAt);
  };
  const handleContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    onContextMenu(threadRef, { x: event.clientX, y: event.clientY });
  };
  const handleKeyDown = (event: ReactKeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onThreadActivate(threadRef);
  };
  const handleDoubleClick = (event: ReactMouseEvent) => {
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
  };
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const fileDropHandlers = onFileDropThreads
    ? makeWorkspaceFileDropHandlers({
        setDragActive: setIsFileDragOver,
        addFiles: (files) => {
          onFileDropThreads(threadRef, files);
        },
        addFolders: () => {},
      })
    : null;
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
  const handleRenameKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
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
  };
  const handleRenameBlur = () => {
    if (!renameCommittedRef.current) {
      onCommitRename(threadRef, renamingTitle, thread.title);
    }
  };
  const [isForking, setIsForking] = useState(false);
  const forkInFlightRef = useRef(false);
  const handleForkClick = async (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (forkInFlightRef.current) return;
    forkInFlightRef.current = true;
    setIsForking(true);
    await onFork(threadRef).finally(() => {
      forkInFlightRef.current = false;
      setIsForking(false);
    });
  };
  const handleSettleClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onSettle(threadRef);
  };
  const handleActionPointerDown = (event: ReactPointerEvent) => {
    if (!event.isPrimary || event.button !== 0) return;
    event.stopPropagation();
    onActionSweepStart(threadRef, variantAction, event.nativeEvent);
  };
  const handleUnsettleClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onUnsettle(threadRef);
  };
  const handleUnsnoozeClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onUnsnooze(threadRef);
  };
  const handleUnpinClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onUnpin(threadRef);
  };
  const handleSnoozePreset = (preset: Pick<SnoozePreset, "snoozedUntil">) => {
    onSnooze(threadRef, preset);
  };
  const [snoozeMenuOpenRaw, setSnoozeMenuOpen] = useState(false);
  // The React Compiler caches render results on their inputs, so a clock read
  // here would stay frozen until `thread` changes and a queued-turn gate would
  // never reopen. The gate's clock is state, reset with the thread.
  const [snoozeGateClock, setSnoozeGateClock] = useState(() => ({
    thread,
    now: new Date().toISOString(),
  }));
  if (snoozeGateClock.thread !== thread) {
    setSnoozeGateClock({ thread, now: new Date().toISOString() });
  }
  const snoozeGateNow = snoozeGateClock.now;
  const snoozeGateExpiryMs = hasQueuedTurnStart(thread, { now: snoozeGateNow })
    ? Date.parse(thread.latestUserMessageAt ?? "") + QUEUED_TURN_START_GRACE_MS
    : Number.NaN;
  useEffect(() => {
    // A gate still closed past its expiry is held by runtime status, not time,
    // so no clock tick can open it.
    if (!Number.isFinite(snoozeGateExpiryMs) || snoozeGateExpiryMs <= Date.parse(snoozeGateNow)) {
      return;
    }
    const id = window.setTimeout(
      () => setSnoozeGateClock({ thread, now: new Date().toISOString() }),
      Math.min(Math.max(0, snoozeGateExpiryMs - Date.now()) + 50, 2_147_483_647),
    );
    return () => window.clearTimeout(id);
  }, [snoozeGateExpiryMs, snoozeGateNow, thread]);
  const showSnoozeButton =
    canOperateThread && props.snoozeSupported && canSnooze(thread, { now: snoozeGateNow });
  // Closing here, not just masking, keeps the menu from reopening when the button returns.
  if (snoozeMenuOpenRaw && !showSnoozeButton) setSnoozeMenuOpen(false);
  const snoozeMenuOpen = snoozeMenuOpenRaw && showSnoozeButton;
  const handlePrClick = (event: ReactMouseEvent<HTMLElement>, targetUrl?: string) => {
    const url = targetUrl ?? pr?.url ?? currentLinkedPr?.url;
    if (!url) return;
    const showInRightPanel = targetUrl !== undefined || openPullRequestsInRightPanel;
    const openedInRightPanel = openPrLink(event, url, showInRightPanel ? threadRef : undefined);
    if (openedInRightPanel && showInRightPanel && !props.isRouteThread) {
      onThreadActivate(threadRef);
    }
  };

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
  const handlePrListClick = () => {
    useRightPanelStore.getState().open(threadRef, "pull-requests");
    if (!props.isRouteThread) onThreadActivate(threadRef);
  };
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
                      <RelativeTimeLabel
                        timestamp={
                          variantAction === "unsettle"
                            ? resolveSettledThreadTimestamp(thread)
                            : threadTimeTimestamp(thread)
                        }
                      />
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
            <SidebarRowStatusLine
              markers={
                <>
                  <AccountMark environmentId={thread.environmentId} />
                  {pinIndicator}
                </>
              }
              anchored={showPin || isWokeStatus}
              status={
                topStatus && status !== "working" ? (
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
                  <RelativeTimeLabel timestamp={threadTimeTimestamp(thread)} />
                )
              }
              statusPersistent={isWokeStatus}
              actions={
                props.settlementSupported || showSnoozeButton || hasUnsentDraft ? (
                  <>
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
                  </>
                ) : null
              }
              actionsOpen={snoozeMenuOpen}
              slotHidden={props.sweepAction !== null}
              slotReplacement={sortable?.isDragging ? dragDestination : undefined}
              after={props.sweepAction !== null ? dragDestination : null}
            >
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
            </SidebarRowStatusLine>
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

export const SidebarSearchResultRow = memo(function SidebarSearchResultRow(props: {
  isSettled: boolean;
  thread: SidebarThreadSummary;
  project: EnvironmentProject | null;
  projectDisplayName: string | null;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
  providerEntryByInstanceId: ReadonlyMap<string, SidebarProviderEntry>;
  isHighlighted: boolean;
  isRouteActive: boolean;
  resultId: string;
  searchMatch: EnvironmentThreadSearchMatch | null;
  searchQuery: string;
  onHighlight: () => void;
  onSelect: () => void;
  onFileDropThreads: (threadRef: ScopedThreadRef, files: File[]) => void;
}) {
  const thread =
    useThreadShell(scopeThreadRef(props.thread.environmentId, props.thread.id)) ?? props.thread;
  const accessibility = resolveSidebarRowAccessibility({
    title: thread.title,
    statusLabel: null,
    projectDisplayName: props.projectDisplayName,
    isActive: props.isRouteActive,
  });
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const { leaseLiveStatus, rowRef } = useSidebarRowSubscriptionLease(
    props.isHighlighted || props.isRouteActive,
  );
  const threadProject = useProject(scopeProjectRef(thread.environmentId, thread.projectId));
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
  const onFileDropThreads = props.onFileDropThreads;
  const fileDropHandlers = makeWorkspaceFileDropHandlers({
    setDragActive: setIsFileDragOver,
    addFiles: (files) => {
      onFileDropThreads(threadRef, files);
    },
    addFolders: () => {},
  });
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
              data-search-result-key={scopedThreadKey(threadRef)}
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
              <AppThreadBadge project={threadProject} />
              <span id={`${props.resultId}-pr`} className="contents">
                <ThreadSearchPullRequestNumber
                  thread={thread}
                  query={props.searchQuery}
                  enabled={leaseLiveStatus}
                  settled={props.isSettled}
                />
              </span>
              <span className="w-8 shrink-0 text-right text-xs text-muted-foreground/55 tabular-nums">
                <RelativeTimeLabel timestamp={threadTimeTimestamp(thread)} />
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

import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { formatFilePathForClipboard } from "@lecturn/client-runtime/media-actions";
import { readLocalApi } from "../localApi";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { scopeProjectRef, scopeThreadRef } from "@lecturn/client-runtime/environment";
import { staveForcedEnvMode } from "@lecturn/client-runtime/state/projectGit";
import type { EnvironmentId, ProjectId, ThreadId } from "@lecturn/contracts";
import {
  ChevronDownIcon,
  FolderGit2Icon,
  FolderGitIcon,
  FolderIcon,
  PlusIcon,
  ScaleIcon,
} from "lucide-react";
import {
  type Ref,
  type MouseEvent as ReactMouseEvent,
  memo,
  useImperativeHandle,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { useProject, useThreadShellsForProjectRefs } from "../state/entities";
import {
  ADD_TO_MACHINE_LABEL_CLASS,
  type EnvMode,
  type EnvironmentOption,
  resolveContextStripLabelsCompact,
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveEnvModeLocked,
  resolveLockedWorkspaceLabel,
  resolvePreviousWorktreeLabel,
  resolvePreviousWorktreeSeed,
  shouldShowEnvironmentIndicator,
} from "./BranchToolbar.logic";
import {
  BranchToolbarBranchSelector,
  type BranchToolbarBranchSelectorHandle,
} from "./BranchToolbarBranchSelector";
import { BranchToolbarEnvironmentSelector } from "./BranchToolbarEnvironmentSelector";
import { openAddProjectToMachine } from "./AddProjectToMachineDialog";
import { type AddProjectTarget, useAddProjectTargets } from "../hooks/useAddProjectTargets";
import { BranchToolbarEnvModeSelector } from "./BranchToolbarEnvModeSelector";
import { PreviousWorktreeItemContent } from "./PreviousWorktreeItemContent";
import { ThreadDetailsControl } from "./chat/ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
} from "./chat/threadDetailsPanelStyles";
import { ComposerControl } from "./chat/ComposerControl";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "./ui/menu";
import { Separator } from "./ui/separator";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { MiddleTruncate } from "./ui/middle-truncate";
import { ComposerSurface } from "./chat/ComposerSurface";
import { useComposerMenuProps } from "./chat/composerEventScope";
import { measureRestingComposerControls } from "./chat/restingComposerControlsMeasurement";
import { resolveRestingComposerControlsNaturalWidth } from "./composerFooterLayout";
import { cn } from "~/lib/utils";
import { observeResize } from "~/lib/observeResize";
import { describeStaveWorkspace } from "./stave/staveWorkspaceContext.logic";
import { StaveWorkspaceContext } from "./stave/StaveWorkspaceContext";

export interface BranchToolbarHandle {
  openBranchPicker: () => void;
  usePreviousWorktree: () => void;
}

interface BranchToolbarProps {
  layout?: "composer" | "panel";
  panelSection?: "all" | "workspace" | "branch";
  forceNewWorktree?: boolean;
  ref?: Ref<BranchToolbarHandle>;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  projectId: ProjectId;
  worktreePath: string | null;
  isServerThread: boolean;
  showGitControls: boolean;
  draftId?: DraftId;
  onEnvModeChange: (mode: EnvMode) => void;
  envMode: EnvMode;
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (branch: string | null) => void;
  startFromOrigin: boolean;
  onStartFromOriginChange: (startFromOrigin: boolean) => void;
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  envLocked: boolean;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
  availableEnvironments?: readonly EnvironmentOption[];
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
  composerControlsHostRef?: (element: HTMLDivElement | null) => void;
  contextStripVisible?: boolean;
}

function showWorkspaceContextMenu(event: ReactMouseEvent, workspacePath: string) {
  const api = readLocalApi();
  if (!api) return;
  event.preventDefault();
  event.stopPropagation();
  void api.contextMenu
    .show([{ id: "copy-path", label: "Copy full path", icon: "copy" }], {
      x: event.clientX,
      y: event.clientY,
    })
    .then((action) => {
      if (action !== "copy-path") return;
      const clipboardPath = formatFilePathForClipboard(workspacePath);
      void writeTextToClipboard(clipboardPath, "workspace path").then(
        (didCopy) => {
          if (didCopy) {
            toastManager.add({
              type: "success",
              title: "Path copied",
              description: clipboardPath,
            });
          }
        },
        (error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to copy path",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        },
      );
    });
}

interface RunContextSelectorProps {
  displayMode?: "toolbar" | "panel";
  workspaceRoot?: string;
  forceNewWorktree: boolean;
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  envLocked: boolean;
  envModeLocked: boolean;
  /** False for Stave spaces: their repos are already worktrees, so the
      worktree options are not offered at all rather than shown disabled. */
  worktreeModeAvailable: boolean;
  environmentId: EnvironmentId;
  availableEnvironments: readonly EnvironmentOption[] | undefined;
  showEnvironmentPicker: boolean;
  showEnvironmentIndicator: boolean;
  onEnvironmentChange: ((environmentId: EnvironmentId) => void) | undefined;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  previousWorktreeLabel: string | null;
  previousWorktreeBranch: string | null;
  onUsePreviousWorktree: () => void;
  addTargets: readonly AddProjectTarget[];
  onAddToMachine: (environmentId: EnvironmentId) => void;
}

const RunContextSelector = memo(function RunContextSelector({
  displayMode = "toolbar",
  workspaceRoot,
  forceNewWorktree,
  autoEnvironmentLabel,
  onAutoEnvironment,
  envLocked,
  envModeLocked,
  worktreeModeAvailable,
  environmentId,
  availableEnvironments,
  showEnvironmentPicker,
  showEnvironmentIndicator,
  onEnvironmentChange,
  effectiveEnvMode,
  activeWorktreePath,
  onEnvModeChange,
  previousWorktreeLabel,
  previousWorktreeBranch,
  onUsePreviousWorktree,
  addTargets,
  onAddToMachine,
}: RunContextSelectorProps) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const activeEnvironment =
    availableEnvironments?.find((env) => env.environmentId === environmentId) ?? null;
  const WorkspaceIcon =
    effectiveEnvMode === "worktree"
      ? FolderGit2Icon
      : activeWorktreePath
        ? FolderGitIcon
        : FolderIcon;
  const workspaceLabel = forceNewWorktree
    ? resolveEnvModeLabel("worktree")
    : envModeLocked
      ? resolveLockedWorkspaceLabel(activeWorktreePath, effectiveEnvMode)
      : effectiveEnvMode === "worktree"
        ? resolveEnvModeLabel("worktree")
        : resolveCurrentWorkspaceLabel(activeWorktreePath);
  const isPanel = displayMode === "panel";
  const isLocked = envLocked || (envModeLocked && (!isPanel || !showEnvironmentPicker));
  const workspacePath =
    forceNewWorktree || (effectiveEnvMode === "worktree" && !activeWorktreePath)
      ? null
      : (activeWorktreePath ?? workspaceRoot);
  const handleContextMenu = (event: ReactMouseEvent) => {
    if (isPanel && workspacePath) {
      showWorkspaceContextMenu(event, workspacePath);
    }
  };
  const workspaceIcon = (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        <WorkspaceIcon
          className={
            isPanel
              ? THREAD_DETAILS_PANEL_ICON_CLASS
              : cn("size-3 shrink-0", showEnvironmentIndicator ? "mx-0!" : "redesign:mx-0!")
          }
        />
      </TooltipTrigger>
      <TooltipPopup>
        {isPanel
          ? forceNewWorktree
            ? "Each model starts in its own worktree."
            : (workspacePath ?? workspaceLabel)
          : workspaceLabel}
      </TooltipPopup>
    </Tooltip>
  );
  const environmentIcon = (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        {autoEnvironmentLabel ? (
          <ScaleIcon
            className={isPanel ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3 shrink-0 mx-0!"}
            aria-hidden="true"
          />
        ) : (
          <EnvironmentMachineIcon
            kind={activeEnvironment?.machine ?? "server"}
            // New design: wide machine glyphs need a little more box to match the square row icons.
            className={
              isPanel
                ? cn(THREAD_DETAILS_PANEL_ICON_CLASS, "redesign:-mx-px redesign:size-4.5")
                : "size-3 shrink-0 mx-0!"
            }
          />
        )}
      </TooltipTrigger>
      <TooltipPopup>{autoEnvironmentLabel ?? activeEnvironment?.label ?? "Run on"}</TooltipPopup>
    </Tooltip>
  );
  const icon = !showEnvironmentIndicator ? (
    workspaceIcon
  ) : (
    // Button's SVG margins consume 4px of the gap; mx-0! restores the intended 2px.
    <span className="inline-flex shrink-0 items-center gap-0.5">
      {environmentIcon}
      {/* The new design moves the panel's workspace icon after the label. */}
      {isPanel ? <span className="contents redesign:hidden">{workspaceIcon}</span> : workspaceIcon}
    </span>
  );
  const triggerContent = (
    <>
      {icon}
      <ComposerContextLabel displayMode={displayMode}>
        {(!isPanel && autoEnvironmentLabel === "Auto balance unavailable"
          ? "Unavailable"
          : !isPanel && autoEnvironmentLabel === "Checking machines…"
            ? "Checking…"
            : autoEnvironmentLabel) ??
          (showEnvironmentIndicator ? (activeEnvironment?.label ?? "Run on") : workspaceLabel)}
      </ComposerContextLabel>
      {/* New design: trailing in the panel, so every row label starts on the same edge. */}
      {isPanel && showEnvironmentIndicator ? (
        <span className="hidden redesign:contents">{workspaceIcon}</span>
      ) : null}
    </>
  );

  if (isLocked) {
    return (
      <span
        className={cn(
          "inline-flex h-7 min-w-0 max-w-[48%] flex-initial items-center justify-start gap-1 rounded-md border border-transparent px-1.75 font-normal text-muted-foreground/70 text-xs sm:h-6 redesign:text-foreground/70 redesign:dark:text-muted-foreground",
          isPanel && "max-w-full",
          isPanel && THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
        )}
        onContextMenu={handleContextMenu}
        aria-label={isPanel ? "Run context" : undefined}
        data-composer-context-control
      >
        {triggerContent}
      </span>
    );
  }

  return (
    <Menu>
      <MenuTrigger
        render={isPanel ? <ThreadDetailsControl part="select" /> : <ComposerControl size="xs" />}
        className={isPanel ? undefined : "min-w-0 max-w-[48%] flex-initial justify-start"}
        onContextMenu={handleContextMenu}
        onMouseDownCapture={
          isPanel
            ? (event) => {
                if (event.button !== 0 || event.ctrlKey) event.stopPropagation();
              }
            : undefined
        }
        aria-label={isPanel ? "Run context" : autoEnvironmentLabel}
        data-composer-context-control
        data-composer-shortcut={[
          showEnvironmentPicker && !envLocked ? "composer.host" : "",
          !envModeLocked ? "composer.workspace" : "",
        ].join(" ")}
      >
        {triggerContent}
        {!isPanel ? (
          <ChevronDownIcon className="size-3 shrink-0 mx-0! opacity-50 redesign:opacity-100" />
        ) : null}
      </MenuTrigger>
      <MenuPopup
        align="start"
        side={isPanel ? "bottom" : "top"}
        className={
          isPanel
            ? "w-(--anchor-width)"
            : previousWorktreeLabel
              ? "w-[min(21rem,calc(100vw-2rem))]"
              : undefined
        }
        {...(!isPanel ? composerFloatingLayerProps : {})}
      >
        {availableEnvironments &&
        ((showEnvironmentPicker && onEnvironmentChange) || addTargets.length > 0) ? (
          <>
            <MenuGroup>
              <MenuGroupLabel>Run on</MenuGroupLabel>
              <MenuRadioGroup
                value={autoEnvironmentLabel ? "auto" : environmentId}
                onValueChange={(value) =>
                  value === "auto"
                    ? onAutoEnvironment?.()
                    : onEnvironmentChange?.(value as EnvironmentId)
                }
              >
                {onAutoEnvironment && (
                  <MenuRadioItem
                    value="auto"
                    disabled={envLocked}
                    closeOnClick
                    onClick={() => {
                      if (autoEnvironmentLabel) onAutoEnvironment?.();
                    }}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <ScaleIcon className="size-3" aria-hidden="true" />
                      <span className="min-w-0 truncate">
                        {autoEnvironmentLabel ?? "Auto balance"}
                      </span>
                    </span>
                  </MenuRadioItem>
                )}
                {availableEnvironments.map((env) => (
                  <MenuRadioItem
                    key={env.environmentId}
                    disabled={
                      envLocked || (!onEnvironmentChange && env.environmentId !== environmentId)
                    }
                    value={env.environmentId}
                    closeOnClick
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <EnvironmentMachineIcon kind={env.machine} className="size-3" />
                      <span className="min-w-0 truncate">{env.label}</span>
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
              {addTargets.length > 0 ? (
                <MenuSub>
                  <MenuSubTrigger>
                    <span className={ADD_TO_MACHINE_LABEL_CLASS}>
                      <PlusIcon className="size-3" />
                      <span className="min-w-0 truncate">Add to another machine</span>
                    </span>
                  </MenuSubTrigger>
                  <MenuSubPopup {...(!isPanel ? composerFloatingLayerProps : {})}>
                    {addTargets.map((target) => (
                      <MenuItem
                        key={target.environmentId}
                        onClick={() => onAddToMachine(target.environmentId)}
                      >
                        <span className="flex min-w-0 items-center gap-1.5">
                          <EnvironmentMachineIcon kind={target.machine} className="size-3" />
                          <span className="min-w-0 truncate">{target.label}</span>
                        </span>
                      </MenuItem>
                    ))}
                  </MenuSubPopup>
                </MenuSub>
              ) : null}
            </MenuGroup>
            <MenuSeparator />
          </>
        ) : null}
        <MenuGroup>
          <MenuGroupLabel>Workspace</MenuGroupLabel>
          <MenuRadioGroup
            value={effectiveEnvMode}
            onValueChange={(value) => {
              if (value === "previous-worktree") {
                onUsePreviousWorktree();
                return;
              }
              onEnvModeChange(value as EnvMode);
            }}
          >
            <MenuRadioItem disabled={envModeLocked || forceNewWorktree} value="local" closeOnClick>
              <span className="flex min-w-0 items-center gap-1.5">
                {activeWorktreePath ? (
                  <FolderGitIcon className="size-3" />
                ) : (
                  <FolderIcon className="size-3" />
                )}
                <MiddleTruncate value={resolveCurrentWorkspaceLabel(activeWorktreePath)} />
              </span>
            </MenuRadioItem>
            {worktreeModeAvailable ? (
              <MenuRadioItem disabled={envModeLocked} value="worktree" closeOnClick>
                <span className="flex min-w-0 items-center gap-1.5">
                  <FolderGit2Icon className="size-3" />
                  <span className="min-w-0 truncate">{resolveEnvModeLabel("worktree")}</span>
                </span>
              </MenuRadioItem>
            ) : null}
            {worktreeModeAvailable && previousWorktreeLabel ? (
              <MenuRadioItem disabled={envModeLocked} value="previous-worktree" closeOnClick>
                <PreviousWorktreeItemContent branch={previousWorktreeBranch} />
              </MenuRadioItem>
            ) : null}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
});

const COMPOSER_CONTEXT_MOTION_DURATION_MS = 180;
const COMPOSER_CONTEXT_MOTION_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";
const COMPOSER_CONTEXT_LABEL_SELECTOR = "[data-composer-label]";

/** A hidden or squeezed label's scrollWidth loses its tail, causing label/icon flapping. */
function labelTextWidth(label: HTMLElement, range: Range): number {
  const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
  let width = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    range.selectNodeContents(node);
    width += range.getBoundingClientRect().width;
  }
  const motion = label.querySelector<HTMLElement>("[data-composer-label-motion]");
  const maxWidth = motion ? Number.parseFloat(getComputedStyle(motion).maxWidth) : Number.NaN;
  return Number.isFinite(maxWidth) ? Math.min(width, maxWidth) : width;
}

function useLabelsOverflow(element: HTMLDivElement | null): boolean {
  const [overflows, setOverflows] = useState(false);
  const pendingLabelRectsRef = useRef<Map<HTMLElement, DOMRect> | null>(null);
  const labelAnimationsRef = useRef(new Map<HTMLElement, Animation>());
  const measure = useEffectEvent(() => {
    const current = element;
    const compact = overflows;
    if (!current) return;
    const stripWidth = current.clientWidth;
    if (stripWidth === 0) return;
    const stripStyle = getComputedStyle(current);
    const available =
      stripWidth -
      (Number.parseFloat(stripStyle.paddingInlineStart) || 0) -
      (Number.parseFloat(stripStyle.paddingInlineEnd) || 0);
    const contentWidth = (parent: Element): number => {
      const gap = Number.parseFloat(getComputedStyle(parent).columnGap) || 0;
      let width = 0;
      let counted = 0;
      for (const child of parent.children) {
        if (!(child instanceof HTMLElement)) continue;
        if (child.offsetWidth === 0) continue;
        const style = getComputedStyle(child);
        const position = style.position;
        if (position === "absolute" || position === "fixed") continue;
        width +=
          child.offsetWidth +
          (Number.parseFloat(style.marginInlineStart) || 0) +
          (Number.parseFloat(style.marginInlineEnd) || 0);
        counted += 1;
      }
      return width + gap * Math.max(0, counted - 1);
    };
    const stripGap = Number.parseFloat(stripStyle.columnGap) || 0;
    let needed = 0;
    let groups = 0;
    for (const child of current.children) {
      if (!(child instanceof HTMLElement)) continue;
      // Reserve overflowed controls' width to prevent repeated hiding and expansion.
      const hostedControls = child.matches('[data-chat-resting-composer-controls-host="true"]')
        ? child.querySelector<HTMLElement>('[data-chat-composer-resting-controls="true"]')
        : null;
      const hostedMeasurement = hostedControls
        ? measureRestingComposerControls(hostedControls)
        : null;
      const width = hostedMeasurement
        ? resolveRestingComposerControlsNaturalWidth(hostedMeasurement)
        : contentWidth(hostedControls ?? child);
      if (width <= 1) continue;
      groups += 1;
      needed += width;
    }
    needed += stripGap * Math.max(0, groups - 1);
    const range = document.createRange();
    for (const label of current.querySelectorAll<HTMLElement>("[data-composer-label]")) {
      needed += Math.max(0, labelTextWidth(label, range) - label.getBoundingClientRect().width);
    }
    const nextOverflows = resolveContextStripLabelsCompact({
      compact,
      neededWidth: needed,
      availableWidth: available,
    });
    if (nextOverflows !== compact) {
      pendingLabelRectsRef.current = new Map(
        Array.from(current.querySelectorAll<HTMLElement>(COMPOSER_CONTEXT_LABEL_SELECTOR)).map(
          (label) => [label, label.getBoundingClientRect()],
        ),
      );
    }
    setOverflows(nextOverflows);
  });

  useLayoutEffect(() => {
    const previousRects = pendingLabelRectsRef.current;
    if (!previousRects) return;
    pendingLabelRectsRef.current = null;

    for (const animation of labelAnimationsRef.current.values()) {
      animation.cancel();
    }
    labelAnimationsRef.current.clear();

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    for (const [label, previousRect] of previousRects) {
      if (!label.isConnected) continue;
      const nextWidth = label.getBoundingClientRect().width;
      if (Math.abs(previousRect.width - nextWidth) < 0.5) continue;

      const animation = label.animate(
        [
          { width: `${previousRect.width}px`, maxWidth: `${previousRect.width}px` },
          { width: `${nextWidth}px`, maxWidth: `${nextWidth}px` },
        ],
        {
          duration: COMPOSER_CONTEXT_MOTION_DURATION_MS,
          easing: COMPOSER_CONTEXT_MOTION_EASING,
          fill: "backwards",
        },
      );
      labelAnimationsRef.current.set(label, animation);
      animation.addEventListener(
        "finish",
        () => {
          if (labelAnimationsRef.current.get(label) === animation) {
            labelAnimationsRef.current.delete(label);
          }
        },
        { once: true },
      );
    }
  });

  useEffect(
    () => () => {
      for (const animation of labelAnimationsRef.current.values()) {
        animation.cancel();
      }
    },
    [],
  );

  useLayoutEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- The label mode comes from measuring the committed DOM, which render cannot read.
    measure();
  });

  useEffect(() => {
    if (!element) return;
    const stopObserving = observeResize(element, measure);
    document.fonts.addEventListener("loadingdone", measure);
    return () => {
      stopObserving();
      document.fonts.removeEventListener("loadingdone", measure);
    };
  }, [element]);

  return overflows;
}

export const BranchToolbar = memo(function BranchToolbar({
  layout = "composer",
  panelSection = "all",
  forceNewWorktree: requestedForceNewWorktree = false,
  ref,
  environmentId,
  threadId,
  projectId,
  worktreePath,
  isServerThread,
  showGitControls: requestedGitControls,
  draftId,
  onEnvModeChange,
  envMode,
  activeThreadBranchOverride,
  onActiveThreadBranchOverrideChange,
  startFromOrigin,
  onStartFromOriginChange,
  autoEnvironmentLabel,
  onAutoEnvironment,
  envLocked,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
  availableEnvironments,
  onEnvironmentChange,
  composerControlsHostRef,
  contextStripVisible = true,
}: BranchToolbarProps) {
  const branchSelectorRef = useRef<BranchToolbarBranchSelectorHandle>(null);
  const threadRef = scopeThreadRef(environmentId, threadId);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  // The composer retains resolved thread details while bootstrap cleanup can remove its shell.
  const activeProjectRef = scopeProjectRef(environmentId, projectId);
  const activeProject = useProject(activeProjectRef);
  const staveContext = describeStaveWorkspace(activeProject);
  const showGitControls =
    requestedGitControls && (!staveContext || staveContext.primaryRepoPath !== null);
  // A Stave space's repos are already worktrees: the mode is pinned to local
  // and the picker is read-only so nothing can offer to create another one.
  const forcedEnvMode = staveForcedEnvMode(activeProject);
  // A multi-model send fans out into new worktrees, which a Stave space never creates.
  const forceNewWorktree = requestedForceNewWorktree && forcedEnvMode === undefined;
  const activeWorktreePath = forceNewWorktree ? null : worktreePath;
  const effectiveEnvMode = forcedEnvMode ?? (forceNewWorktree ? "worktree" : envMode);
  const envModeLocked = resolveEnvModeLocked({
    envLocked,
    forcedEnvMode,
    hasServerThread: isServerThread,
    activeWorktreePath,
  });

  const canUsePreviousWorktree = !isServerThread && !envModeLocked && !forceNewWorktree;
  const projectRefsForWorktreeLookup = canUsePreviousWorktree ? [activeProjectRef] : [];
  const projectThreads = useThreadShellsForProjectRefs(projectRefsForWorktreeLookup);
  const previousWorktreeSeed = canUsePreviousWorktree
    ? resolvePreviousWorktreeSeed({
        threads: projectThreads,
        currentWorktreePath: activeWorktreePath,
      })
    : null;
  const previousWorktreeLabel = previousWorktreeSeed
    ? resolvePreviousWorktreeLabel(previousWorktreeSeed)
    : null;
  const onUsePreviousWorktree = () => {
    if (!previousWorktreeSeed) return;
    setDraftThreadContext(draftId ?? threadRef, {
      branch: previousWorktreeSeed.branch,
      worktreePath: previousWorktreeSeed.worktreePath,
      envMode: "worktree",
      projectRef: activeProjectRef,
    });
  };

  useImperativeHandle(
    ref,
    () => ({
      openBranchPicker: () => branchSelectorRef.current?.open(),
      usePreviousWorktree: () => {
        if (!showGitControls || !canUsePreviousWorktree || !previousWorktreeSeed) return;
        onUsePreviousWorktree();
        onComposerFocusRequest?.();
      },
    }),
    [
      canUsePreviousWorktree,
      onComposerFocusRequest,
      onUsePreviousWorktree,
      previousWorktreeSeed,
      showGitControls,
    ],
  );

  const addTargets = useAddProjectTargets(activeProject, availableEnvironments);
  const onAddToMachine = (targetEnvironmentId: EnvironmentId | null) =>
    openAddProjectToMachine({ projectRef: activeProjectRef, targetEnvironmentId });
  // A project on one machine still gets the picker when it can be added to another.
  const hasMultipleEnvironments = (availableEnvironments?.length ?? 0) > 1 || addTargets.length > 0;
  const showEnvironmentPicker = hasMultipleEnvironments && onEnvironmentChange !== undefined;
  const activeEnvironmentOption =
    availableEnvironments?.find((env) => env.environmentId === environmentId) ?? null;
  // Started threads get no handler but still show which machine they run on,
  // matching the strip visibility ChatView computes from the same inputs.
  const showEnvironmentIndicator = shouldShowEnvironmentIndicator({
    activeEnvironment: activeEnvironmentOption,
    canPickEnvironment: hasMultipleEnvironments,
  });
  const [stripElement, setStripElement] = useState<HTMLDivElement | null>(null);
  const labelsOverflow = useLabelsOverflow(stripElement);

  if (!activeProject) return null;

  if (layout === "panel") {
    return (
      <div className="flex w-full flex-col" data-thread-panel-run-context>
        {staveContext && panelSection !== "branch" ? (
          <StaveWorkspaceContext context={staveContext} />
        ) : null}
        {!staveContext && panelSection !== "branch" ? (
          <RunContextSelector
            displayMode="panel"
            workspaceRoot={activeProject.workspaceRoot}
            forceNewWorktree={forceNewWorktree}
            autoEnvironmentLabel={autoEnvironmentLabel}
            onAutoEnvironment={onAutoEnvironment}
            envLocked={envLocked}
            envModeLocked={envModeLocked}
            worktreeModeAvailable={forcedEnvMode === undefined}
            environmentId={environmentId}
            availableEnvironments={availableEnvironments}
            showEnvironmentPicker={showEnvironmentPicker}
            showEnvironmentIndicator={activeEnvironmentOption !== null}
            onEnvironmentChange={onEnvironmentChange}
            effectiveEnvMode={effectiveEnvMode}
            activeWorktreePath={activeWorktreePath}
            onEnvModeChange={onEnvModeChange}
            previousWorktreeLabel={previousWorktreeLabel}
            previousWorktreeBranch={previousWorktreeSeed?.branch ?? null}
            onUsePreviousWorktree={onUsePreviousWorktree}
            addTargets={addTargets}
            onAddToMachine={onAddToMachine}
          />
        ) : null}
        {!staveContext && panelSection !== "workspace" ? (
          <BranchToolbarBranchSelector
            displayMode="panel"
            className="w-full"
            environmentId={environmentId}
            threadId={threadId}
            {...(draftId ? { draftId } : {})}
            envLocked={envLocked}
            effectiveEnvModeOverride={effectiveEnvMode}
            {...(activeThreadBranchOverride !== undefined ? { activeThreadBranchOverride } : {})}
            {...(onActiveThreadBranchOverrideChange ? { onActiveThreadBranchOverrideChange } : {})}
            startFromOrigin={startFromOrigin}
            onStartFromOriginChange={onStartFromOriginChange}
            {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
            {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
          />
        ) : null}
      </div>
    );
  }

  return (
    <ComposerSurface.ContextStrip
      ref={setStripElement}
      data-compact={labelsOverflow ? "" : undefined}
      className={cn(
        "gap-1 text-xs font-normal text-muted-foreground/70 redesign:text-foreground/70 redesign:dark:text-muted-foreground",
        // Hide empty non-Git strips while retaining host width so controls can reappear as the chat grows.
        !contextStripVisible && "pointer-events-none invisible absolute inset-x-0 top-full",
      )}
    >
      {showGitControls && !staveContext ? (
        <div className="contents @3xl/composer-surface:hidden">
          <RunContextSelector
            forceNewWorktree={forceNewWorktree}
            autoEnvironmentLabel={autoEnvironmentLabel}
            onAutoEnvironment={onAutoEnvironment}
            envLocked={envLocked}
            envModeLocked={envModeLocked}
            worktreeModeAvailable={forcedEnvMode === undefined}
            environmentId={environmentId}
            availableEnvironments={availableEnvironments}
            showEnvironmentPicker={showEnvironmentPicker}
            showEnvironmentIndicator={showEnvironmentIndicator}
            onEnvironmentChange={onEnvironmentChange}
            effectiveEnvMode={effectiveEnvMode}
            activeWorktreePath={activeWorktreePath}
            onEnvModeChange={onEnvModeChange}
            previousWorktreeLabel={previousWorktreeLabel}
            previousWorktreeBranch={previousWorktreeSeed?.branch ?? null}
            onUsePreviousWorktree={onUsePreviousWorktree}
            addTargets={addTargets}
            onAddToMachine={onAddToMachine}
          />
        </div>
      ) : null}
      {showGitControls || showEnvironmentIndicator || staveContext ? (
        <div
          className={cn(
            "min-h-7 min-w-10 items-center gap-1 sm:min-h-6",
            showGitControls && !staveContext ? "hidden @3xl/composer-surface:flex" : "flex",
            composerControlsHostRef ? "shrink" : "flex-1",
          )}
        >
          {showEnvironmentIndicator && availableEnvironments && (
            <>
              <BranchToolbarEnvironmentSelector
                autoEnvironmentLabel={autoEnvironmentLabel}
                onAutoEnvironment={onAutoEnvironment}
                envLocked={envLocked}
                environmentId={environmentId}
                availableEnvironments={availableEnvironments}
                {...(showEnvironmentPicker ? { onEnvironmentChange } : {})}
                {...(addTargets.length > 0 ? { onAddToMachine: () => onAddToMachine(null) } : {})}
              />
              {showGitControls ? (
                <Separator
                  orientation="vertical"
                  className="mx-0.5 h-3.5!"
                  data-composer-context-control
                />
              ) : null}
            </>
          )}
          {staveContext ? (
            <StaveWorkspaceContext context={staveContext} />
          ) : showGitControls ? (
            <BranchToolbarEnvModeSelector
              forceNewWorktree={forceNewWorktree}
              envLocked={envModeLocked}
              effectiveEnvMode={effectiveEnvMode}
              activeWorktreePath={activeWorktreePath}
              onEnvModeChange={onEnvModeChange}
              previousWorktreeLabel={previousWorktreeLabel}
              previousWorktreeBranch={previousWorktreeSeed?.branch ?? null}
              onUsePreviousWorktree={onUsePreviousWorktree}
            />
          ) : null}
        </div>
      ) : null}

      {composerControlsHostRef ? (
        <div
          ref={composerControlsHostRef}
          data-composer-context-control
          data-chat-resting-composer-controls-host="true"
          className="flex min-w-0 flex-1 items-center justify-start overflow-x-clip overflow-y-visible"
        />
      ) : null}

      {showGitControls && !staveContext ? (
        <BranchToolbarBranchSelector
          forceNewWorktree={forceNewWorktree}
          ref={branchSelectorRef}
          className="min-w-0 flex-initial justify-end @3xl/composer-surface:ml-auto"
          environmentId={environmentId}
          threadId={threadId}
          {...(draftId ? { draftId } : {})}
          envLocked={envLocked}
          effectiveEnvModeOverride={effectiveEnvMode}
          {...(activeThreadBranchOverride !== undefined ? { activeThreadBranchOverride } : {})}
          {...(onActiveThreadBranchOverrideChange ? { onActiveThreadBranchOverrideChange } : {})}
          startFromOrigin={startFromOrigin}
          onStartFromOriginChange={onStartFromOriginChange}
          {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
          {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
        />
      ) : null}
    </ComposerSurface.ContextStrip>
  );
});

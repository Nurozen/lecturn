import { useNavigation } from "@react-navigation/native";
import { useAtomValue } from "@effect/atom-react";
import { serverEnvironment } from "../../state/server";
import { GlassCard } from "../../components/GlassCard";
import { useGlassPalette } from "../../lib/useGlassPalette";
import { StaveIcon } from "./StaveIcon";
import {
  selectThreadPullRequestWatches,
  threadPullRequestLinks,
} from "@lecturn/client-runtime/state/threadPullRequests";
import { useEnvironmentQuery } from "../../state/query";
import { pullRequestWatchEnvironment } from "../../state/pull-request-watch";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { ActiveThreadBorder } from "./ActiveThreadBorder";
import type { StaveSagaMemberStatus } from "@lecturn/contracts";
import { useRecyclingState, useViewabilityAmount } from "@legendapp/list/react-native";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@lecturn/client-runtime/state/shell";
import type { EnvironmentThreadSearchMatch } from "@lecturn/client-runtime/state/thread-search";
import type { EnvironmentMachineKind } from "@lecturn/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { SymbolView } from "../../components/AppSymbol";
import { memo, useCallback, useEffect, useMemo, type ComponentProps } from "react";
import Animated, {
  Easing,
  ReduceMotion,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { Platform, Pressable, useWindowDimensions, View, type ColorValue } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import Svg, { Circle, Path } from "react-native-svg";

import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { cn } from "../../lib/cn";
import { HOME_HORIZONTAL_INSET } from "../../lib/layoutMetrics";
import { relativeTime } from "../../lib/time";
import { themeColorWithAlpha } from "../../lib/mobileTheme";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useProject, useProjects } from "../../state/entities";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import { useThreadPr, type ThreadPrPresentation } from "../../state/use-thread-pr";
import type { HomeGroupDisplayAction } from "../home/homeListItems";
import { ThreadSwipeable } from "../home/thread-swipe-actions";
import { buildThreadForkMenuItems } from "./thread-fork-menu";
import { buildThreadTitleRegenerationMenuItems } from "./thread-title-regeneration-menu";
import { QueuedMessageIcon } from "./queued-message-icon";
import { resolveThreadStatus } from "./threadPresentation";
import { ThreadSearchMatchExcerpt } from "./thread-search-match";

/**
 * Shared presentation for the thread lists: the compact (phone) Home list and
 * the iPad sidebar render the SAME items — group headers with collapse,
 * thread rows with status/PR/subtitle, and show-more rows — differing only in
 * metrics and chrome via `variant`.
 */
export type ThreadListVariant = "compact" | "sidebar";

/** Left inset that aligns compact secondary rows with the title column. */
export const THREAD_LIST_COMPACT_INSET = HOME_HORIZONTAL_INSET;
const SIDEBAR_ROW_RADIUS = 22;
export const THREAD_ACTIVITY_VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 0 };

/** A stable native glyph rotates instead of swapping on each disclosure toggle. */
export function ThreadHierarchyChevron({
  expanded,
  direction = "right",
  size = 12,
  tintColor,
}: {
  readonly expanded: boolean;
  readonly direction?: "right" | "down";
  readonly size?: number;
  readonly tintColor?: ColorValue;
}) {
  const target = expanded ? (direction === "right" ? 90 : 180) : 0;
  const angle = useSharedValue(target);
  useEffect(() => {
    angle.set(
      withTiming(target, {
        duration: 420,
        easing: Easing.out(Easing.cubic),
        reduceMotion: ReduceMotion.System,
      }),
    );
    return () => cancelAnimation(angle);
  }, [angle, target]);
  const rotation = useAnimatedStyle(() => ({ transform: [{ rotate: `${angle.value}deg` }] }));
  return (
    <Animated.View pointerEvents="none" accessible={false} style={rotation}>
      <SymbolView
        name={direction === "right" ? "chevron.right" : "chevron.down"}
        size={size}
        type="monochrome"
        tintColor={tintColor}
        tintColorClassName={tintColor === undefined ? "accent-foreground-muted" : undefined}
      />
    </Animated.View>
  );
}

function pullRequestTintColor(
  pr: Pick<ThreadPrPresentation, "state" | "isDraft" | "others" | "kind">,
  colorScheme: "light" | "dark",
) {
  const dark = colorScheme === "dark";
  if (pr.state === "open" && pr.isDraft === true) {
    return dark ? "#a1a1aa" : "#71717a";
  }
  switch (pr.state) {
    case "open":
      return dark ? "#34d399" : "#059669";
    case "merged":
      return dark ? "#a78bfa" : "#7c3aed";
    case "closed":
      if (pr.kind === "stack" || pr.others > 0) {
        return dark ? "#fb7185" : "#e11d48";
      }
      return dark ? "#a1a1aa" : "#71717a";
    case null:
      return dark ? "#a1a1aa" : "#71717a";
  }
}

function PullRequestIcon(props: { readonly size: number; readonly color: string }) {
  return (
    <Svg
      width={props.size}
      height={props.size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={props.color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Circle cx={18} cy={18} r={3} />
      <Circle cx={6} cy={6} r={3} />
      <Path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <Path d="M6 9v12" />
    </Svg>
  );
}

/* ─── Project group header ───────────────────────────────────────────── */

export const ThreadListGroupHeader = memo(function ThreadListGroupHeader(props: {
  readonly variant: ThreadListVariant;
  readonly project: EnvironmentProject;
  readonly title: string;
  readonly threadCount: number;
  readonly collapsed: boolean;
  readonly isFirst: boolean;
  readonly groupKey: string;
  readonly depth?: number;
  readonly memberStatus?: StaveSagaMemberStatus | null;
  readonly firstThread?: EnvironmentThreadShell;
  readonly onSelectThread?: (thread: EnvironmentThreadShell) => void;
  readonly onGroupAction: (key: string, action: HomeGroupDisplayAction) => void;
  /** Project a quick new thread should target; null hides the button. */
  readonly newThreadTarget?: EnvironmentProject | null;
  readonly onNewThread?: (project: EnvironmentProject) => void;
}) {
  const { groupKey, onGroupAction, onNewThread } = props;
  const navigation = useNavigation();
  const decisionConfig = useAtomValue(
    serverEnvironment.configValueAtom(props.project.environmentId),
  );
  const newThreadTarget = props.newThreadTarget ?? null;
  const compact = props.variant === "compact";
  const handleToggle = useCallback(
    () => onGroupAction(groupKey, "toggle-collapsed"),
    [groupKey, onGroupAction],
  );
  const handleNewThread = useCallback(() => {
    if (newThreadTarget) onNewThread?.(newThreadTarget);
  }, [newThreadTarget, onNewThread]);
  const showNewThreadButton = onNewThread !== undefined && newThreadTarget !== null;
  const glass = useGlassPalette();

  // Separate 44pt controls keep collapse, open, and new-thread actions reachable
  // to touch users and VoiceOver/TalkBack without overlapping hit areas.
  return (
    <GlassCard
      radius={22}
      style={{
        marginHorizontal: compact ? 14 : 0,
        marginTop: props.isFirst ? 8 : 16,
        marginBottom: 8,
      }}
    >
      <View
        className="flex-row items-center"
        style={{
          minHeight: 52,
          paddingLeft: 4 + (props.depth ?? 0) * 18,
          paddingRight: 4,
          paddingBottom: 4,
          paddingTop: 4,
        }}
      >
        {Array.from({ length: props.depth ?? 0 }, (_, level) => (
          <View
            key={level}
            pointerEvents="none"
            accessible={false}
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: level * 18 + 8,
              width: 1,
              backgroundColor: glass.edge,
            }}
          />
        ))}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: !props.collapsed }}
          accessibilityLabel={`${props.collapsed ? "Expand" : "Collapse"} ${props.title}`}
          accessibilityHint={props.collapsed ? "Expands the project" : "Collapses the project"}
          style={{ minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" }}
          onPress={handleToggle}
        >
          <ThreadHierarchyChevron expanded={!props.collapsed} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${props.title}, ${props.threadCount} threads`}
          accessibilityHint={
            props.firstThread
              ? "Opens the most recent project thread"
              : "Expands or collapses the project"
          }
          className="min-w-0 flex-1 flex-row items-center gap-2"
          style={{ minHeight: 44 }}
          onPress={() => {
            if (props.firstThread && props.onSelectThread) props.onSelectThread(props.firstThread);
            else handleToggle();
          }}
        >
          {props.project.stave ? (
            <View accessibilityLabel={props.project.stave.isSaga ? "Stave saga" : "Stave space"}>
              <StaveIcon size={compact ? 22 : 18} />
            </View>
          ) : null}
          {!props.project.stave || props.project.faviconPath ? (
            <ProjectFavicon
              environmentId={props.project.environmentId}
              faviconPath={props.project.faviconPath}
              open={!props.collapsed}
              size={compact ? 22 : 18}
              projectTitle={props.project.title}
              workspaceRoot={props.project.workspaceRoot}
            />
          ) : null}
          <Text
            className={
              compact
                ? "flex-shrink text-base font-lecturn-bold tracking-[0.2px] text-foreground-muted"
                : "flex-shrink text-sm font-lecturn-bold tracking-[0.2px] text-foreground-muted"
            }
            numberOfLines={1}
          >
            {props.title}
          </Text>
          <Text
            className={
              compact
                ? "flex-1 text-sm font-lecturn-medium text-foreground-tertiary"
                : "flex-1 text-xs font-lecturn-medium text-foreground-tertiary"
            }
          >
            {props.threadCount}
          </Text>
        </Pressable>
        {newThreadTarget && decisionConfig?.environment.capabilities.threadDecisions ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Decisions for ${props.title}`}
            style={{ minHeight: 44, minWidth: 44, alignItems: "center", justifyContent: "center" }}
            onPress={() =>
              navigation.navigate("Decisions", {
                environmentId: props.project.environmentId,
                projectId: props.project.id,
              })
            }
          >
            <Text className="text-primary">Decisions</Text>
          </Pressable>
        ) : null}
        {showNewThreadButton ? (
          <Pressable
            accessibilityLabel={`Create new thread in ${props.title}`}
            accessibilityRole="button"
            onPress={handleNewThread}
            style={({ pressed }) => ({
              opacity: pressed ? 0.5 : 1,
              minWidth: 44,
              minHeight: 44,
              alignItems: "center",
              justifyContent: "center",
            })}
          >
            <SymbolView
              name="plus"
              size={compact ? 20 : 16}
              tintColorClassName={"accent-icon-muted"}
              type="monochrome"
              weight="medium"
            />
          </Pressable>
        ) : null}
      </View>
    </GlassCard>
  );
});

/* ─── Show more / show less row ──────────────────────────────────────── */

export const ThreadListShowMoreRow = memo(function ThreadListShowMoreRow(props: {
  readonly variant: ThreadListVariant;
  readonly hiddenCount: number;
  readonly canShowLess: boolean;
  readonly groupKey: string;
  readonly onGroupAction: (key: string, action: HomeGroupDisplayAction) => void;
}) {
  const showsMore = props.hiddenCount > 0;
  const compact = props.variant === "compact";
  const { groupKey, onGroupAction } = props;
  const handleShowMore = useCallback(
    () => onGroupAction(groupKey, "show-more"),
    [groupKey, onGroupAction],
  );
  const handleShowLess = useCallback(
    () => onGroupAction(groupKey, "show-less"),
    [groupKey, onGroupAction],
  );

  const button = (label: string, icon: "chevron.down" | "chevron.up", onPress: () => void) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label === "Show more" ? "Show more threads" : "Show fewer threads"}
      className="rounded-full bg-subtle"
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => ({
        opacity: pressed ? 0.6 : 1,
        paddingHorizontal: compact ? 14 : 12,
        paddingVertical: compact ? 7 : 6,
        borderCurve: "continuous",
      })}
    >
      <View className="flex-row items-center gap-1.5">
        <SymbolView
          name={icon}
          size={10}
          tintColorClassName={"accent-icon-subtle"}
          type="monochrome"
          weight="semibold"
        />
        <Text
          className={
            compact
              ? "text-sm font-lecturn-medium text-foreground-muted"
              : "text-xs font-lecturn-medium text-foreground-muted"
          }
        >
          {label}
        </Text>
      </View>
    </Pressable>
  );

  return (
    <View
      className={compact ? "flex-row items-center gap-2.5" : "flex-row items-center gap-2"}
      style={{
        paddingLeft: compact ? THREAD_LIST_COMPACT_INSET : 12,
        paddingRight: compact ? 18 : 12,
        paddingVertical: compact ? 12 : 8,
      }}
    >
      {showsMore ? button("Show more", "chevron.down", handleShowMore) : null}
      {props.canShowLess ? button("Show less", "chevron.up", handleShowLess) : null}
    </View>
  );
});

/* ─── Pending task row ───────────────────────────────────────────────── */

const PENDING_TASK_MENU_ACTIONS: MenuAction[] = [
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

const DRAFT_TASK_MENU_ACTIONS: MenuAction[] = [
  { id: "delete", title: "Discard", image: "trash", attributes: { destructive: true } },
];

/**
 * Unsent work: a task queued in the outbox for its environment to reconnect,
 * or a draft still sitting in the project's new-task composer. Tapping
 * reopens the composer with everything prefilled; the row disappears once
 * the work is sent and the real thread arrives. The two kinds differ in what
 * happens next, so the pill and icon say which one this is: a queued task
 * sends itself, a draft waits for the user.
 */
export const PendingTaskListRow = memo(function PendingTaskListRow(props: {
  readonly variant: ThreadListVariant;
  readonly pendingTask: PendingNewTask;
  readonly environmentLabel: string | null;
  readonly environmentMachine?: EnvironmentMachineKind;
  readonly isLast: boolean;
  readonly onSelectPendingTask: (pendingTask: PendingNewTask) => void;
  readonly onDeletePendingTask: (pendingTask: PendingNewTask) => void;
}) {
  const compact = props.variant === "compact";

  const { pendingTask, onSelectPendingTask, onDeletePendingTask } = props;
  const isDraft = pendingTask.kind === "draft";
  const timestamp = isDraft ? null : relativeTime(pendingTask.createdAt);
  // The pill only has room for one word, so what happens next goes in the
  // subtitle: a queued task sends itself, a draft waits for the user.
  const subtitleParts = [
    isDraft ? null : "Sends on reconnect",
    props.environmentLabel,
    pendingTask.branch,
  ].filter((part): part is string => Boolean(part));

  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "delete") onDeletePendingTask(pendingTask);
    },
    [onDeletePendingTask, pendingTask],
  );

  const statusPill = isDraft ? (
    <View className="rounded-full bg-adaptive-amber-500-a12-a16 px-1.5 py-0.5">
      <Text className="text-3xs font-lecturn-bold text-adaptive-amber-700-300">Draft</Text>
    </View>
  ) : (
    <View className="rounded-full bg-subtle px-1.5 py-0.5">
      <Text className="text-3xs font-lecturn-bold text-foreground-muted">Pending</Text>
    </View>
  );

  const subtitleRow =
    subtitleParts.length > 0 ? (
      <View className="mt-px flex-row items-center gap-1.5">
        <SymbolView
          name={isDraft ? "square.and.pencil" : "tray.and.arrow.up"}
          size={10}
          tintColorClassName={compact ? "accent-icon-subtle" : "accent-foreground-muted"}
          type="monochrome"
        />
        {props.environmentLabel && props.environmentMachine ? (
          <EnvironmentMachineSymbol
            kind={props.environmentMachine}
            size={compact ? 12 : 10}
            tintColorClassName={compact ? "accent-icon-subtle" : "accent-foreground-muted"}
          />
        ) : null}
        <Text
          className={
            compact
              ? "shrink text-sm text-foreground-muted"
              : "shrink text-xs text-foreground-muted"
          }
          numberOfLines={1}
        >
          {subtitleParts.join(" · ")}
        </Text>
      </View>
    ) : null;

  const accessibilityHint = isDraft
    ? "Opens the draft in the new task composer"
    : "Sends when the environment reconnects. Opens the task for editing";

  const rowContent = compact ? (
    <Pressable
      accessibilityHint={accessibilityHint}
      accessibilityLabel={pendingTask.title}
      accessibilityRole="button"
      className="active:opacity-70"
      style={{ marginHorizontal: 14, marginBottom: 8 }}
      onPress={() => onSelectPendingTask(pendingTask)}
    >
      <GlassCard radius={SIDEBAR_ROW_RADIUS} className="px-4 py-3">
        <View className="gap-1">
          <View className="flex-row items-center justify-between gap-2">
            <Text className="flex-1 text-lg font-lecturn-bold text-foreground" numberOfLines={1}>
              {pendingTask.title}
            </Text>
            <View className="flex-row items-center gap-2">
              {statusPill}
              {timestamp !== null ? (
                <Text className="text-base tabular-nums text-foreground-tertiary">{timestamp}</Text>
              ) : null}
              <SymbolView
                name="chevron.right"
                size={13}
                tintColorClassName={"accent-icon-subtle"}
                type="monochrome"
              />
            </View>
          </View>
          {subtitleRow}
        </View>
      </GlassCard>
    </Pressable>
  ) : (
    <Pressable
      accessibilityHint={accessibilityHint}
      accessibilityLabel={pendingTask.title}
      accessibilityRole="button"
      className="active:bg-subtle"
      onPress={() => onSelectPendingTask(pendingTask)}
      style={{
        borderRadius: SIDEBAR_ROW_RADIUS,
        cursor: "pointer",
        minHeight: 64,
        justifyContent: "center",
        marginBottom: 8,
      }}
    >
      <GlassCard radius={SIDEBAR_ROW_RADIUS} className="px-3 py-3">
        <View className="gap-1">
          <View className="flex-row items-center justify-between gap-2">
            <Text
              className="flex-1 text-base font-lecturn-medium text-foreground"
              numberOfLines={1}
            >
              {pendingTask.title}
            </Text>
            <View className="flex-row items-center gap-2">
              {statusPill}
              {timestamp !== null ? (
                <Text className="text-xs tabular-nums text-foreground-muted" numberOfLines={1}>
                  {timestamp}
                </Text>
              ) : null}
            </View>
          </View>
          {subtitleRow}
        </View>
      </GlassCard>
    </Pressable>
  );

  return (
    <ControlPillMenu
      actions={isDraft ? DRAFT_TASK_MENU_ACTIONS : PENDING_TASK_MENU_ACTIONS}
      onPressAction={handleMenuAction}
      shouldOpenOnLongPress
    >
      {rowContent}
    </ControlPillMenu>
  );
});

/* ─── Thread row ─────────────────────────────────────────────────────── */

const THREAD_ROW_MENU_ACTIONS: MenuAction[] = [
  { id: "archive", title: "Archive", image: "archivebox" },
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

export const ThreadListRow = memo(function ThreadListRow(props: {
  readonly variant: ThreadListVariant;
  readonly thread: EnvironmentThreadShell;
  readonly environmentLabel: string | null;
  readonly environmentMachine?: EnvironmentMachineKind;
  /** A message for this thread is waiting in the outbox. */
  readonly hasQueuedMessages?: boolean;
  readonly searchMatch?: EnvironmentThreadSearchMatch;
  readonly searchQuery?: string;
  readonly isLast: boolean;
  /** Sidebar only: the thread currently open in the detail pane. */
  readonly selected?: boolean;
  /** Defaults to window width minus compact margins. */
  readonly fullSwipeWidth?: number;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onArchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly onNewThreadOnBranch: (thread: EnvironmentThreadShell) => void;
  readonly onRegenerateThreadTitle: (thread: EnvironmentThreadShell) => void;
  readonly titleRegenerationSupported: boolean;
  /** False on servers without the forking capability or when the thread's
      provider cannot fork its conversation natively. */
  readonly forkSupported: boolean;
  readonly onForkThread: (thread: EnvironmentThreadShell) => void;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
  readonly simultaneousSwipeGesture?: ComponentProps<
    typeof ThreadSwipeable
  >["simultaneousWithExternalGesture"];
}) {
  const { width: windowWidth } = useWindowDimensions();
  const { themeAppearance: colorScheme } = useAppearancePreferences();
  const compact = props.variant === "compact";
  const selected = props.selected === true;
  // Recycling-safe: resets when the list container is reused for another
  // thread, so a hover highlight can't leak across rows.
  const [hovered, setHovered] = useRecyclingState(false);
  const [visible, setVisible] = useRecyclingState(false);
  useViewabilityAmount(useCallback((token) => setVisible(token.sizeVisible > 0), [setVisible]));

  const theme = useUniwindTheme();
  const glass = useGlassPalette();
  const selectedForegroundColor = theme["--color-foreground"];

  const {
    thread,
    onSelectThread,
    onArchiveThread,
    onDeleteThread,
    onForkThread,
    onRegenerateThreadTitle,
    onNewThreadOnBranch,
  } = props;
  const status = resolveThreadStatus(thread);
  const projectRef = useMemo(
    () => ({ environmentId: thread.environmentId, projectId: thread.projectId }),
    [thread.environmentId, thread.projectId],
  );
  const project = useProject(projectRef);
  const pr = useThreadPr(thread, project);
  const projects = useProjects();
  const watches = useEnvironmentQuery(
    visible
      ? pullRequestWatchEnvironment.list({ environmentId: thread.environmentId, input: {} })
      : null,
  );
  // Several linked pull requests (or one awaiting its first host sync) read as
  // one summary badge; a single known pull request joins the tappable chips.
  const prSummary =
    pr !== null && (pr.kind === "stack" || pr.others > 0 || pr.state === null) ? pr : null;
  const singlePr = prSummary === null ? pr : null;
  const requests = threadPullRequestLinks(
    selectThreadPullRequestWatches({
      projects,
      environmentId: thread.environmentId,
      thread,
      watches: watches.data?.watches ?? [],
    }),
    singlePr !== null && singlePr.state !== null
      ? {
          ...singlePr,
          state: singlePr.state,
          repository: (thread.linkedPullRequest ?? thread.branchPullRequest)?.repository,
        }
      : null,
  );
  const timestamp = relativeTime(
    thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
  );
  const threadAccessibilityLabel = [
    thread.title,
    thread.settledOverride === "settled" ? "Settled" : status?.label,
    prSummary?.accessibilityLabel,
    ...requests.map((request) => `${request.repository} #${request.number} ${request.state}`),
    props.hasQueuedMessages ? "messages queued to send" : null,
  ]
    .filter(Boolean)
    .join(", ");
  const subtitleParts = [
    thread.settledOverride === "settled" ? "✓ Settled" : null,
    props.environmentLabel,
    thread.branch,
  ].filter((part): part is string => Boolean(part));

  const effectivePressedBackground = glass.opaque
    ? theme["--color-subtle"]
    : themeColorWithAlpha(glass.accent, 0.12);
  const effectiveStatus =
    selected && status
      ? {
          ...status,
          pillClassName: "bg-subtle",
          textClassName: "text-foreground",
        }
      : status;

  const handleDelete = useCallback(() => onDeleteThread(thread), [onDeleteThread, thread]);
  const handleArchive = useCallback(() => onArchiveThread(thread), [onArchiveThread, thread]);
  const handleFork = useCallback(() => onForkThread(thread), [onForkThread, thread]);
  const handleRegenerateTitle = useCallback(
    () => onRegenerateThreadTitle(thread),
    [onRegenerateThreadTitle, thread],
  );
  const menuActions = useMemo<MenuAction[]>(
    () => [
      ...(thread.branch
        ? [
            {
              id: "new-thread-on-branch",
              title:
                Platform.OS === "ios" ? "New thread on branch" : `New thread on ${thread.branch}`,
              image: "square.and.pencil",
            },
          ]
        : []),
      THREAD_ROW_MENU_ACTIONS[0]!,
      ...buildThreadForkMenuItems({
        supported: props.forkSupported,
        inFlight: false,
        canForkNow: thread.latestTurn?.state === "completed",
      }),
      ...buildThreadTitleRegenerationMenuItems({
        supported: props.titleRegenerationSupported,
        isRegenerating: thread.titleRegeneration != null,
      }),
      THREAD_ROW_MENU_ACTIONS[1]!,
    ],
    [
      props.forkSupported,
      props.titleRegenerationSupported,
      thread.latestTurn,
      thread.branch,
      thread.titleRegeneration,
    ],
  );
  const primaryAction = useMemo(
    () => ({
      accessibilityLabel: `Archive ${thread.title}`,
      icon: "archivebox" as const,
      label: "Archive",
      onPress: handleArchive,
    }),
    [handleArchive, thread.title],
  );
  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "new-thread-on-branch") onNewThreadOnBranch(thread);
      if (nativeEvent.event === "archive") handleArchive();
      if (nativeEvent.event === "fork-thread") handleFork();
      if (nativeEvent.event === "regenerate-title") handleRegenerateTitle();
      if (nativeEvent.event === "delete") handleDelete();
    },
    [handleArchive, handleDelete, handleFork, handleRegenerateTitle, onNewThreadOnBranch, thread],
  );

  const statusPill =
    effectiveStatus && status?.kind !== "working" ? (
      <View className={`${effectiveStatus.pillClassName} rounded-full px-1.5 py-0.5`}>
        <Text className={`text-3xs font-lecturn-bold ${effectiveStatus.textClassName}`}>
          {effectiveStatus.label}
        </Text>
      </View>
    ) : null;

  const subtitleRow =
    subtitleParts.length > 0 || requests.length > 0 || prSummary !== null ? (
      <View className="mt-px flex-row items-center gap-1.5">
        {subtitleParts.length > 0 ? (
          <>
            {props.environmentLabel && props.environmentMachine ? (
              <EnvironmentMachineSymbol
                kind={props.environmentMachine}
                size={compact ? 12 : 10}
                tintColorClassName={
                  compact
                    ? "accent-icon-subtle"
                    : selected
                      ? "accent-foreground-muted"
                      : "accent-foreground-muted"
                }
              />
            ) : null}
            <Text
              className={cn(
                "shrink",
                compact ? "text-sm text-foreground-muted" : "text-xs",
                !compact && "text-foreground-muted",
              )}
              numberOfLines={1}
              style={
                thread.settledOverride === "settled"
                  ? { color: theme["--color-foreground-muted"] }
                  : undefined
              }
            >
              {subtitleParts.join(" · ")}
            </Text>
          </>
        ) : null}
        <View className="flex-1 flex-row flex-wrap items-center gap-1.5">
          {prSummary !== null ? (
            <View
              className="flex-row items-center gap-0.5"
              accessibilityLabel={prSummary.accessibilityLabel}
            >
              {prSummary.kind === "stack" ? (
                <SymbolView
                  name="square.3.layers.3d"
                  size={compact ? 13 : 11}
                  tintColor={
                    selected
                      ? String(selectedForegroundColor)
                      : pullRequestTintColor(prSummary, colorScheme)
                  }
                />
              ) : (
                <PullRequestIcon
                  size={compact ? 13 : 11}
                  color={
                    selected
                      ? String(selectedForegroundColor)
                      : pullRequestTintColor(prSummary, colorScheme)
                  }
                />
              )}
              <Text
                className={`${compact ? "text-sm" : "text-xs"} font-lecturn-medium ${
                  selected ? "text-foreground" : prSummary.textClassName
                }`}
              >
                {prSummary.label}
              </Text>
            </View>
          ) : null}
          {requests.map((request) => (
            <Pressable
              key={request.key}
              accessibilityRole="link"
              accessibilityLabel={`${request.repository} #${request.number} · ${request.state}: ${request.title}`}
              hitSlop={6}
              onPress={(event) => {
                event.stopPropagation();
                void tryOpenExternalUrl(request.url, "pull-request");
              }}
              className="flex-row items-center gap-0.5"
            >
              <PullRequestIcon
                size={compact ? 13 : 11}
                color={
                  selected
                    ? String(selectedForegroundColor)
                    : request.state === "unknown"
                      ? "#a1a1aa"
                      : pullRequestTintColor(
                          {
                            state: request.state,
                            isDraft: request.isDraft,
                            others: 0,
                            kind: "pull-request",
                          },
                          colorScheme,
                        )
                }
              />
              <Text
                className={`${compact ? "text-sm" : "text-xs"} font-lecturn-medium ${selected ? "text-foreground" : "text-primary"}`}
              >
                {new Set(requests.map((value) => value.repository)).size > 1 && request.repository
                  ? `${request.repository} `
                  : ""}
                #{request.number}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    ) : null;

  const rowContent = (close: () => void) =>
    compact ? (
      <Pressable
        accessibilityHint="Swipe left for archive and delete actions"
        accessibilityLabel={threadAccessibilityLabel}
        accessibilityRole="button"
        className="active:opacity-90"
        style={({ pressed }) => ({
          backgroundColor: pressed ? effectivePressedBackground : "transparent",
          borderRadius: SIDEBAR_ROW_RADIUS,
        })}
        onPress={() => {
          close();
          onSelectThread(thread);
        }}
      >
        <GlassCard tone={selected ? "accent" : "default"} radius={SIDEBAR_ROW_RADIUS}>
          {status?.kind === "working" ? (
            <ActiveThreadBorder visible={visible} radius={SIDEBAR_ROW_RADIUS} />
          ) : null}
          <View className="px-4 py-3">
            <View className="gap-1">
              <View className="flex-row items-center justify-between gap-2">
                <Text
                  className="flex-1 text-lg font-lecturn-bold text-foreground"
                  numberOfLines={1}
                  style={
                    thread.settledOverride === "settled"
                      ? { color: theme["--color-foreground-muted"] }
                      : undefined
                  }
                >
                  {thread.title}
                </Text>
                <View className="flex-row items-center gap-2">
                  {props.hasQueuedMessages ? <QueuedMessageIcon selected={selected} /> : null}
                  {statusPill}
                  <Text className="text-base tabular-nums text-foreground-tertiary">
                    {timestamp}
                  </Text>
                  <SymbolView
                    name="chevron.right"
                    size={13}
                    tintColorClassName={"accent-icon-subtle"}
                    type="monochrome"
                  />
                </View>
              </View>
              {props.searchMatch ? (
                <ThreadSearchMatchExcerpt
                  compact
                  match={props.searchMatch}
                  query={props.searchQuery ?? ""}
                />
              ) : null}
              {subtitleRow}
            </View>
          </View>
        </GlassCard>
      </Pressable>
    ) : (
      <Pressable
        accessibilityHint="Opens the thread"
        accessibilityLabel={threadAccessibilityLabel}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onPress={() => {
          close();
          onSelectThread(thread);
        }}
        style={({ pressed }) => ({
          backgroundColor: pressed || hovered ? effectivePressedBackground : "transparent",
          borderRadius: SIDEBAR_ROW_RADIUS,
          cursor: "pointer",
          minHeight: 64,
          justifyContent: "center",
        })}
      >
        <GlassCard tone={selected ? "accent" : "default"} radius={SIDEBAR_ROW_RADIUS}>
          {status?.kind === "working" ? (
            <ActiveThreadBorder visible={visible} radius={SIDEBAR_ROW_RADIUS} />
          ) : null}
          <View className="gap-1 px-3 py-3">
            <View className="flex-row items-center justify-between gap-2">
              <Text
                className="flex-1 text-base font-lecturn-medium text-foreground"
                numberOfLines={1}
                style={
                  thread.settledOverride === "settled"
                    ? { color: theme["--color-foreground-muted"] }
                    : undefined
                }
              >
                {thread.title}
              </Text>
              <View className="flex-row items-center gap-2">
                {props.hasQueuedMessages ? <QueuedMessageIcon selected={selected} /> : null}
                {statusPill}
                <Text className="text-xs tabular-nums text-foreground-muted" numberOfLines={1}>
                  {timestamp}
                </Text>
              </View>
            </View>
            {props.searchMatch ? (
              <ThreadSearchMatchExcerpt match={props.searchMatch} query={props.searchQuery ?? ""} />
            ) : null}
            {subtitleRow}
          </View>
        </GlassCard>
      </Pressable>
    );

  return (
    <ThreadSwipeable
      threadKey={`${thread.environmentId}:${thread.id}`}
      backgroundColor="transparent"
      containerStyle={{
        borderRadius: SIDEBAR_ROW_RADIUS,
        overflow: "hidden",
        marginHorizontal: compact ? 14 : 0,
        marginBottom: 8,
      }}
      enableTrackpadSwipe
      fullSwipeWidth={props.fullSwipeWidth ?? windowWidth - 32}
      onDelete={handleDelete}
      onSwipeableClose={props.onSwipeableClose}
      onSwipeableWillOpen={props.onSwipeableWillOpen}
      primaryAction={primaryAction}
      resetKey={`${thread.environmentId}:${thread.id}`}
      simultaneousWithExternalGesture={props.simultaneousSwipeGesture}
      threadTitle={thread.title}
    >
      {(close) => (
        // Messages-style row actions on long-press. iOS: a real
        // UIContextMenuInteraction with the row as the zoom preview (needs the
        // patched @react-native-menu, see
        // patches/@react-native-menu__menu@2.0.0.patch — in long-press mode the
        // interaction is hosted by the component view and the underlying
        // UIButton passes touches through, so row taps keep working). Android:
        // ControlPillMenu injects onLongPress into the row and anchors the
        // token-styled dropdown to it; taps and swipes are untouched.
        <ControlPillMenu
          actions={menuActions}
          onPressAction={handleMenuAction}
          shouldOpenOnLongPress
        >
          {rowContent(close)}
        </ControlPillMenu>
      )}
    </ThreadSwipeable>
  );
});

import { useOpenThreadInspector } from "./thread-inspector-navigation";
import { useSidebarWorkspaceTabs } from "../workspace/useSystemWorkspaceTabBar";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@lecturn/client-runtime/state/runtime";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Dialog from "../../components/ui/Dialog";
import { useAtomMount, useAtomValue } from "@effect/atom-react";
import { parseThreadKey, threadKey } from "@lecturn/client-runtime/state/entities";
import {
  createThreadVisitTracker,
  type ThreadUnreadWindow,
} from "@lecturn/client-runtime/state/thread-visits";
import {
  useChildThreadInputs,
  useThreadReportedModelSelection,
  useThreadShell,
} from "../../state/entities";
import { UsageLimitRecoveryCard } from "./UsageLimitRecoveryCard";
import { ChatGptUsageLimitNotice } from "./ChatGptUsageLimitNotice";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import {
  effectiveSnoozed,
  threadWokeAt,
  isThreadWokeUnseen,
  snoozeWakeLabel,
} from "@lecturn/client-runtime/state/thread-settled";
import type { WorktreeSetupCardProps } from "./worktree-setup-card";
import type { ComposerTextPaste } from "../../native/LecturnComposerEditor.types";
import { ContextualPreparationNotice } from "../contextual/ContextualControls";
import { AccountTintScope } from "../../lib/AccountTintScope";
import { ProviderIcon } from "../../components/ProviderIcon";
import { buildModelOptions } from "../../lib/modelOptions";
import {
  providerOptionValueLabels,
  resolveProviderOptionDescriptors,
} from "../../lib/providerOptions";
import { RUNTIME_MODE_CHOICES } from "./thread-settings-options";
import { ActiveThreadBorder } from "./ActiveThreadBorder";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useThreadListActions } from "../home/useThreadListActions";
import { ArcaneBackdrop } from "../../components/ArcaneBackdrop";
import { type EnvironmentConnectionPhase } from "@lecturn/client-runtime/connection";
import type { EnvironmentThreadShell } from "@lecturn/client-runtime/state/shell";
import type { HandoffEndpoints } from "@lecturn/client-runtime/handoff";
import {
  childThreadInputsTitle,
  type CodexFeedbackSubmission,
  type EnvironmentThreadStatus,
} from "@lecturn/client-runtime/state/threads";
import { useKeyboardChatComposerInset, useKeyboardScrollToEnd } from "@legendapp/list/keyboard";
import { resolveProviderSkillsForCwd } from "@lecturn/client-runtime/providerSkills";
import type { LegendListRef } from "@legendapp/list/react-native";
import { HeaderHeightContext } from "@react-navigation/elements";
import { NativeLayoutObserver } from "../../native/NativeLayoutObserver";
import { deriveBottomControlInsets, type NativeLayoutMetrics } from "../../lib/reserved-regions";
import type {
  EnvironmentId,
  MessageId,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  RuntimeRequestId,
  ScopedThreadRef,
  ServerConfig as LecturnServerConfig,
  ThreadId,
  UsageLimitsReport,
} from "@lecturn/contracts";
import {
  appendCodexArtifactTemplateUsePrompt,
  type CodexArtifactTemplate,
} from "@lecturn/shared/codexArtifactTemplates";
import {
  declinePendingApprovals,
  hasAppToolApproval,
  sendApprovalFeedback,
  type ApprovalResponder,
  type ThreadUserInputQuestion,
} from "@lecturn/client-runtime/state/thread-requests";
import {
  presentPendingBackgroundWork,
  presentProviderGoal,
} from "@lecturn/client-runtime/state/thread-execution";
import { resolveSubagentPillSegment } from "@lecturn/client-runtime/state/thread-subagents";
import { hasRunlessForkHistory } from "@lecturn/client-runtime/state/thread-fork-points";
import {
  formatModelSelectionEffort,
  type ProviderSubagentStatus,
} from "@lecturn/client-runtime/state/thread-execution";
import { formatModelSlugName, resolveSelectableModel } from "@lecturn/shared/model";
import { isProviderNativeSubagentThread } from "@lecturn/contracts";
import type { QueuedRunEdit } from "../../state/queued-run-edit";
import type { FollowUpBehavior } from "../../lib/followUpBehavior";
import type { ActiveTurnComposerAction } from "@lecturn/client-runtime/state/composer-dispatch";
import * as Haptics from "expo-haptics";
import {
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  AppState,
  Pressable,
  Keyboard,
  Platform,
  useWindowDimensions,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type ViewInstance,
} from "react-native";
import {
  KeyboardController,
  KeyboardStickyView,
  useKeyboardState,
  useReanimatedKeyboardAnimation,
} from "react-native-keyboard-controller";
import Animated, {
  Easing,
  FadeInDown,
  FadeOut,
  ReduceMotion,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useWorkspaceContentWidth } from "../layout/workspace-content-width";
import { useNativeWorkspaceColumnsSupported } from "../../native/NativeWorkspaceColumns";
import {
  useDeviceType,
  useDuoBottomBarInset,
  useNativeColumnLayoutMetrics,
  useNativeLayoutMetrics,
} from "../../native/native-layout-metrics";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { collectProviderUsageLimits } from "@lecturn/shared/usageLimits";
import type { ComposerEditorHandle } from "../../components/ComposerEditor";
import type { StatusTone } from "../../components/StatusPill";
import { getComposerDraftSnapshot } from "../../state/use-composer-drafts";
import { RenderErrorBoundary, RenderFailureView } from "../../components/RenderErrorBoundary";
import {
  ANDROID_READING_MAX_WIDTH,
  CHAT_CONTENT_MAX_WIDTH,
  type LayoutVariant,
} from "../../lib/layout";
import { editPendingThreadMessage } from "../../state/edit-pending-thread-message";
import { deviceEnvironment } from "../../state/device";
import { useEnvironmentQuery } from "../../state/query";
import { threadDevicePreviews } from "../devices/threadDevicePreviews";
import { ThreadBrowserFloat } from "../browser/ThreadBrowserFloat";
import { useThreadServerBrowserTabs } from "../../state/preview";
import type { QueuedThreadMessage } from "../../state/thread-outbox-model";
import { scopedThreadKey } from "../../lib/scopedEntities";
import {
  finishThreadMessageJump,
  pendingThreadMessageJump,
  subscribeThreadMessageJump,
} from "./threadMessageJump";
import {
  clearThreadComposerError,
  threadComposerErrorsAtom,
} from "../../state/thread-composer-error";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useDelayedStatus } from "../../lib/useDelayedStatus";
import type {
  PendingApproval,
  PendingUserInput,
  PendingUserInputDraftAnswer,
  ThreadFeedEntry,
  ThreadFeedLatestRun,
} from "../../lib/threadActivity";
import { PendingApprovalCard } from "./PendingApprovalCard";
import { AppClosedBanner } from "../apps/AppClosedBanner";
import { ComposerErrorNotice } from "./ComposerErrorNotice";
import { ComposerFeedback } from "./ComposerFeedback";
import { ComposerUsageLimits } from "./ComposerUsageLimits";
import { PendingUserInputCard } from "./PendingUserInputCard";
import { ProviderSubagentBar } from "./ProviderSubagentBar";
import { ThreadCreationFailedCard } from "./ThreadCreationFailedCard";
import {
  FLOATING_WORKING_CONTROL_COVERAGE,
  FloatingWorkingControl,
} from "./floating-working-control";
import { connectionFloatingStatus, type FloatingWorkingStatus } from "./floating-working-status";
import {
  derivePendingUserInputMaxHeight,
  ESTIMATED_KEYBOARD_HEIGHT,
  USER_INPUT_TOGGLE_DURATION_MS,
} from "./pendingUserInputLayout";
import {
  COMPOSER_COLLAPSED_CHROME,
  THREAD_COMPOSER_BOTTOM_GUTTER,
  ThreadComposer,
} from "./ThreadComposer";
import { ComposerPopoverHost } from "./ComposerPopoverHost";
import { ThreadFeed, type ThreadFeedHistoryControls } from "./ThreadFeed";
import { useThreadTurnSubagents } from "./ThreadAgentsSheet";
import { ComposerQueuedEditBanner } from "./ComposerQueuedEdit";
import { useThreadQueuedCount } from "./ThreadQueueControl";
import { ThreadGuestShareBar } from "./ThreadGuestShareBar";
import type { ThreadContentPresentation } from "./threadContentPresentation";
import { resolveThreadFeedSubmissionAnchor } from "./thread-feed-live-follow";
import { useOpenLinkedThread } from "./useOpenLinkedThread";
import { useGlobalVoiceInput } from "../voice-input/VoiceInputProvider";
import { SquireThreadBanners } from "../squires/SquireThreadBanners";
import {
  allowsThreadRouteControl,
  type ThreadRouteControl,
  type ThreadRouteControls,
} from "./threadRouteControls";

export interface ThreadDetailScreenProps {
  readonly header?: React.ReactNode;
  readonly draftMode?: {
    readonly content: (
      headerInset: number,
      bottomInset: number,
      availableHeight: number,
    ) => React.ReactNode;
    readonly controls: React.ReactNode;
    readonly editorRef: React.RefObject<ComposerEditorHandle | null>;
    readonly sendBlockedReason: string | null;
    readonly interactionLocked: boolean;
  };
  readonly worktreeSetup?: WorktreeSetupCardProps | null;
  readonly setupWorkingStartedAt?: string | null;
  readonly canOperateThread: boolean;
  readonly selectedThread: EnvironmentThreadShell;
  /** Use this for detail reads; it stays null until queued creation reaches the server. */
  readonly selectedThreadDetailRef: ScopedThreadRef | null;
  readonly contentPresentation: ThreadContentPresentation;
  readonly screenTone: StatusTone;
  readonly connectionError: string | null;
  readonly environmentLabel: string | null;
  readonly feedbackSubmissions: ReadonlyArray<CodexFeedbackSubmission>;
  readonly onDismissFeedback: (id: MessageId) => void;
  readonly selectedThreadFeed: ReadonlyArray<ThreadFeedEntry>;
  readonly pendingHandoff?: HandoffEndpoints | null;
  readonly activityRun: ThreadFeedLatestRun | null;
  readonly activeWorkStartedAt: string | null;
  readonly runlessWorkActive?: boolean;
  readonly providerSubagentStatus?: ProviderSubagentStatus | null;
  readonly isCompacting: boolean;
  readonly creationState:
    | {
        readonly kind: "preparing";
        readonly preparingWorktree: boolean;
        readonly serverOwned: boolean;
      }
    | { readonly kind: "failed"; readonly reason: string; readonly onEditTask: () => void }
    | null;
  readonly activePendingApproval: PendingApproval | null;
  readonly activePendingApprovals: ReadonlyArray<PendingApproval>;
  readonly respondingApprovalId: RuntimeRequestId | null;
  readonly activePendingUserInput: PendingUserInput | null;
  readonly activePendingUserInputDrafts: Record<string, PendingUserInputDraftAnswer>;
  readonly activePendingUserInputAnswers: Record<string, string | ReadonlyArray<string>> | null;
  readonly respondingUserInputId: RuntimeRequestId | null;
  readonly connectionStateLabel: EnvironmentConnectionPhase;
  readonly threadSyncStatus?: EnvironmentThreadStatus;
  readonly historyControls?: ThreadFeedHistoryControls;
  readonly activeThreadBusy: boolean;
  readonly canStopThread: boolean;
  readonly queuedRunEdit: QueuedRunEdit | null;
  readonly composerDraftKey: string | null;
  readonly followUpBehavior: FollowUpBehavior;
  readonly canSteerActiveTurn: boolean;
  readonly isSavingQueuedEdit: boolean;
  readonly onCancelQueuedRunEdit: () => void;
  readonly onRemoveQueuedEditAttachment: (attachmentId: string) => void;
  readonly environmentId: EnvironmentId;
  readonly projectWorkspaceRoot: string | null;
  readonly threadCwd: string | null;
  readonly selectedThreadQueueCount: number;
  readonly queuedMessages: ReadonlyArray<QueuedThreadMessage>;
  readonly dispatchingMessageId: MessageId | null;
  readonly serverConfig: LecturnServerConfig | null;
  readonly layoutVariant?: LayoutVariant;
  readonly usesAutomaticContentInsets?: boolean;
  readonly onHeaderMaterialVisibilityChange?: (visible: boolean) => void;
  readonly onOpenConnectionEditor: () => void;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onPickDraftMedia: () => Promise<void>;
  readonly onPickDraftFiles: () => Promise<void>;
  readonly onNativePasteImages: (uris: ReadonlyArray<string>) => Promise<void>;
  readonly onNativePasteText: (paste: ComposerTextPaste) => Promise<void>;
  readonly onRemoveDraftImage: (imageId: string) => void;
  readonly onStopThread: () => void;
  /** Present while the thread's queue is held. */
  readonly onResumeQueue: (() => Promise<void>) | null;
  readonly onSendMessage: (
    followUp?: ActiveTurnComposerAction,
    beforeDispatch?: (
      text: string,
      hasAttachmentsOrContext: boolean,
    ) => Promise<boolean | "responded">,
  ) => Promise<MessageId | null>;
  readonly onReconnectEnvironment: () => void;
  readonly canSwitchThreadProvider: boolean;
  readonly onUpdateThreadModelSelection: (modelSelection: ModelSelection) => void;
  readonly onUpdateThreadRuntimeMode: (runtimeMode: RuntimeMode) => void;
  readonly onUpdateThreadInteractionMode?: (interactionMode: ProviderInteractionMode) => void;
  readonly onRespondToApproval: ApprovalResponder;
  readonly onSelectUserInputOption: (
    requestId: RuntimeRequestId,
    question: ThreadUserInputQuestion,
    value: string,
  ) => void;
  readonly onChangeUserInputCustomAnswer: (
    requestId: RuntimeRequestId,
    questionId: string,
    customAnswer: string,
  ) => void;
  readonly onSubmitUserInput: () => Promise<unknown>;
  readonly onDismissUserInput: () => Promise<unknown>;
  readonly showContent?: boolean;
  /** Lecturn: the controls allowlist from the thread route; absent keeps every control. */
  readonly controls?: ThreadRouteControls;
  /** Lecturn: a Squire's home thread prompts with what it is for. */
  readonly composerPlaceholder?: string;
}

/** Keep the thread configuration visible while its composer is parked. */
function SettledThreadMetadata({
  thread,
  serverConfig,
}: {
  readonly thread: EnvironmentThreadShell;
  readonly serverConfig: LecturnServerConfig | null;
}) {
  const model = buildModelOptions(
    serverConfig,
    thread.modelSelection,
    undefined,
    thread.projectId,
  ).find(
    (option) =>
      option.selection.instanceId === thread.modelSelection.instanceId &&
      option.selection.model === thread.modelSelection.model,
  );
  const optionLabels = providerOptionValueLabels(
    resolveProviderOptionDescriptors({
      capabilities: model?.capabilities,
      selections: thread.modelSelection.options,
    }),
  );
  const mode =
    RUNTIME_MODE_CHOICES.find((choice) => choice.mode === thread.runtimeMode)?.label ??
    thread.runtimeMode;
  return (
    <View
      style={{ alignItems: "center", paddingTop: 12, gap: 6 }}
      accessible
      accessibilityLabel={[
        model?.label ?? thread.modelSelection.model,
        ...optionLabels,
        mode,
        thread.interactionMode === "plan" ? "Plan mode" : "Chat mode",
      ].join(", ")}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <ProviderIcon iconUrl={model?.providerIconUrl} provider={model?.providerDriver} size={16} />
        <Text className="text-sm text-foreground-muted">
          {model?.label ?? thread.modelSelection.model}
        </Text>
      </View>
      <Text className="text-xs text-foreground-muted" style={{ textAlign: "center" }}>
        {[
          ...optionLabels,
          mode,
          thread.interactionMode === "plan" ? "Plan mode" : "Chat mode",
        ].join(" · ")}
      </Text>
    </View>
  );
}

function latestStreamingAssistantMessage(
  feed: ReadonlyArray<ThreadFeedEntry>,
): { readonly id: string; readonly textLength: number } | null {
  for (let index = feed.length - 1; index >= 0; index -= 1) {
    const entry = feed[index];
    if (entry?.type !== "message") {
      continue;
    }
    if (entry.message.role !== "assistant" || !entry.message.streaming) {
      continue;
    }
    return {
      id: entry.message.id,
      textLength: entry.message.text.length,
    };
  }

  return null;
}

function useStreamingHaptics(threadId: ThreadId, feed: ReadonlyArray<ThreadFeedEntry>) {
  const lastStreamingAssistantRef = useRef<{
    readonly id: string;
    readonly textLength: number;
  } | null>(null);
  const lastStreamHapticAtRef = useRef(0);
  const hydratedRef = useRef(false);
  const previousThreadIdRef = useRef(threadId);

  useEffect(() => {
    if (previousThreadIdRef.current !== threadId) {
      previousThreadIdRef.current = threadId;
      hydratedRef.current = false;
    }

    const latestStreamingMessage = latestStreamingAssistantMessage(feed);

    if (!hydratedRef.current) {
      hydratedRef.current = true;
      lastStreamingAssistantRef.current = latestStreamingMessage;
      return;
    }

    if (!latestStreamingMessage) {
      lastStreamingAssistantRef.current = null;
      return;
    }

    const previousStreamingMessage = lastStreamingAssistantRef.current;
    lastStreamingAssistantRef.current = latestStreamingMessage;

    const isNewStream = previousStreamingMessage?.id !== latestStreamingMessage.id;
    const textGrew =
      previousStreamingMessage?.id === latestStreamingMessage.id &&
      latestStreamingMessage.textLength > previousStreamingMessage.textLength;

    if (!isNewStream && !textGrew) {
      return;
    }

    const now = Date.now();
    if (!isNewStream && now - lastStreamHapticAtRef.current < 320) {
      return;
    }

    lastStreamHapticAtRef.current = now;
    void Haptics.selectionAsync();
  }, [threadId, feed]);
}

const USAGE_LIMITS_PANEL_GAP = 12;
const USAGE_LIMITS_PANEL_MIN_HEIGHT = 44;

const USER_INPUT_TOGGLE_TIMING = {
  duration: USER_INPUT_TOGGLE_DURATION_MS,
  easing: Easing.out(Easing.cubic),
};

// A scheduled wake can happen without a newer server update, so the tracker
// is told when one takes effect. The shell's updatedAt ticks while a run
// streams; the tracker follows it outside React.
const wakeAwareVisitShell = Atom.family((key: string) => {
  const ref = parseThreadKey(key);
  return Atom.make((get) => {
    const shell = get(environmentThreadShells.threadShellAtom(ref));
    if (shell === null) return null;
    const nowMs = Date.now();
    const wokeAt = threadWokeAt(shell, { now: new Date(nowMs).toISOString() });
    const wakeAtMs = shell.snoozedUntil == null ? NaN : Date.parse(shell.snoozedUntil);
    if (wokeAt === null && wakeAtMs > nowMs) {
      const timer = setTimeout(
        () => get.refreshSelf(),
        Math.min(wakeAtMs - nowMs + 50, 2_147_483_647),
      );
      get.addFinalizer(() => clearTimeout(timer));
    }
    return { ...shell, wokeAt };
  }).pipe(Atom.withLabel(`mobile-thread-visit-shell:${key}`));
});

const threadVisitTracker = createThreadVisitTracker({
  threadShellAtom: (ref) => wakeAwareVisitShell(threadKey(ref)),
  visit: threadEnvironment.visit,
});

// Past the composer's 180 ms height animation.
const COMPOSER_HEIGHT_SETTLE_MS = 220;

export function ThreadDetailScreen(props: ThreadDetailScreenProps) {
  return (
    <AccountTintScope environmentId={props.environmentId}>
      <ThreadDetailScreenContent {...props} />
    </AccountTintScope>
  );
}

const ThreadDetailScreenContent = function ThreadDetailScreenContent(
  props: ThreadDetailScreenProps,
) {
  const usesNativeWorkspaceColumns = useNativeWorkspaceColumnsSupported();
  const deviceType = useDeviceType();
  const workspace = useWorkspaceTabs();
  const sidebarSearchActive =
    deviceType === "duo-unfolded" &&
    workspace?.state.tabs[workspace.state.selectedTab].searchMode === "active";
  // Keep the last input owner through keyboard dismissal, so closing sidebar
  // search cannot briefly lift the composer into the keyboard's closing frame.
  const [composerOwnsKeyboard, setComposerOwnsKeyboard] = useState(false);
  if (sidebarSearchActive && composerOwnsKeyboard) setComposerOwnsKeyboard(false);
  const navigation = useNavigation();
  // Lecturn: each gated control site below reads the controls allowlist through this.
  const allows = (control: ThreadRouteControl) => allowsThreadRouteControl(props.controls, control);
  const openLinkedThread = useOpenLinkedThread();
  const openInspector = useOpenThreadInspector();
  const { session: voiceInputSession } = useGlobalVoiceInput();
  const reportedModelSelection = useThreadReportedModelSelection(props.selectedThreadDetailRef);
  const deviceState = useEnvironmentQuery(
    deviceEnvironment.state({ environmentId: props.environmentId, input: {} }),
  );
  const devicePreviews = threadDevicePreviews(deviceState.data, props.selectedThread.id);
  const openDevicePreview = () => {
    Keyboard.dismiss();
    if (
      openInspector(
        { environmentId: props.environmentId, threadId: props.selectedThread.id },
        { type: "device", environmentId: props.environmentId, threadId: props.selectedThread.id },
      )
    )
      return;
    navigation.navigate("ThreadDevicePreview", {
      environmentId: props.environmentId,
      threadId: props.selectedThread.id,
    });
  };
  const browserTabs = useThreadServerBrowserTabs({
    environmentId: props.environmentId,
    threadId: props.selectedThread.id,
    enabled:
      !props.draftMode && props.serverConfig?.environment.capabilities.serverBrowser === true,
  });
  const openBrowserPreview = (tabId?: string) => {
    Keyboard.dismiss();
    navigation.navigate("ThreadBrowserPreview", {
      environmentId: props.environmentId,
      threadId: props.selectedThread.id,
      ...(tabId === undefined ? {} : { tabId }),
    });
  };
  const insets = useSafeAreaInsets();
  // Lecturn: without Unsettle on the allowlist, a settled thread keeps its composer.
  const settled = props.selectedThread.settledOverride === "settled" && allows("unsettle");
  const { unsettleThread } = useThreadListActions();
  const [unsettling, setUnsettling] = useState(false);
  useEffect(() => {
    if (settled) Keyboard.dismiss();
  }, [settled]);
  const handleUnsettle = async () => {
    if (unsettling) return;
    setUnsettling(true);
    await settlePromise(() =>
      unsettleThread({ ...props.selectedThread, environmentId: props.environmentId }),
    );
    setUnsettling(false);
  };
  const isKeyboardVisible = useKeyboardState((state) => state.isVisible);
  const liveKeyboardHeight = useKeyboardState((state) => state.height);
  // Android can lose IME hide callbacks on backgrounding. Quarantine translation on resume unless focused input retained its keyboard.
  const [keyboardStateSuspect, setKeyboardStateSuspect] = useState(false);
  const ownedInputFocusedRef = useRef(false);
  useEffect(() => {
    if (Platform.OS !== "android") {
      return;
    }
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        setKeyboardStateSuspect(!ownedInputFocusedRef.current);
      }
    });
    return () => {
      subscription.remove();
    };
  }, []);
  useEffect(() => {
    setKeyboardStateSuspect(false);
  }, [isKeyboardVisible, liveKeyboardHeight]);
  const handleOwnedInputFocusChange = (focused: boolean) => {
    ownedInputFocusedRef.current = focused;
    if (focused) {
      if (deviceType === "duo-folded" || deviceType === "duo-unfolded")
        setComposerOwnsKeyboard(true);
      setKeyboardStateSuspect(false);
    }
  };
  const windowHeight = useWindowDimensions().height;
  const navigationHeaderHeight = useContext(HeaderHeightContext) ?? insets.top + 44;
  const [screenMetrics, setScreenMetrics] = useState<NativeLayoutMetrics | null>(null);
  const columnMetrics = useNativeColumnLayoutMetrics();
  const windowMetrics = useNativeLayoutMetrics();
  const nativeMetrics = usesNativeWorkspaceColumns ? columnMetrics : screenMetrics;
  const controlInsets = deriveBottomControlInsets(nativeMetrics);
  const agentLabel = `${props.selectedThread.modelSelection.instanceId} agent`;
  const selectedThreadKey = scopedThreadKey(props.environmentId, props.selectedThread.id);
  const childThreadInputs = useChildThreadInputs({
    environmentId: props.environmentId,
    threadId: props.selectedThread.id,
  });
  const composerError = useAtomValue(threadComposerErrorsAtom)[selectedThreadKey]?.message ?? null;
  const queuedCount = useThreadQueuedCount(props.selectedThreadDetailRef);
  const turnSubagents = useThreadTurnSubagents(props.selectedThreadDetailRef);
  const agentsSegment = resolveSubagentPillSegment(turnSubagents);
  const defaultComposerEditorRef = useRef<ComposerEditorHandle>(null);
  const composerEditorRef = props.draftMode?.editorRef ?? defaultComposerEditorRef;
  const isProviderSubagent = isProviderNativeSubagentThread(props.selectedThread.source);
  const editingRunId = props.queuedRunEdit?.runId ?? null;
  useEffect(() => {
    if (editingRunId === null) return;
    const frame = requestAnimationFrame(() => composerEditorRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [editingRunId, composerEditorRef]);
  const composerOverlayRef = useRef<ViewInstance>(null);
  const listRef = useRef<LegendListRef>(null);
  const feedTouchStartRef = useRef<{ pageX: number; pageY: number } | null>(null);
  const selectedThreadKeyRef = useRef(selectedThreadKey);
  const lastScrolledSubmittedMessageIdRef = useRef<MessageId | null>(null);
  const [composerHeight, setComposerHeight] = useState<number | null>(null);
  // The composer animates its height and reports a layout every frame. The feed follows those
  // frames on the UI thread through onComposerLayout; this is only an estimate, so committing
  // each frame would re-render the whole screen for the length of the animation.
  const composerHeightSettle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleComposerHeightChange = useCallback((height: number) => {
    setComposerHeight((current) => current ?? height);
    if (composerHeightSettle.current !== null) clearTimeout(composerHeightSettle.current);
    composerHeightSettle.current = setTimeout(() => {
      composerHeightSettle.current = null;
      setComposerHeight(height);
    }, COMPOSER_HEIGHT_SETTLE_MS);
  }, []);
  useEffect(
    () => () => {
      if (composerHeightSettle.current !== null) clearTimeout(composerHeightSettle.current);
    },
    [],
  );
  const [anchorMessageId, setAnchorMessageId] = useState<MessageId | null>(null);
  const [submittedMessageId, setSubmittedMessageId] = useState<MessageId | null>(null);
  const [endFollowEnabled, setEndFollowEnabled] = useState(true);
  // Keep the bottom padding fixed while the keyboard animates. Changing it at
  // keyboardDidHide makes the composer land low, then jump back above the safe area.
  const bottomBarInset = useDuoBottomBarInset();
  const hasSidebarTabBar = useSidebarWorkspaceTabs() === "picker";
  // A pushed screen temporarily inherits the outgoing tab bar's safe area.
  // Use the window edge so hiding that bar cannot move the composer mid-push.
  const bottomSafeArea =
    Platform.OS === "ios" ? (windowMetrics?.safeArea.bottom ?? insets.bottom) : insets.bottom;
  // The pill already adds its own gutter; iPad and Duo align its edge with the native bar.
  const alignedBottomInset =
    bottomBarInset ??
    (Platform.OS === "ios" && Platform.isPad
      ? Math.max(bottomSafeArea, 12) - (hasSidebarTabBar ? 5 : 0)
      : undefined);
  // The Duo's floating sidebar pill ends three points below the composer's usual gutter.
  const composerBottomInset = Math.max(
    0,
    (alignedBottomInset !== undefined
      ? alignedBottomInset - THREAD_COMPOSER_BOTTOM_GUTTER
      : Math.max(bottomSafeArea, 12)) - (hasSidebarTabBar ? 3 : 0),
  );
  const composerKeyboardOffset = composerBottomInset;
  const contentPresentationKind = props.contentPresentation.kind;
  const realThreadSyncLabel = (() => {
    switch (props.threadSyncStatus) {
      case "empty":
      case "cached":
      case "synchronizing":
        if (contentPresentationKind === "ready") {
          return "Syncing messages...";
        }
        return contentPresentationKind === "loading" ? "Loading messages..." : null;
      default:
        return null;
    }
  })();
  const threadSyncLabel = useDelayedStatus(selectedThreadKey, realThreadSyncLabel);
  const interruptThreadTurn = useAtomCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const unsnoozeThread = useAtomCommand(threadEnvironment.unsnooze, { reportFailure: false });
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: false });
  const visitThread = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const [statusRequest, setStatusRequest] = useState<{ threadKey: string } | null>(null);
  const statusPending = statusRequest?.threadKey === selectedThreadKey;
  const [lifecycleNow, setLifecycleNow] = useState(() => new Date().toISOString());
  useFocusEffect(
    useCallback(() => {
      setLifecycleNow(new Date().toISOString());
      const timer = setInterval(() => setLifecycleNow(new Date().toISOString()), 60_000);
      return () => clearInterval(timer);
    }, []),
  );
  const snoozed =
    props.serverConfig?.environment.capabilities.threadSnooze === true &&
    effectiveSnoozed(props.selectedThread, { now: lifecycleNow });
  const snoozedUntil = props.selectedThread.snoozedUntil;
  useEffect(() => {
    if (!snoozed || snoozedUntil === null) return;
    const timer = setTimeout(
      () => setLifecycleNow(new Date().toISOString()),
      Math.min(Math.max(0, Date.parse(snoozedUntil) - Date.now()) + 50, 2_147_483_647),
    );
    return () => clearTimeout(timer);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Re-arm if timer clamping fires before the wake time.
  }, [snoozed, snoozedUntil, lifecycleNow]);
  // Lecturn: the settled card above the composer owns Unsettle, so the floating status only
  // reports snoozed and woke threads; settlement still decides whether a wake is unseen.
  const lifecycleSettled =
    props.serverConfig?.environment.capabilities.threadSettlement === true &&
    props.selectedThread.settledOverride === "settled";
  const wokeAt =
    props.serverConfig?.environment.capabilities.threadSnooze === true
      ? threadWokeAt(props.selectedThread, { now: lifecycleNow })
      : null;
  const woke = isThreadWokeUnseen({
    wokeAt,
    settled: lifecycleSettled,
    lastVisitedAt: props.selectedThread.lastVisitedAt,
    latestRunCompletedAt: props.selectedThread.latestRun?.completedAt ?? null,
  });
  const runStatusAction = async (action: "stop" | "wake" | "dismiss") => {
    if (statusPending || !props.canOperateThread) return;
    const request = { threadKey: selectedThreadKey };
    setStatusRequest(request);
    const target = {
      environmentId: props.environmentId,
      input: { threadId: props.selectedThread.id },
    };
    const recovery = props.selectedThread.limitRecovery;
    const recoveryOwnsSnooze =
      recovery?.snooze === true &&
      recovery.runId === props.selectedThread.latestRun?.runId &&
      snoozedUntil !== null &&
      Date.parse(snoozedUntil) === Date.parse(recovery.resetAt);
    const result =
      action === "stop"
        ? await interruptThreadTurn(target)
        : action === "wake"
          ? recoveryOwnsSnooze
            ? await updateMetadata({
                ...target,
                input: {
                  ...target.input,
                  limitRecovery: {
                    runId: recovery.runId,
                    resetAt: recovery.resetAt,
                    snooze: false,
                  },
                },
              })
            : await unsnoozeThread({ ...target, input: { ...target.input, reason: "user" } })
          : await visitThread({
              ...target,
              input: { ...target.input, visitedAt: wokeAt ?? lifecycleNow },
            });
    // An accepted interrupt can leave tasks running. Release the action for retry.
    setStatusRequest((current) => (current === request ? null : current));
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        "Could not update thread",
        error instanceof Error ? error.message : "Try again.",
      );
    }
  };
  const pendingBackgroundWork = presentPendingBackgroundWork(
    props.selectedThread.pendingBackgroundTasks,
  );
  const floatingStatus = ((): FloatingWorkingStatus | null => {
    const connectionStatus = connectionFloatingStatus({
      connectionError: props.connectionError,
      connectionState: props.connectionStateLabel,
      environmentLabel: props.environmentLabel,
      onReconnect: props.onReconnectEnvironment,
    });
    if (connectionStatus !== null && !props.draftMode) {
      return connectionStatus;
    }
    if (props.activePendingApproval !== null || props.activePendingUserInput !== null) {
      return null;
    }
    if (props.creationState?.kind === "preparing") {
      if (props.worktreeSetup) return null;
      return {
        kind: "preparing",
        label: props.creationState.preparingWorktree ? "Setting up worktree…" : "Starting…",
      };
    }
    if (props.creationState?.kind === "failed") {
      return null;
    }
    if (threadSyncLabel !== null) {
      return { kind: "syncing", label: threadSyncLabel };
    }
    const childInput = childThreadInputs[0];
    if (childInput && contentPresentationKind === "ready") {
      return {
        kind: "child-input",
        label: childThreadInputsTitle(childThreadInputs),
        accessibilityLabel: `Open ${childInput.hasPendingApprovals ? "approval" : "question"} from ${childInput.title}`,
        onPress: () => {
          Keyboard.dismiss();
          openLinkedThread({ environmentId: props.environmentId, threadId: childInput.id });
        },
      };
    }
    if (props.isCompacting && contentPresentationKind === "ready") {
      return { kind: "compacting" };
    }
    if (props.activeWorkStartedAt !== null && contentPresentationKind === "ready") {
      return { kind: "working", startedAt: props.activeWorkStartedAt };
    }
    if (pendingBackgroundWork !== null && contentPresentationKind === "ready") {
      return {
        kind: "background",
        label: pendingBackgroundWork.title,
        accessibilityLabel: `${pendingBackgroundWork.title}: ${pendingBackgroundWork.items
          .map((item) => item.label)
          .join(", ")}`,
        waiting: pendingBackgroundWork.waiting,
        onPress: () => {
          Keyboard.dismiss();
          navigation.navigate("ThreadBackgroundWork", {
            environmentId: props.environmentId,
            threadId: props.selectedThread.id,
          });
        },
        action: allows("stop")
          ? {
              label: statusPending ? "Stopping..." : "Stop",
              accessibilityLabel: "Stop background work",
              disabled: !props.canOperateThread || statusPending,
              onPress: () => void runStatusAction("stop"),
            }
          : null,
      };
    }
    if (contentPresentationKind === "ready" && allows("thread-actions") && (snoozed || woke)) {
      const label =
        snoozed && snoozedUntil !== null
          ? `Snoozed, wakes in ${snoozeWakeLabel(snoozedUntil, { now: lifecycleNow })}`
          : "Woke from snooze";
      const actionLabel = snoozed ? "Wake now" : "Dismiss";
      return {
        kind: "lifecycle",
        state: snoozed ? "snoozed" : "woke",
        label,
        action: {
          label: statusPending ? (snoozed ? "Waking..." : "Dismissing...") : actionLabel,
          accessibilityLabel: actionLabel,
          disabled: !props.canOperateThread || statusPending,
          onPress: () => void runStatusAction(snoozed ? "wake" : "dismiss"),
        },
      };
    }
    if (props.selectedThread.goal !== null && contentPresentationKind === "ready") {
      const goal = presentProviderGoal(props.selectedThread.goal, false);
      return {
        kind: "goal",
        label: goal.title,
        accessibilityLabel: `${goal.title}: ${goal.objective}`,
      };
    }
    return null;
  })();
  const showWorkingControl = floatingStatus !== null;
  const showFloatingStatus =
    showWorkingControl ||
    queuedCount > 0 ||
    agentsSegment !== null ||
    devicePreviews.length > 0 ||
    browserTabs.tabs.length > 0 ||
    props.connectionStateLabel !== "connected" ||
    props.queuedMessages.length > 0 ||
    props.selectedThreadFeed.some(
      (entry) => "acknowledged" in entry && entry.acknowledged === true,
    );
  const selectedThreadFeed = props.selectedThreadFeed;
  // A palette message result opens the thread at that message: earlier
  // history loads until the message is in the feed, which then scrolls to it.
  const jumpMessageId = useSyncExternalStore(subscribeThreadMessageJump, () =>
    pendingThreadMessageJump(selectedThreadKey),
  );
  const jumpMessageLoaded =
    jumpMessageId !== null &&
    selectedThreadFeed.some((entry) => entry.type === "message" && entry.id === jumpMessageId);
  // A jump this screen never reached lets go when the thread closes.
  useEffect(() => () => finishThreadMessageJump(selectedThreadKey), [selectedThreadKey]);
  const historyForJump = props.historyControls;
  // History down to the message in one request; another page if it is not
  // there yet.
  const loadEarlierForJump = useEffectEvent(() => {
    if (jumpMessageId !== null) historyForJump?.onLoadThrough(jumpMessageId);
  });
  useEffect(() => {
    if (jumpMessageId === null || jumpMessageLoaded || contentPresentationKind !== "ready") return;
    if (historyForJump?.loading) return;
    if (!historyForJump?.hasMoreHistory || historyForJump.error !== null) {
      finishThreadMessageJump(selectedThreadKey);
      return;
    }
    loadEarlierForJump();
  }, [
    contentPresentationKind,
    historyForJump?.error,
    historyForJump?.hasMoreHistory,
    historyForJump?.loading,
    jumpMessageId,
    jumpMessageLoaded,
    selectedThreadKey,
  ]);
  const hasCompactableConversation =
    selectedThreadFeed.some(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "user" &&
        ((entry.message.attachments?.length ?? 0) > 0 ||
          entry.message.text.trim().toLowerCase() !== "/compact"),
    ) ||
    (props.historyControls?.hasMoreHistory === true &&
      props.selectedThread.latestUserMessageAt !== null);
  const composerOverlapHeight =
    composerHeight ?? COMPOSER_COLLAPSED_CHROME + (hasSidebarTabBar ? 14 : 0) + composerBottomInset;
  const [collapsedUserInputRequestId, setCollapsedUserInputRequestId] =
    useState<RuntimeRequestId | null>(null);
  const activeUserInputRequestId = props.activePendingUserInput?.requestId ?? null;
  // A settled thread, a pending user-input request, or a failed creation owns
  // the composer slot.
  const composerSlotHidden =
    settled || activeUserInputRequestId !== null || props.creationState?.kind === "failed";
  const [usageLimitsPanel, setUsageLimitsPanel] = useState<{
    readonly key: string;
    readonly threadKey: string;
    readonly now: number;
  } | null>(null);
  // Approval/question identity invalidates quota: answering on any client resumes spending.
  const usageLimitsKey = [
    selectedThreadKey,
    props.selectedThread.modelSelection.instanceId,
    props.selectedThread.latestRun?.runId ?? "",
    props.activePendingApproval?.requestId ?? props.activePendingUserInput?.requestId ?? "",
  ].join(":");
  if (usageLimitsPanel !== null && usageLimitsPanel.key !== usageLimitsKey) {
    setUsageLimitsPanel(null);
  }
  const usageLimitsReport =
    usageLimitsPanel !== null && usageLimitsPanel.key === usageLimitsKey
      ? collectProviderUsageLimits(
          props.selectedThread.modelSelection.instanceId,
          props.serverConfig?.providers ?? [],
          props.serverConfig?.usageLimitSources ?? [],
          usageLimitsPanel.now,
        )
      : null;
  const showUsageLimits = (report: UsageLimitsReport | null) =>
    setUsageLimitsPanel(
      report === null
        ? null
        : {
            key: usageLimitsKey,
            threadKey: selectedThreadKey,
            now: Date.parse(report.createdAt),
          },
    );
  const dismissUsageLimits = () => setUsageLimitsPanel(null);
  // Late sends clear only their originating thread's limits panel.
  const clearUsageLimitsFor = (threadKey: string) =>
    setUsageLimitsPanel((current) =>
      current !== null && current.threadKey === threadKey ? null : current,
    );
  const userInputCollapsed =
    activeUserInputRequestId !== null && collapsedUserInputRequestId === activeUserInputRequestId;
  // A height React sets from keyboard state lags the sticky translation by a Yoga pass and
  // flashes over the nav header on the way up, so the usage panel reserves the keyboard instead.
  const [lastKnownKeyboardHeight, setLastKnownKeyboardHeight] = useState(0);
  useEffect(() => {
    if (liveKeyboardHeight > 0 && liveKeyboardHeight !== lastKnownKeyboardHeight) {
      setLastKnownKeyboardHeight(liveKeyboardHeight);
    }
  }, [lastKnownKeyboardHeight, liveKeyboardHeight]);
  const reservedKeyboardHeight =
    lastKnownKeyboardHeight > 0 ? lastKnownKeyboardHeight : ESTIMATED_KEYBOARD_HEIGHT;
  // Waiting for a visibility render misses the first keyboard frames.
  const keyboardStickyEnabled =
    Platform.OS === "ios"
      ? deviceType !== "duo-unfolded" || (composerOwnsKeyboard && !sidebarSearchActive)
      : !keyboardStateSuspect;
  const estimatedOverlayHeight = composerOverlapHeight;
  // UIKit adds safe-area bottom to overlay insets; subtract here and include it in ThreadFeed scroll math.
  const nativeInsetOvercount =
    props.usesAutomaticContentInsets === true && Platform.OS === "ios" ? insets.bottom : 0;
  const { contentInsetEndAdjustment, onComposerLayout } = useKeyboardChatComposerInset(
    listRef,
    composerOverlayRef,
    Math.max(0, estimatedOverlayHeight - nativeInsetOvercount),
    -nativeInsetOvercount,
    // The composer already reports its animated height on each layout.
    // Easing these samples again makes the feed trail behind it.
    0,
  );
  // Android lays the screen out below its opaque header and reports a zero
  // header height, so the window height overstates the room by the header.
  const [screenHeight, setScreenHeight] = useState<number | null>(null);
  const handleScreenLayout = useCallback((event: LayoutChangeEvent) => {
    setScreenHeight(event.nativeEvent.layout.height);
  }, []);
  const screenAreaHeight = screenHeight ?? windowHeight;
  // The question card reads the keyboard frame on the UI thread, in the same frame the sticky
  // view translates, so it gets the full height while the keyboard is closed and never crosses
  // the header while the keyboard moves.
  const { height: keyboardTranslation } = useReanimatedKeyboardAnimation();
  const pendingUserInputMaxHeight = useDerivedValue(() =>
    derivePendingUserInputMaxHeight({
      windowHeight: screenAreaHeight,
      keyboardHeight: keyboardStickyEnabled ? -keyboardTranslation.value : 0,
      navigationHeaderHeight,
      composerOverlapHeight: composerBottomInset,
    }),
  );
  // The usage panel stacks with the composer and any approval card, so it gets
  // whatever room they leave below the header. Measured only while it is open
  // so typing in the composer does not re-render the screen.
  const usageLimitsOpen = usageLimitsReport !== null && activeUserInputRequestId === null;
  const [usageLimitsLayout, setUsageLimitsLayout] = useState({ overlay: 0, panel: 0 });
  const handleComposerOverlayLayout = useCallback(
    (event: LayoutChangeEvent) => {
      onComposerLayout(event);
      if (!usageLimitsOpen) return;
      const overlay = event.nativeEvent.layout.height;
      setUsageLimitsLayout((current) =>
        current.overlay === overlay ? current : { ...current, overlay },
      );
    },
    [onComposerLayout, usageLimitsOpen],
  );
  const handleUsageLimitsLayout = useCallback((event: LayoutChangeEvent) => {
    const panel = event.nativeEvent.layout.height;
    setUsageLimitsLayout((current) => (current.panel === panel ? current : { ...current, panel }));
  }, []);
  const overlayBesideUsageLimits =
    usageLimitsLayout.overlay > 0
      ? usageLimitsLayout.overlay - usageLimitsLayout.panel
      : composerOverlapHeight;
  // The floor keeps the close row on screen when the stack below leaves no room at all.
  const usageLimitsMaxHeight = Math.max(
    USAGE_LIMITS_PANEL_MIN_HEIGHT,
    Math.min(
      Math.round(screenAreaHeight * 0.4),
      screenAreaHeight -
        navigationHeaderHeight -
        reservedKeyboardHeight -
        overlayBesideUsageLimits -
        USAGE_LIMITS_PANEL_GAP * 2,
    ),
  );
  const userInputCardProgress = useSharedValue(1);
  const userInputInsetProgress = useSharedValue(1);
  const userInputCardCoverage = useSharedValue(0);
  const composerPopoverHeight = useSharedValue(0);
  const floatingControlCoverage = useSharedValue(
    showFloatingStatus ? FLOATING_WORKING_CONTROL_COVERAGE : 0,
  );
  useEffect(() => {
    floatingControlCoverage.value = withTiming(
      showFloatingStatus ? FLOATING_WORKING_CONTROL_COVERAGE : 0,
      { duration: 180, reduceMotion: ReduceMotion.System },
    );
  }, [floatingControlCoverage, showFloatingStatus]);
  // Android measures its expanded card in-flow; only iOS needs extra overlay coverage.
  const userInputCoverageApplies = Platform.OS === "ios" && activeUserInputRequestId !== null;
  const combinedContentInsetEndAdjustment = useSharedValue(
    Math.max(0, estimatedOverlayHeight - nativeInsetOvercount),
  );
  useAnimatedReaction(
    () =>
      contentInsetEndAdjustment.value +
      floatingControlCoverage.value +
      (userInputCoverageApplies ? userInputInsetProgress.value * userInputCardCoverage.value : 0),
    (value) => {
      combinedContentInsetEndAdjustment.value = value;
    },
    [userInputCoverageApplies],
  );
  const composerPopoverLift = useDerivedValue(() =>
    withTiming(
      !composerSlotHidden && composerPopoverHeight.value > 0 ? composerPopoverHeight.value + 8 : 0,
      { duration: 180, easing: Easing.out(Easing.cubic), reduceMotion: ReduceMotion.System },
    ),
  );
  const floatingControlLift = useDerivedValue(
    () =>
      Math.max(
        userInputCoverageApplies ? userInputCardProgress.value * userInputCardCoverage.value : 0,
        composerPopoverLift.value,
      ),
    [userInputCoverageApplies],
  );
  const { freeze, scrollMessageToEnd } = useKeyboardScrollToEnd({ listRef });
  const reduceMotion = useReducedMotion();
  // Repin timers fire after the render that scheduled them, so they read follow
  // state from the ref the writers below keep in step with it.
  const endFollowEnabledRef = useRef(true);
  const overlayRepinTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousWorkingControlStateRef = useRef({
    threadKey: selectedThreadKey,
    visible: false,
  });
  const handleEndFollowEnabledChange = (enabled: boolean) => {
    endFollowEnabledRef.current = enabled;
    setEndFollowEnabled(enabled);
  };
  const scheduleOverlayRepin = (delayMs: number) => {
    if (overlayRepinTimerRef.current !== null) {
      clearTimeout(overlayRepinTimerRef.current);
    }
    overlayRepinTimerRef.current = setTimeout(() => {
      overlayRepinTimerRef.current = null;
      if (!endFollowEnabledRef.current) {
        return;
      }
      void scrollMessageToEnd({ animated: false, closeKeyboard: false }).catch(() => {
        freeze.set(false);
      });
    }, delayMs);
  };
  useEffect(
    () => () => {
      if (overlayRepinTimerRef.current !== null) {
        clearTimeout(overlayRepinTimerRef.current);
      }
    },
    [],
  );
  useEffect(() => {
    const previous = previousWorkingControlStateRef.current;
    const threadChanged = previous.threadKey !== selectedThreadKey;
    const visibilityChanged = previous.visible !== showFloatingStatus;
    previousWorkingControlStateRef.current = {
      threadKey: selectedThreadKey,
      visible: showFloatingStatus,
    };
    if ((!threadChanged && !visibilityChanged) || (threadChanged && !showFloatingStatus)) {
      return;
    }
    // LegendList misses short-conversation re-anchoring after coverage changes; re-pin after transition only if still following.
    scheduleOverlayRepin(230);
  }, [scheduleOverlayRepin, selectedThreadKey, showFloatingStatus]);
  const handleToggleUserInputCollapsed = () => {
    if (activeUserInputRequestId === null) {
      return;
    }
    if (userInputCollapsed) {
      userInputCardProgress.set(withTiming(1, USER_INPUT_TOGGLE_TIMING));
      userInputInsetProgress.set(withTiming(1, USER_INPUT_TOGGLE_TIMING));
      setCollapsedUserInputRequestId(null);
      scheduleOverlayRepin(USER_INPUT_TOGGLE_DURATION_MS + 50);
    } else {
      Keyboard.dismiss();
      userInputCardProgress.set(withTiming(0, USER_INPUT_TOGGLE_TIMING));
      // The sinking card already covers this strip. Animating the inset downward would drift the end anchor.
      userInputInsetProgress.set(0);
      setCollapsedUserInputRequestId(activeUserInputRequestId);
      scheduleOverlayRepin(60);
    }
  };
  useEffect(() => {
    userInputCardProgress.set(1);
    userInputInsetProgress.set(1);
  }, [activeUserInputRequestId, userInputCardProgress, userInputInsetProgress]);
  const showContent = props.showContent ?? true;
  // Lecturn: frozen per open, and read in render so it precedes the tracker's visit below.
  const [unreadOpen, setUnreadOpen] = useState<{
    readonly threadKey: string;
    readonly window: ThreadUnreadWindow;
  } | null>(null);
  if (showContent && !props.draftMode && unreadOpen?.threadKey !== selectedThreadKey) {
    setUnreadOpen({
      threadKey: selectedThreadKey,
      window: {
        lastVisitedAt: props.selectedThread.lastVisitedAt ?? null,
        openedThrough: props.selectedThread.updatedAt,
      },
    });
  }
  // Showing the thread counts as viewing it, before its live shell arrives too.
  useAtomMount(
    threadVisitTracker(
      showContent && !props.draftMode
        ? { environmentId: props.environmentId, threadId: props.selectedThread.id }
        : null,
    ),
  );
  const layoutVariant = props.layoutVariant ?? "compact";
  const isSplitLayout = layoutVariant === "split";
  const contentMaxWidth =
    Platform.OS === "android"
      ? ANDROID_READING_MAX_WIDTH
      : isSplitLayout
        ? CHAT_CONTENT_MAX_WIDTH
        : undefined;
  const providerSubagentProvider = props.serverConfig?.providers.find(
    (provider) => provider.instanceId === props.selectedThread.modelSelection.instanceId,
  );
  const providerSubagentModelSlug = providerSubagentProvider
    ? resolveSelectableModel(
        providerSubagentProvider.driver,
        props.selectedThread.modelSelection.model,
        providerSubagentProvider.models,
      )
    : null;
  const providerSubagentCatalogModel = providerSubagentProvider?.models.find(
    (model) => model.slug === providerSubagentModelSlug,
  );
  const workspaceContentWidth = useWorkspaceContentWidth();
  // Clearing animated width can retain the unfolded width after Android resumes folded.
  const composerWidthStyle = useAnimatedStyle(() =>
    isSplitLayout && workspaceContentWidth !== null
      ? {
          width: Math.max(
            0,
            workspaceContentWidth.value - controlInsets.left - controlInsets.right,
          ),
          right: undefined,
        }
      : { width: "auto", right: controlInsets.right },
  );
  const selectedInstanceId = props.selectedThread.modelSelection.instanceId;
  useStreamingHaptics(props.selectedThread.id, props.selectedThreadFeed);
  const selectedProviderSkills = (() => {
    const provider = props.serverConfig?.providers.find(
      (candidate) => candidate.instanceId === selectedInstanceId,
    );
    return provider
      ? resolveProviderSkillsForCwd(provider, props.threadCwd ?? props.projectWorkspaceRoot)
      : [];
  })();

  useLayoutEffect(() => {
    selectedThreadKeyRef.current = selectedThreadKey;
  }, [selectedThreadKey]);

  useEffect(() => {
    setAnchorMessageId(null);
    setSubmittedMessageId(null);
    lastScrolledSubmittedMessageIdRef.current = null;
    endFollowEnabledRef.current = true;
    setEndFollowEnabled(true);
    freeze.set(false);
  }, [freeze, selectedThreadKey]);

  useEffect(() => {
    if (
      submittedMessageId === null ||
      anchorMessageId !== submittedMessageId ||
      lastScrolledSubmittedMessageIdRef.current === submittedMessageId ||
      contentPresentationKind !== "ready" ||
      (!selectedThreadFeed.some(
        (entry) => entry.type === "message" && entry.id === submittedMessageId,
      ) &&
        !props.queuedMessages.some((message) => message.messageId === submittedMessageId))
    ) {
      return;
    }

    const targetThreadKey = selectedThreadKey;
    const frame = requestAnimationFrame(() => {
      if (selectedThreadKeyRef.current !== targetThreadKey) {
        return;
      }
      lastScrolledSubmittedMessageIdRef.current = submittedMessageId;
      // Dismiss before scrollMessageToEnd freezes insets, or the missed hide leaves permanent padding.
      void KeyboardController.dismiss()
        .then(() => {
          if (
            selectedThreadKeyRef.current !== targetThreadKey ||
            lastScrolledSubmittedMessageIdRef.current !== submittedMessageId
          ) {
            return;
          }
          return scrollMessageToEnd({
            animated: !reduceMotion,
            closeKeyboard: false,
          });
        })
        .catch(() => {
          if (
            selectedThreadKeyRef.current !== targetThreadKey ||
            lastScrolledSubmittedMessageIdRef.current !== submittedMessageId
          ) {
            return;
          }
          lastScrolledSubmittedMessageIdRef.current = null;
          freeze.set(false);
        });
    });
    return () => cancelAnimationFrame(frame);
  }, [
    anchorMessageId,
    submittedMessageId,
    freeze,
    contentPresentationKind,
    props.queuedMessages,
    selectedThreadFeed,
    reduceMotion,
    scrollMessageToEnd,
    selectedThreadKey,
  ]);

  // A connected app's tool call gets an explicit answer on its card, so with one pending a send
  // declines nothing and goes out as any follow-up does.
  const sendDeclinesApprovals =
    props.activePendingApprovals.length > 0 && !hasAppToolApproval(props.activePendingApprovals);
  const activePendingApprovalsRef = useRef(props.activePendingApprovals);
  useLayoutEffect(() => {
    activePendingApprovalsRef.current = props.activePendingApprovals;
  }, [props.activePendingApprovals]);
  const handleSendMessage = async (
    followUp?: ActiveTurnComposerAction,
    stillSendable?: () => boolean,
  ) => {
    if (settled) return null;
    const targetThreadKey = selectedThreadKey;
    const hasUserMessage = selectedThreadFeed.some(
      (entry) => entry.type === "message" && entry.message.role === "user",
    );
    // Runs only once the send path has validated the draft and is about to deliver it, so an
    // empty submit, a queued-message edit, or `/feedback` leaves approvals alone.
    const approvalsToDecline = props.activePendingApprovals;
    const declineBeforeDispatch =
      sendDeclinesApprovals && props.activePendingUserInput === null
        ? async (text: string, hasAttachmentsOrContext: boolean) => {
            if (
              selectedThreadKeyRef.current !== targetThreadKey ||
              stillSendable?.() === false ||
              props.respondingApprovalId !== null
            )
              return false;
            const feedbackTarget = approvalsToDecline[0];
            if (feedbackTarget?.supportsFeedback) {
              if (hasAttachmentsOrContext) {
                Dialog.alert(
                  "Approval feedback",
                  "Send approval feedback without attachments or added context.",
                );
                return false;
              }
              return (await sendApprovalFeedback(feedbackTarget, text, props.onRespondToApproval))
                ? ("responded" as const)
                : false;
            }
            return (
              props.respondingApprovalId === null &&
              (await declinePendingApprovals(approvalsToDecline, props.onRespondToApproval)) &&
              selectedThreadKeyRef.current === targetThreadKey &&
              // A draft edited or pasted into during the decline isn't what the user sent.
              stillSendable?.() !== false &&
              // An approval that arrived during the decline would block the redirect; the draft
              // stays so the next send declines it too.
              !activePendingApprovalsRef.current.some(
                (approval) =>
                  !approvalsToDecline.some((declined) => declined.requestId === approval.requestId),
              )
            );
          }
        : undefined;
    const messageId = await props.onSendMessage(followUp, declineBeforeDispatch);
    if (messageId === null || selectedThreadKeyRef.current !== targetThreadKey) {
      return messageId;
    }

    clearUsageLimitsFor(targetThreadKey);

    setSubmittedMessageId(messageId);
    setAnchorMessageId(
      resolveThreadFeedSubmissionAnchor({
        currentAnchorMessageId: anchorMessageId,
        submittedMessageId: messageId,
        // An imported thread opens with history and no run of its own, so it
        // is never the empty thread the anchor is for.
        hasStartedTurn:
          props.selectedThread.latestRun !== null || props.selectedThread.importedFrom != null,
        hasUserMessage,
        queuedMessageCount: props.selectedThreadQueueCount,
        deliveryDeferred: props.connectionStateLabel !== "connected",
      }),
    );
    composerEditorRef.current?.blur();
    return messageId;
  };

  const handleEditPendingMessage = async (message: QueuedThreadMessage) => {
    const edited = await settlePromise(() => editPendingThreadMessage(message));
    if (AsyncResult.isFailure(edited)) {
      const error = squashAtomCommandFailure(edited);
      Dialog.alert(
        "Could not edit message",
        error instanceof Error ? error.message : "Please try again.",
      );
      return;
    }
    if (
      edited.value &&
      selectedThreadKeyRef.current === scopedThreadKey(message.environmentId, message.threadId)
    ) {
      composerEditorRef.current?.focus();
    }
  };

  const collapseComposer = () => {
    composerEditorRef.current?.blur();
  };

  const handleUseArtifactTemplate = (template: CodexArtifactTemplate) => {
    const draftMessage =
      props.composerDraftKey === null ? "" : getComposerDraftSnapshot(props.composerDraftKey).text;
    const nextDraft = appendCodexArtifactTemplateUsePrompt(draftMessage, template);
    if (nextDraft !== draftMessage) props.onChangeDraftMessage(nextDraft);
    requestAnimationFrame(() => {
      composerEditorRef.current?.focus();
      composerEditorRef.current?.setSelection({ start: nextDraft.length, end: nextDraft.length });
    });
  };

  const handleScrollToEnd = () => {
    void Haptics.selectionAsync();
    void scrollMessageToEnd({ animated: !reduceMotion, closeKeyboard: false }).catch(() => {
      freeze.set(false);
    });
  };

  const showScrollToEndButton =
    !props.draftMode &&
    contentPresentationKind === "ready" &&
    !endFollowEnabled &&
    allows("timeline-navigation");
  const { themeAppearance } = useAppearancePreferences();
  const isDarkMode = themeAppearance === "dark";

  const handleFeedTouchStart = (event: GestureResponderEvent) => {
    feedTouchStartRef.current = {
      pageX: event.nativeEvent.pageX,
      pageY: event.nativeEvent.pageY,
    };
  };

  const handleFeedTouchMove = (event: GestureResponderEvent) => {
    const start = feedTouchStartRef.current;
    if (!start) {
      return;
    }
    const deltaX = event.nativeEvent.pageX - start.pageX;
    const deltaY = event.nativeEvent.pageY - start.pageY;
    if (Math.hypot(deltaX, deltaY) > 8) {
      feedTouchStartRef.current = null;
    }
  };

  const handleFeedTouchEnd = () => {
    if (feedTouchStartRef.current) {
      collapseComposer();
    }
    feedTouchStartRef.current = null;
  };

  const handleFeedTouchCancel = () => {
    feedTouchStartRef.current = null;
  };
  const arcaneBackdrop = (
    <ArcaneBackdrop transitionKey={`${props.environmentId}:${props.selectedThread.projectId}`} />
  );

  return (
    <View className="flex-1" onLayout={handleScreenLayout}>
      {!usesNativeWorkspaceColumns ? <NativeLayoutObserver onChange={setScreenMetrics} /> : null}
      {props.draftMode ? (
        <>
          {arcaneBackdrop}
          {props.draftMode.content(
            navigationHeaderHeight,
            liveKeyboardHeight + estimatedOverlayHeight + 24,
            screenAreaHeight -
              navigationHeaderHeight -
              liveKeyboardHeight -
              estimatedOverlayHeight -
              24,
          )}
        </>
      ) : showContent ? (
        <View
          style={{ flex: 1 }}
          onTouchStart={handleFeedTouchStart}
          onTouchMove={handleFeedTouchMove}
          onTouchEnd={handleFeedTouchEnd}
          onTouchCancel={handleFeedTouchCancel}
        >
          <View
            pointerEvents="none"
            className={
              Platform.OS === "android"
                ? "absolute inset-0 bg-thread-canvas"
                : "absolute inset-0 bg-screen"
            }
          />
          {/* Lecturn backdrop sits above the opaque canvas so
              glass surfaces sample it and the solid layer cannot hide it. */}
          {arcaneBackdrop}
          <RenderErrorBoundary
            key={selectedThreadKey}
            resetKeys={[props.threadCwd]}
            renderFallback={(fallback) => (
              <RenderFailureView
                {...fallback}
                title="The conversation couldn't be displayed"
                bottomInset={estimatedOverlayHeight}
              />
            )}
          >
            <ThreadFeed
              environmentId={props.environmentId}
              threadId={props.selectedThread.id}
              workspaceRoot={props.threadCwd}
              feed={props.selectedThreadFeed}
              pendingHandoff={props.pendingHandoff}
              worktreeSetup={props.worktreeSetup}
              setupWorkingStartedAt={props.setupWorkingStartedAt}
              queuedMessages={props.queuedMessages}
              dispatchingMessageId={props.dispatchingMessageId}
              // A native subagent has no composer to edit a pending message in;
              // Cancel on the edit banner would discard it.
              onEditPendingMessage={
                isProviderSubagent || !allows("edit-pending-message")
                  ? null
                  : handleEditPendingMessage
              }
              forkEnabled={allows("fork-from-response")}
              planSaveEnabled={allows("files")}
              turnDiffEnabled={allows("git")}
              contentPresentation={props.contentPresentation}
              agentLabel={agentLabel}
              threadTitle={props.selectedThread.title}
              latestRun={props.activityRun}
              importedFrom={props.selectedThread.importedFrom ?? null}
              historyOrigin={props.selectedThread.historyOrigin}
              runlessForkHistory={hasRunlessForkHistory(props.selectedThread)}
              activeWorkStartedAt={props.activeWorkStartedAt}
              runlessWorkActive={props.runlessWorkActive ?? false}
              listRef={listRef}
              freeze={freeze}
              anchorMessageId={anchorMessageId}
              jumpToMessageId={jumpMessageLoaded ? jumpMessageId : null}
              onJumpedToMessage={() => finishThreadMessageJump(selectedThreadKey)}
              submittedMessageId={submittedMessageId}
              contentInsetEndAdjustment={combinedContentInsetEndAdjustment}
              keyboardOffset={composerKeyboardOffset}
              contentTopInset={0}
              contentBottomInset={
                estimatedOverlayHeight +
                (showFloatingStatus ? FLOATING_WORKING_CONTROL_COVERAGE : 0)
              }
              contentMaxWidth={contentMaxWidth}
              historyControls={allows("load-earlier") ? props.historyControls : undefined}
              contentSideInsets={nativeMetrics?.safeArea}
              layoutVariant={layoutVariant}
              usesAutomaticContentInsets={props.usesAutomaticContentInsets}
              onHeaderMaterialVisibilityChange={props.onHeaderMaterialVisibilityChange}
              onEndFollowEnabledChange={handleEndFollowEnabledChange}
              skills={selectedProviderSkills}
              squireChatSquireId={
                props.selectedThread.squire?.role === "home" &&
                props.serverConfig?.environment.capabilities.squire === true
                  ? props.selectedThread.squire.squireId
                  : null
              }
              squireChatFirst={
                props.serverConfig?.environment.capabilities.squireChatFirst === true
              }
              unreadWindow={unreadOpen?.threadKey === selectedThreadKey ? unreadOpen.window : null}
              onUseArtifactTemplate={
                allows("artifact-templates") ? handleUseArtifactTemplate : undefined
              }
            />
          </RenderErrorBoundary>
        </View>
      ) : (
        <View className="flex-1">{arcaneBackdrop}</View>
      )}

      {showContent && allows("previews") ? (
        <ThreadBrowserFloat
          key={selectedThreadKey}
          environmentId={props.environmentId}
          threadId={props.selectedThread.id}
          tabs={browserTabs.tabs}
          loaded={browserTabs.loaded}
          top={navigationHeaderHeight + 8}
          onOpen={openBrowserPreview}
        />
      ) : null}

      {showContent ? (
        <KeyboardStickyView
          enabled={keyboardStickyEnabled}
          pointerEvents="box-none"
          style={{ position: "absolute", bottom: 0, left: 0, right: 0, top: 0 }}
          offset={{ closed: 0, opened: composerKeyboardOffset }}
        >
          <ComposerPopoverHost hidden={composerSlotHidden} popoverHeight={composerPopoverHeight}>
            {/* Let the measured overlay size the iOS dock without a second frame
              transition. KeyboardStickyView moves the dock; inner composer
              surfaces keep their layout transitions. */}
            <Animated.View
              pointerEvents="box-none"
              style={[
                {
                  position: "absolute",
                  bottom: controlInsets.bottom,
                  left: controlInsets.left,
                  right: controlInsets.right,
                },
                composerWidthStyle,
              ]}
            >
              {/* No paddingTop here: the overlay's measured height becomes the
                list's bottom inset, so any padding above the pill/composer
                pushes the resting content floor up by the same amount. */}
              <View
                ref={composerOverlayRef}
                onLayout={handleComposerOverlayLayout}
                className="w-full"
              >
                <FloatingWorkingControl
                  colorScheme={isDarkMode ? "dark" : "light"}
                  status={floatingStatus}
                  lift={floatingControlLift}
                  devicePreview={
                    devicePreviews.length > 0 && allows("previews")
                      ? { count: devicePreviews.length, onPress: openDevicePreview }
                      : null
                  }
                  browserPreview={
                    browserTabs.tabs.length > 0 && allows("previews")
                      ? { count: browserTabs.tabs.length, onPress: () => openBrowserPreview() }
                      : null
                  }
                  showScrollToEnd={showScrollToEndButton}
                  onScrollToEnd={handleScrollToEnd}
                  agents={allows("agents") ? agentsSegment : null}
                  onOpenAgents={() => {
                    Keyboard.dismiss();
                    navigation.navigate("ThreadAgents", {
                      environmentId: props.environmentId,
                      threadId: props.selectedThread.id,
                    });
                  }}
                  queuedCount={allows("queued-runs") ? queuedCount : 0}
                  onOpenQueue={() => {
                    Keyboard.dismiss();
                    navigation.navigate("ThreadQueue", {
                      environmentId: props.environmentId,
                      threadId: props.selectedThread.id,
                    });
                  }}
                />
                <View className="w-full self-center" style={{ maxWidth: contentMaxWidth }}>
                  {props.queuedRunEdit !== null ? (
                    <Animated.View
                      className="shrink-0"
                      entering={FadeInDown.duration(180)}
                      exiting={FadeOut.duration(120)}
                    >
                      <ComposerQueuedEditBanner
                        saving={props.isSavingQueuedEdit}
                        onCancel={() => {
                          voiceInputSession.cancel(props.composerDraftKey);
                          props.onCancelQueuedRunEdit();
                        }}
                      />
                    </Animated.View>
                  ) : null}
                  {allows("usage-limits") ? (
                    <>
                      <UsageLimitRecoveryCard
                        key={props.selectedThread.latestRun?.runId}
                        thread={props.selectedThread}
                        environmentId={props.environmentId}
                      />
                      <ChatGptUsageLimitNotice
                        key={`chatgpt-limit:${props.selectedThread.latestRun?.runId}`}
                        thread={props.selectedThread}
                      />
                    </>
                  ) : null}
                  {/* Lecturn: a guest link is an owner action, which a Squire's home thread denies. */}
                  {allows("thread-actions") ? (
                    <ThreadGuestShareBar
                      threadRef={props.selectedThreadDetailRef}
                      canOperateThread={props.canOperateThread}
                    />
                  ) : null}
                  {props.feedbackSubmissions.map((submission) => (
                    <ComposerFeedback
                      key={submission.id}
                      submission={submission}
                      onDismiss={() => props.onDismissFeedback(submission.id)}
                    />
                  ))}
                  {composerError !== null ? (
                    <Animated.View
                      className="shrink-0"
                      entering={FadeInDown.duration(180)}
                      exiting={FadeOut.duration(120)}
                    >
                      <ComposerErrorNotice
                        message={composerError}
                        onDismiss={() => clearThreadComposerError(selectedThreadKey)}
                      />
                    </Animated.View>
                  ) : null}
                  {usageLimitsReport &&
                  activeUserInputRequestId === null &&
                  allows("usage-limits") ? (
                    <Animated.View
                      className="shrink-0 px-4"
                      style={{ paddingBottom: USAGE_LIMITS_PANEL_GAP }}
                      onLayout={handleUsageLimitsLayout}
                      entering={FadeInDown.duration(220)}
                      exiting={FadeOut.duration(140)}
                    >
                      <ComposerUsageLimits
                        report={usageLimitsReport}
                        environmentId={props.environmentId}
                        maxHeight={usageLimitsMaxHeight}
                        onClose={dismissUsageLimits}
                      />
                    </Animated.View>
                  ) : null}
                  {props.creationState?.kind === "failed" ? (
                    <Animated.View
                      className="shrink-0 px-4"
                      style={{ paddingBottom: composerBottomInset }}
                      entering={FadeInDown.duration(220)}
                      exiting={FadeOut.duration(140)}
                    >
                      <ThreadCreationFailedCard
                        reason={props.creationState.reason}
                        onEditTask={props.creationState.onEditTask}
                      />
                    </Animated.View>
                  ) : null}
                  {/* Lecturn: Squire holds and budget on a home thread, decisions on a tracked one. */}
                  <SquireThreadBanners
                    environmentId={props.environmentId}
                    thread={props.selectedThread}
                  />
                  <AppClosedBanner thread={props.selectedThread} />
                  {props.activePendingApproval || props.activePendingUserInput ? (
                    <Animated.View
                      className="shrink-0 gap-3 px-4 pb-3"
                      style={
                        activeUserInputRequestId !== null
                          ? { paddingBottom: composerBottomInset }
                          : undefined
                      }
                      entering={FadeInDown.duration(220)}
                      exiting={FadeOut.duration(140)}
                    >
                      {props.activePendingApproval ? (
                        <PendingApprovalCard
                          canOperateThread={props.canOperateThread}
                          approval={props.activePendingApproval}
                          respondingApprovalId={props.respondingApprovalId}
                          onRespond={props.onRespondToApproval}
                        />
                      ) : null}
                      {props.activePendingUserInput ? (
                        <PendingUserInputCard
                          canOperateThread={props.canOperateThread}
                          pendingUserInput={props.activePendingUserInput}
                          maxHeight={pendingUserInputMaxHeight}
                          collapsed={userInputCollapsed}
                          onToggleCollapsed={handleToggleUserInputCollapsed}
                          onStopThread={props.onStopThread}
                          cardProgress={userInputCardProgress}
                          cardCoverage={userInputCardCoverage}
                          onInputFocusChange={handleOwnedInputFocusChange}
                          drafts={props.activePendingUserInputDrafts}
                          answers={props.activePendingUserInputAnswers}
                          respondingUserInputId={props.respondingUserInputId}
                          onSelectOption={props.onSelectUserInputOption}
                          onChangeCustomAnswer={props.onChangeUserInputCustomAnswer}
                          onSubmit={props.onSubmitUserInput}
                          onDismiss={props.onDismissUserInput}
                        />
                      ) : null}
                    </Animated.View>
                  ) : null}
                </View>

                {settled ? (
                  <View
                    style={{
                      paddingHorizontal: 16,
                      paddingBottom: composerBottomInset,
                      paddingTop: 12,
                    }}
                  >
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Unsettle thread"
                      accessibilityHint="Restores the composer and any saved draft."
                      disabled={unsettling || props.connectionStateLabel !== "connected"}
                      onPress={() => void handleUnsettle()}
                      style={{
                        borderRadius: 24,
                        minHeight: 76,
                        padding: 20,
                        flexDirection: "row",
                        flexWrap: "wrap",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 12,
                        boxShadow: isDarkMode ? "0 0 10px 1px #e64d3d44" : "0 0 10px 1px #ad3c2f22",
                        opacity: unsettling ? 0.6 : 1,
                      }}
                    >
                      <View
                        pointerEvents="none"
                        style={{
                          position: "absolute",
                          inset: 0,
                          borderRadius: 24,
                          backgroundColor: isDarkMode ? "#1e1b20" : "#f5e8df",
                        }}
                      />
                      <ActiveThreadBorder visible settled radius={24} />
                      <View
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          flexShrink: 1,
                          gap: 8,
                        }}
                      >
                        <SymbolView
                          name="checkmark.circle"
                          size={18}
                          tintColor={isDarkMode ? "#ff866f" : "#ad3c2f"}
                        />
                        <Text style={{ color: isDarkMode ? "#a2a6ab" : "#646b73", flexShrink: 1 }}>
                          Settled
                        </Text>
                      </View>
                      <Text
                        style={{
                          color: isDarkMode ? "#ffd097" : "#873e2e",
                          fontSize: 17,
                          flexShrink: 1,
                        }}
                      >
                        {unsettling ? "Unsettling…" : "Unsettle"}
                      </Text>
                    </Pressable>
                    <SettledThreadMetadata
                      thread={props.selectedThread}
                      serverConfig={props.serverConfig}
                    />
                  </View>
                ) : null}
                <View style={composerSlotHidden ? { display: "none" } : undefined}>
                  {isProviderSubagent ? (
                    <View
                      className="self-center px-3 pt-1.5"
                      style={{
                        width: "100%",
                        maxWidth: contentMaxWidth,
                        paddingBottom: composerBottomInset + 6,
                      }}
                    >
                      <ProviderSubagentBar
                        provider={providerSubagentProvider ?? null}
                        modelLabel={
                          providerSubagentCatalogModel?.name ??
                          formatModelSlugName(props.selectedThread.modelSelection.model)
                        }
                        effortLabel={formatModelSelectionEffort(
                          props.selectedThread.modelSelection,
                          providerSubagentProvider?.models,
                          reportedModelSelection,
                        )}
                        status={props.providerSubagentStatus ?? null}
                        onOpenParent={
                          props.selectedThread.lineage.parentThreadId === null
                            ? null
                            : () =>
                                openLinkedThread({
                                  environmentId: String(props.environmentId),
                                  threadId: String(props.selectedThread.lineage.parentThreadId),
                                })
                        }
                      />
                    </View>
                  ) : (
                    <>
                      {allows("contextual") && !props.draftMode ? (
                        <ContextualPreparationNotice
                          environmentId={props.environmentId}
                          threadId={props.selectedThread.id}
                        />
                      ) : null}
                      <ThreadComposer
                        controls={props.controls}
                        isDraft={Boolean(props.draftMode)}
                        canOperateThread={props.canOperateThread}
                        reportedModelSelection={reportedModelSelection}
                        editorRef={composerEditorRef}
                        placeholder={
                          sendDeclinesApprovals
                            ? props.activePendingApproval?.supportsFeedback
                              ? "Send feedback to decline this request"
                              : "Send a message to decline and redirect the agent"
                            : (props.composerPlaceholder ?? "Ask anything")
                        }
                        contentMaxWidth={contentMaxWidth}
                        draftControls={props.draftMode?.controls}
                        connectionState={props.connectionStateLabel}
                        environmentLabel={props.environmentLabel}
                        selectedThread={props.selectedThread}
                        hasCompactableConversation={
                          hasCompactableConversation && !props.isCompacting
                        }
                        serverConfig={props.serverConfig}
                        queueCount={props.selectedThreadQueueCount}
                        activeThreadBusy={props.activeThreadBusy}
                        canStopThread={props.canStopThread}
                        environmentId={props.environmentId}
                        projectCwd={props.threadCwd ?? props.projectWorkspaceRoot}
                        // Keep follow-ups in the draft until server creation succeeds, or rejection strands them in the outbox.
                        sendBlockedReason={
                          props.draftMode
                            ? props.draftMode.sendBlockedReason
                            : props.creationState?.kind === "preparing" &&
                                !props.creationState.serverOwned
                              ? "Starting the task…"
                              : null
                        }
                        interactionLocked={props.draftMode?.interactionLocked}
                        draftKey={props.composerDraftKey ?? undefined}
                        followUpBehavior={
                          sendDeclinesApprovals && props.activePendingUserInput === null
                            ? "steer"
                            : props.followUpBehavior
                        }
                        canSteerActiveTurn={props.canSteerActiveTurn}
                        hidden={composerSlotHidden}
                        queuedEdit={
                          props.queuedRunEdit === null
                            ? null
                            : {
                                existingAttachments: props.queuedRunEdit.existingAttachments,
                                saving: props.isSavingQueuedEdit,
                                onRemoveExistingAttachment: props.onRemoveQueuedEditAttachment,
                              }
                        }
                        bottomInset={composerBottomInset}
                        onChangeDraftMessage={props.onChangeDraftMessage}
                        onPickDraftMedia={props.onPickDraftMedia}
                        onPickDraftFiles={props.onPickDraftFiles}
                        onNativePasteImages={props.onNativePasteImages}
                        onNativePasteText={props.onNativePasteText}
                        onRemoveDraftImage={props.onRemoveDraftImage}
                        onStopThread={props.onStopThread}
                        onResumeQueue={props.onResumeQueue}
                        onSendMessage={handleSendMessage}
                        onShowUsageLimits={showUsageLimits}
                        canSwitchProvider={props.canSwitchThreadProvider}
                        onUpdateModelSelection={props.onUpdateThreadModelSelection}
                        onUpdateRuntimeMode={props.onUpdateThreadRuntimeMode}
                        onUpdateInteractionMode={props.onUpdateThreadInteractionMode}
                        onHeightChange={handleComposerHeightChange}
                        onEditorFocusChange={handleOwnedInputFocusChange}
                      />
                    </>
                  )}
                </View>
              </View>
            </Animated.View>
          </ComposerPopoverHost>
        </KeyboardStickyView>
      ) : null}
    </View>
  );
};

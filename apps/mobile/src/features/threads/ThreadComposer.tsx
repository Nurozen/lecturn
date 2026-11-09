import { useSidebarWorkspaceTabs } from "../workspace/useSystemWorkspaceTabBar";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ContextualThreadControl } from "../contextual/ContextualControls";
import type { ComposerTextPaste } from "../../native/LecturnComposerEditor.types";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import {
  useAppearancePreferences,
  useAndroidFloatingTabs,
} from "../settings/appearance/AppearancePreferencesProvider";
import type { EnvironmentThreadShell } from "@lecturn/client-runtime/state/shell";
import { settlePromise, squashAtomCommandFailure } from "@lecturn/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { useAtomValue } from "@effect/atom-react";
import { clampFileAttachmentUploadBytes } from "@lecturn/client-runtime/state/attachments";
import { pastedTextDisposition, replaceTextSelection } from "@lecturn/client-runtime/text-paste";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type ChatAttachment,
  type EnvironmentId,
  type MessageId,
  type ModelSelection,
  type ProviderInteractionMode,
  type ServerConfig as LecturnServerConfig,
  type UsageLimitsReport,
} from "@lecturn/contracts";
import {
  collectProviderUsageLimits,
  hasProviderUsageLimits,
  isUsageLimitsCommand,
} from "@lecturn/shared/usageLimits";
import { StackActions, useFocusEffect, useNavigation } from "@react-navigation/native";
import type { ReactNode } from "react";
import { useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";
import { Keyboard, Platform, Pressable, View, type ViewStyle } from "react-native";
import { composerImageGallery } from "../../lib/composerImageGallery";
import { filePreviewGallery } from "../../lib/filePreviewGallery";
import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import {
  composerAttachmentUploadBlockReason,
  composerAttachmentsStillUploading,
  composerAttachmentUploadsAtom,
} from "../../state/composer-attachment-uploads";
import Animated, {
  FadeIn,
  FadeOut,
  type LayoutAnimationFunction,
  ReduceMotion,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { themeColorWithAlpha } from "../../lib/mobileTheme";
import { armAgentAwarenessLiveActivityForLocalWork } from "../agent-awareness/remoteRegistration";
import { scopedThreadKey } from "../../lib/scopedEntities";
import {
  getComposerDraftSnapshot,
  composerDraftsAtom,
  setComposerDraftText,
  composerContextImportsAtom,
  countComposerDraftAttachmentsAfterSelection,
  useComposerDraft,
} from "../../state/use-composer-drafts";
import { appAtomRegistry } from "../../state/atom-registry";
import type { ComposerDocumentAttachment } from "../../lib/composerContext";
import { useProject, useThreadListingCapabilities, useThreadShells } from "../../state/entities";
import { useMentionableEnvironments } from "../../state/environments";
import { useLinkedEnvironments } from "../../state/peerLinks";
import { scopeProjectRef } from "@lecturn/client-runtime/environment";

import { AppText as Text } from "../../components/ui/AppText";
import { ComposerAttachmentButton } from "./ComposerAttachmentButton";
import {
  allowsThreadRouteControl,
  type ThreadRouteControl,
  type ThreadRouteControls,
} from "./threadRouteControls";
import {
  ComposerAttachmentStrip,
  ComposerAttachmentThumbnail,
} from "../../components/ComposerAttachmentStrip";
import { VideoPreviewModal, type VideoPreviewSource } from "../../components/VideoPreviewModal";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { GlassCard } from "../../components/GlassCard";
import { useGlassPalette } from "../../lib/useGlassPalette";
import { SymbolView } from "../../components/ui/AppSymbol";
import { RUNTIME_MODE_CHOICES } from "./thread-settings-options";
import { ComposerEditor, type ComposerEditorHandle } from "../../components/ComposerEditor";
import { fileRoutePathSegments } from "../files/filePath";
import { ComposerActionButton, ComposerToolbarRow } from "../../components/ComposerToolbar";
import { ProviderIcon } from "../../components/ProviderIcon";
import {
  composerStripAttachments,
  type DraftComposerFileAttachment,
} from "../../lib/composerImages";
import { buildModelOptions, isModelSelectionUnavailable } from "../../lib/modelOptions";
import { useScaledTextRole, type ScaledTextRole } from "../settings/appearance/useScaledTextRole";
import type { RemoteClientConnectionState } from "../../lib/connection";
import { MOBILE_TYPOGRAPHY } from "../../lib/typography";
import {
  providerOptionValueLabels,
  resolveProviderOptionDescriptors,
} from "../../lib/providerOptions";
import { Menu } from "../../components/ui/Menu";
import type { ActiveTurnComposerAction } from "@lecturn/client-runtime/state/composer-dispatch";
import type { FollowUpBehavior } from "../../lib/followUpBehavior";
import {
  resolveComposerSendPresentation,
  type ComposerSendPresentation,
} from "./composerSendPresentation";
import { ComposerCommandPopover } from "./ComposerCommandPopover";
import { ComposerPopoverAnchor } from "./ComposerPopoverAnchor";
import { ComposerQueuedEditAttachments } from "./ComposerQueuedEdit";
import { useComposerCommandMenu } from "./use-composer-command-menu";
import type { ComposerEnvironmentCandidate } from "@lecturn/client-runtime/composerThreadItems";
import { offersLinkedEnvironments } from "@lecturn/client-runtime/link-request";
import {
  ComposerDictationCancelAction,
  ComposerDictationDraftContent,
  ComposerDictationPrimaryAction,
  ComposerDictationStartAction,
  ComposerDictationStatus,
  ComposerDictationToolbar,
} from "../voice-input/ComposerDictationControl";
import { useVoiceInputController } from "../voice-input/useVoiceInputController";
import { resolveVoiceComposerPresentation } from "../voice-input/voiceInputPresentation";
import type { ExistingThreadSettingsRouteParams } from "./ThreadSettingsSheet";
import {
  useThreadSettingsSheetPresentation,
  type NavigationWithFinishTransitioning,
} from "./use-thread-settings-sheet-presentation";

export const COMPOSER_COLLAPSED_CHROME = 102;

const NO_MACHINES: ReadonlyArray<ComposerEnvironmentCandidate> = [];
const COLLAPSED_EDITOR_DEFAULT_INSET = 6;
// iOS puts line-height slack above glyphs. DM Sans's lowercase midline is
// descender (0.31em) + half x-height (0.504em) above the line bottom.
const LOWERCASE_MIDLINE_EM = 0.562;

function lowercaseMidline(text: ScaledTextRole): number {
  return text.lineHeight - LOWERCASE_MIDLINE_EM * text.fontSize;
}

function collapsedEditorInset(text: ScaledTextRole): number {
  const shift = lowercaseMidline(text) - lowercaseMidline(MOBILE_TYPOGRAPHY.body);
  return Math.max(0, Math.round(COLLAPSED_EDITOR_DEFAULT_INSET - shift));
}

function useCompactComposerEditor(text: ScaledTextRole, value: string) {
  const [contentSize, setContentSize] = useState({ width: 0, height: 0 });
  const [compactWidth, setCompactWidth] = useState(0);
  const contentHeight = contentSize.height;
  const rowWidth = useSharedValue(0);
  const editorX = useSharedValue(0);
  const editorWidth = useSharedValue(0);
  const inset =
    Platform.OS === "android" ? COLLAPSED_EDITOR_DEFAULT_INSET : collapsedEditorInset(text);
  const minimum = Math.max(INLINE_EDITOR_HEIGHT, Math.ceil(text.lineHeight) + 2 * inset);
  const height = Math.max(
    minimum,
    Math.min(text.lineHeight * 4 + 2 * inset, contentHeight + 2 * inset),
  );
  // A line that fits the expanded editor may still overflow its compact slot.
  // Compare its measured width too so widening cannot trigger a collapse loop.
  const isExpanded =
    value.length > 0 &&
    (contentHeight > text.lineHeight * 1.5 ||
      (compactWidth > 0 && contentSize.width > compactWidth));
  const compactRowHeight = Math.max(44, minimum);
  const editorStyle = useAnimatedStyle(() => ({
    position: "absolute",
    overflow: "hidden",
    height,
    left: isExpanded ? 14 : editorX.value + 4,
    right: isExpanded ? 14 : rowWidth.value - editorX.value - editorWidth.value + 4,
    // The full-width editor must move above the controls in the same frame it widens.
    bottom: isExpanded ? 52 : (compactRowHeight - minimum) / 2,
  }));
  return {
    isExpanded,
    containerStyle: { height: isExpanded ? height + 52 : compactRowHeight },
    editorStyle,
    onRowLayout: (event: { nativeEvent: { layout: { width: number } } }) => {
      rowWidth.set(event.nativeEvent.layout.width);
    },
    onEditorLayout: (event: { nativeEvent: { layout: { x: number; width: number } } }) => {
      // The expanded toolbar gives this slot to the model control. Keep the
      // compact geometry for the return transition, rather than recording zero.
      if (!isExpanded) {
        editorX.set(event.nativeEvent.layout.x);
        editorWidth.set(event.nativeEvent.layout.width);
        setCompactWidth(Math.max(0, event.nativeEvent.layout.width - 8));
      }
    },
    editorProps: {
      singleLineCentered: !isExpanded,
      scrollEnabled: Platform.OS === "android" || contentHeight >= text.lineHeight * 4,
      contentInsetVertical: inset,
      onContentSizeChange: (size: { width: number; height: number }) => {
        setContentSize(size);
      },
      style: { flex: 1 },
    },
  };
}

export interface ThreadComposerProps {
  readonly isDraft?: boolean;
  readonly canOperateThread: boolean;
  readonly placeholder: string;
  readonly contentMaxWidth?: number;
  readonly draftControls?: ReactNode;
  readonly bottomInset?: number;
  readonly connectionState: RemoteClientConnectionState;
  readonly environmentLabel: string | null;
  readonly selectedThread: EnvironmentThreadShell;
  readonly reportedModelSelection?: ModelSelection | null;
  readonly hasCompactableConversation: boolean;
  readonly serverConfig: LecturnServerConfig | null;
  readonly queueCount: number;
  readonly activeThreadBusy: boolean;
  readonly canStopThread: boolean;
  readonly environmentId: EnvironmentId;
  readonly projectCwd: string | null;
  readonly sendBlockedReason?: string | null;
  readonly interactionLocked?: boolean;
  readonly draftKey?: string;
  readonly queuedEdit?: {
    readonly existingAttachments: ReadonlyArray<ChatAttachment>;
    readonly saving: boolean;
    readonly onRemoveExistingAttachment: (attachmentId: string) => void;
  } | null;
  readonly followUpBehavior: FollowUpBehavior;
  readonly canSteerActiveTurn: boolean;
  readonly hidden: boolean;
  readonly editorRef?: RefObject<ComposerEditorHandle | null>;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onPickDraftMedia: () => Promise<void>;
  readonly onPickDraftFiles: () => Promise<void>;
  readonly onNativePasteImages: (uris: ReadonlyArray<string>) => Promise<void>;
  readonly onNativePasteText: (paste: ComposerTextPaste) => Promise<void>;
  readonly onRemoveDraftImage: (imageId: string) => void;
  readonly onStopThread: () => void;
  /** Present while the thread's queue is held. */
  readonly onResumeQueue: (() => Promise<void>) | null;
  /** `stillSendable` reports whether the draft is unchanged after any wait before sending. */
  readonly onSendMessage: (
    followUp?: ActiveTurnComposerAction,
    stillSendable?: () => boolean,
  ) => Promise<MessageId | null>;
  readonly onShowUsageLimits: (report: UsageLimitsReport | null) => void;
  readonly canSwitchProvider: boolean;
  readonly onUpdateInteractionMode?: (interactionMode: ProviderInteractionMode) => void;
  readonly onHeightChange?: (height: number) => void;
  readonly onEditorFocusChange?: (focused: boolean) => void;
  /** Lecturn: the thread route's controls allowlist; absent keeps every composer control. */
  readonly controls?: ThreadRouteControls;
}

// Android KeyboardStickyView tracks the IME; concurrent timed layout morphs cause jitter.
const COMPOSER_TRANSITION_DURATION_MS = 220;
// Side panes animate dock width; nested horizontal transitions would make the surface trail the toolbar.
const composerHeightTransition: LayoutAnimationFunction = (values) => {
  "worklet";
  const timing = {
    duration: COMPOSER_TRANSITION_DURATION_MS,
    reduceMotion: ReduceMotion.System,
  };
  return {
    initialValues: {
      originX: values.targetOriginX,
      originY: values.currentOriginY,
      width: values.targetWidth,
      height: values.currentHeight,
    },
    animations: {
      originX: values.targetOriginX,
      originY: withTiming(values.targetOriginY, timing),
      width: values.targetWidth,
      height: withTiming(values.targetHeight, timing),
    },
  };
};
const COMPOSER_LAYOUT_TRANSITION = Platform.OS === "android" ? undefined : composerHeightTransition;
// Share of the one-row composer the draft keeps beside the row controls.
const INLINE_EDITOR_MIN_WIDTH = "40%";
const INLINE_EDITOR_HEIGHT = 36;

const COMPOSER_ATTACHMENT_ENTERING =
  Platform.OS === "android"
    ? FadeIn.duration(160)
    : FadeIn.delay(COMPOSER_TRANSITION_DURATION_MS).duration(160).reduceMotion(ReduceMotion.System);

const AnimatedGlassSurface = Animated.createAnimatedComponent(GlassSurface);

const FOLLOW_UP_ACTION_LABEL = {
  queue: "Queue",
  steer: "Steer now",
  restart: "Restart turn",
} as const;

const FOLLOW_UP_ACTION_SUBTITLE = {
  queue: "Run after the current turn",
  steer: "Interrupt what the agent is doing",
  restart: "Start the turn over with this message",
} as const;

function SendActionButton(props: {
  readonly size?: "regular" | "large";
  readonly accessibilityLabel: string;
  readonly presentation: ComposerSendPresentation;
  readonly disabled: boolean;
  readonly onSend: (followUp?: ActiveTurnComposerAction) => void;
}) {
  const { presentation } = props;
  const button = (
    <ComposerActionButton
      accessibilityLabel={props.accessibilityLabel}
      size={props.size}
      icon={presentation.icon}
      variant="primary"
      disabled={props.disabled}
      onPress={() => props.onSend()}
    />
  );
  if (!presentation.offersFollowUpChoice || presentation.action === null || props.disabled) {
    return button;
  }
  const actions = [presentation.action, presentation.alternate].filter(
    (action): action is ActiveTurnComposerAction => action !== null,
  );
  return (
    <Menu
      accessibilityLabel="Choose how to send this message"
      shouldOpenOnLongPress
      actions={actions.map((action) => ({
        id: action,
        title: FOLLOW_UP_ACTION_LABEL[action],
        subtitle: FOLLOW_UP_ACTION_SUBTITLE[action],
        state: action === presentation.action ? ("on" as const) : ("off" as const),
      }))}
      onPressAction={({ nativeEvent }) =>
        props.onSend(nativeEvent.event as ActiveTurnComposerAction)
      }
    >
      {button}
    </Menu>
  );
}

function ComposerSurface(props: {
  readonly children: ReactNode;
  readonly style: ViewStyle;
  readonly animateLayout?: boolean;
}) {
  const palette = useGlassPalette();
  const colors = useUniwindTheme();
  const targetBorderRadius =
    typeof props.style.borderRadius === "number" ? props.style.borderRadius : 0;
  const shouldAnimate = props.animateLayout !== false && Platform.OS !== "android";
  const animatedBorderRadius = useDerivedValue(() =>
    shouldAnimate
      ? withTiming(targetBorderRadius, {
          duration: COMPOSER_TRANSITION_DURATION_MS,
          reduceMotion: ReduceMotion.System,
        })
      : targetBorderRadius,
  );
  const borderCurve = props.style.borderCurve;
  const animatedShapeStyle = useAnimatedStyle(() => ({
    borderRadius: animatedBorderRadius.value,
    ...(borderCurve ? { borderCurve } : {}),
  }));
  const layoutTransition = shouldAnimate ? COMPOSER_LAYOUT_TRANSITION : undefined;

  // Animate every native frame or glass and content jump to final height inside the clip.
  return (
    <Animated.View
      className={
        Platform.OS === "android" ? undefined : "shadow-[0_6px_28px] shadow-adaptive-black-a15-a35"
      }
      layout={layoutTransition}
      style={[
        animatedShapeStyle,
        {
          overflow: "hidden",
        },
      ]}
    >
      <AnimatedGlassSurface
        chrome="none"
        fallbackColor={colors["--color-composer-surface"]}
        fallbackClassName="border border-composer-border"
        className="border border-border"
        glassEffectStyle="regular"
        pointerEvents="none"
        tintColor="transparent"
        layout={layoutTransition}
        style={[
          { position: "absolute", inset: 0 },
          // Android Material keeps its composer border token; elsewhere the edge
          // follows the account glass palette.
          Platform.OS === "android" ? null : { borderWidth: 1, borderColor: palette.edge },
          animatedShapeStyle,
        ]}
      >
        {null}
      </AnimatedGlassSurface>
      <Animated.View
        collapsable={false}
        layout={layoutTransition}
        style={[props.style, animatedShapeStyle]}
      >
        {props.children}
      </Animated.View>
    </Animated.View>
  );
}

/** Space below the composer pill, inside the bottom inset it is given. */
export const THREAD_COMPOSER_BOTTOM_GUTTER = 6;

export const ThreadComposer = function ThreadComposer(props: ThreadComposerProps) {
  const project = useProject(scopeProjectRef(props.environmentId, props.selectedThread.projectId));
  const { themeVariables: materialTheme } = useAppearancePreferences();
  const composerPanel = materialTheme["--color-composer-panel"];
  const navigation = useNavigation();
  const foregroundColor = useUniwindTheme()["--color-foreground"];
  const bodyText = useScaledTextRole("body");
  const fallbackInputRef = useRef<ComposerEditorHandle>(null);
  const inputRef = props.editorRef ?? fallbackInputRef;
  const [isFocused, setIsFocused] = useState(false);
  const pendingPastedTextAttachmentCountRef = useRef(0);
  const pendingNativeImagePasteCountRef = useRef(0);
  const [pendingPastedTextAttachmentCount, setPendingPastedTextAttachmentCount] = useState(0);
  const settingsRoutePresentedRef = useRef(false);
  const settingsSheetPresentation = useThreadSettingsSheetPresentation({
    editorRef: inputRef,
    onPresent: () => {
      if (settingsRoutePresentedRef.current) return;
      settingsRoutePresentedRef.current = true;
      // The draft composer edits the new-task flow, which owns its own settings route.
      navigation.dispatch(
        props.isDraft
          ? StackActions.push("NewTaskThreadSettings")
          : StackActions.push("ThreadSettingsSheet", {
              environmentId: props.environmentId,
              threadId: props.selectedThread.id,
              draftKey: composerDraftKey,
            } satisfies ExistingThreadSettingsRouteParams),
      );
    },
  });
  const disposeSettingsSheetPresentation = useEffectEvent(settingsSheetPresentation.dispose);
  const wasExpandedBeforePreviewRef = useRef(false);
  const inFlightThreadIdsRef = useRef(new Set<string>());

  const [previewFile, setPreviewFile] = useState<FilePreviewSource | null>(null);
  const [previewVideo, setPreviewVideo] = useState<VideoPreviewSource | null>(null);
  const composerOwnerKey = scopedThreadKey(props.environmentId, props.selectedThread.id);
  const composerDraftKey = props.draftKey ?? composerOwnerKey;
  const { text: draftMessage, attachments: draftAttachments } = useComposerDraft(composerDraftKey);
  const queuedEdit = props.queuedEdit ?? null;
  const hasContent =
    draftMessage.trim().length > 0 ||
    draftAttachments.length > 0 ||
    (queuedEdit?.existingAttachments.length ?? 0) > 0;
  const stripAttachments = composerStripAttachments(draftAttachments);
  const showStopAction = !hasContent && props.canStopThread && queuedEdit === null;
  const onResumeQueue = props.onResumeQueue;
  const [resumingQueue, setResumingQueue] = useState(false);
  const showResumeAction =
    !hasContent && !showStopAction && queuedEdit === null && onResumeQueue !== null;
  const handleResumeQueue = async () => {
    if (resumingQueue || onResumeQueue === null) return;
    setResumingQueue(true);
    await onResumeQueue();
    setResumingQueue(false);
  };

  const uploadStates = useAtomValue(composerAttachmentUploadsAtom);
  const attachmentsUploading =
    props.connectionState === "connected" &&
    composerAttachmentsStillUploading({
      environmentId: props.environmentId,
      attachments: draftAttachments,
      serverConfig: props.serverConfig,
      states: uploadStates,
    });
  const sendPresentation = resolveComposerSendPresentation({
    editingQueuedMessage: queuedEdit !== null,
    running: props.activeThreadBusy,
    canSteer: props.canSteerActiveTurn,
    followUpBehavior: props.followUpBehavior,
    deliveryDeferred:
      props.connectionState !== "connected" || props.queueCount > 0 || attachmentsUploading,
  });
  const sendLabel = sendPresentation.label;
  const currentModelSelection = props.selectedThread.modelSelection;
  const modelUnavailable =
    props.connectionState === "connected" &&
    isModelSelectionUnavailable(
      props.serverConfig,
      currentModelSelection,
      props.selectedThread.projectId,
    );
  const selectedProviderStatus = (() => {
    if (!props.serverConfig) return null;
    return (
      props.serverConfig.providers.find(
        (p) => p.instanceId === props.selectedThread.modelSelection.instanceId,
      ) ?? null
    );
  })();
  const openDraftDocument = (attachment: ComposerDocumentAttachment) => {
    Keyboard.dismiss();
    navigation.navigate("ThreadAttachment", {
      environmentId: String(props.environmentId),
      threadId: String(props.selectedThread.id),
      attachmentId: attachment.attachmentId,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: String(attachment.sizeBytes),
      draftKey: composerDraftKey,
    });
  };
  const { onSendMessage, onChangeDraftMessage, onShowUsageLimits } = props;
  // Lecturn: each gated composer control reads the controls allowlist through this.
  const allows = (control: ThreadRouteControl) => allowsThreadRouteControl(props.controls, control);
  const usageLimitsOffered =
    allows("usage-limits") &&
    selectedProviderStatus !== null &&
    hasProviderUsageLimits(
      selectedProviderStatus.driver,
      props.serverConfig?.providers ?? [],
      props.serverConfig?.usageLimitSources ?? [],
    );
  const openUsageLimits = () => {
    const report = collectProviderUsageLimits(
      currentModelSelection.instanceId,
      props.serverConfig?.providers ?? [],
      props.serverConfig?.usageLimitSources ?? [],
      Date.now(),
    );
    onShowUsageLimits(report);
    if (!report) {
      Dialog.alert("Usage limits unavailable", "This provider does not currently report limits.");
    }
    return report !== null;
  };

  const mentionableEnvironments = useMentionableEnvironments();
  const composerMenu = useComposerCommandMenu({
    draftMessage: draftMessage,
    ownerKey: composerDraftKey,
    environmentId: props.environmentId,
    threadShells: useThreadShells(),
    threadListing: useThreadListingCapabilities(),
    environments: offersLinkedEnvironments(props.serverConfig)
      ? mentionableEnvironments
      : NO_MACHINES,
    linkedEnvironments: useLinkedEnvironments(props.environmentId),
    currentThreadId: props.selectedThread.id,
    projectCwd: props.projectCwd,
    pullRequestProjectId: props.serverConfig ? (project?.id ?? null) : null,
    pullRequestRepository: project?.repositoryIdentity?.displayName ?? null,
    threadPullRequests: props.selectedThread.pullRequests,
    selectedProviderStatus,
    hasThread: !props.isDraft,
    hasCompactableConversation: props.hasCompactableConversation && allows("compact"),
    onChangeDraftMessage: props.onChangeDraftMessage,
    onUpdateInteractionMode:
      selectedProviderStatus?.showInteractionModeToggle === false || !allows("interaction-mode")
        ? undefined
        : props.onUpdateInteractionMode,
    offersUsageLimits: usageLimitsOffered,
    onUsageLimits:
      usageLimitsOffered && draftAttachments.length === 0 ? openUsageLimits : undefined,
  });
  const voiceInput = useVoiceInputController({
    ownerKey: composerDraftKey,
    label: props.selectedThread.title || "Untitled thread",
    readDraftMessage: () => getComposerDraftSnapshot(composerDraftKey).text,
    subscribeToDraftChanges: (onChange) => appAtomRegistry.subscribe(composerDraftsAtom, onChange),
    selection: composerMenu.selection,
    onChangeDraftMessage: (text) => setComposerDraftText(composerDraftKey, text),
    onChangeSelection: composerMenu.onSelectionChange,
  });
  const isSubmissionLocked =
    props.interactionLocked === true || queuedEdit?.saving === true || voiceInput.blocksSubmission;
  const voicePresentation = resolveVoiceComposerPresentation(
    voiceInput.state,
    voiceInput.elapsedSeconds,
  );
  const isVoiceInputPresented = voicePresentation.statusLabel !== null;
  const isExpanded = isFocused || settingsSheetPresentation.keepsComposerExpanded;
  const { layout, setComposerEditing } = useAdaptiveWorkspaceLayout();
  const floatingSidebarComposer = useAndroidFloatingTabs() && layout.usesSplitView;
  const usesLargeControls =
    useSidebarWorkspaceTabs() === "picker" || (Platform.OS === "ios" && Platform.isPad);
  const surfacePaddingVertical = usesLargeControls ? 9 : floatingSidebarComposer ? 6 : 2;
  const [compactRowWidth, setCompactRowWidth] = useState(0);
  const compactAttachmentLimit = compactRowWidth >= 500 ? 3 : 1;
  // The composer stays one row until the draft would wrap (the model tray sits
  // under the composer, not in the row).
  const compactEditor = useCompactComposerEditor(bodyText, draftMessage);
  const showsCompactDictation = isVoiceInputPresented;
  const isToolbarVisible = isVoiceInputPresented;
  const hasEditingAttachments =
    (queuedEdit !== null && queuedEdit.existingAttachments.length > 0) ||
    stripAttachments.length > 0;
  const attachmentBlockReason = composerAttachmentUploadBlockReason({
    environmentId: props.environmentId,
    attachments: draftAttachments,
    connected: props.connectionState === "connected",
    serverConfig: props.serverConfig,
    states: uploadStates,
  });
  const contextImports = useAtomValue(composerContextImportsAtom);
  const sendBlockedReason =
    (queuedEdit?.saving === true ? "Saving…" : null) ??
    props.sendBlockedReason ??
    (pendingPastedTextAttachmentCount > 0 ? "Attaching pasted text" : null) ??
    attachmentBlockReason;
  const canSend =
    (props.canOperateThread || props.connectionState !== "connected") &&
    hasContent &&
    !contextImports[composerDraftKey] &&
    !isSubmissionLocked &&
    sendBlockedReason === null &&
    !modelUnavailable;

  // oxlint-disable-next-line lecturn/no-unreasoned-state-sync -- clears the workspace layout's composer-editing flag when the composer unmounts
  useEffect(() => () => setComposerEditing(false), [setComposerEditing]);
  // A pending sheet presentation or focus restore has no composer left to act on.
  // oxlint-disable-next-line lecturn/no-unreasoned-state-sync -- disposes the pending settings sheet presentation and focus restore on unmount
  useEffect(() => () => disposeSettingsSheetPresentation(), []);

  const onPressPreview = (source: FilePreviewSource) => {
    wasExpandedBeforePreviewRef.current = isFocused;
    setPreviewVideo(null);
    setPreviewFile(
      (current) =>
        current ?? {
          ...source,
          gallery: filePreviewGallery(source, composerImageGallery(draftAttachments)),
        },
    );
  };

  const closePreview = () => {
    setPreviewFile(null);
    setPreviewVideo(null);
    if (wasExpandedBeforePreviewRef.current) {
      setTimeout(() => {
        if (navigation.isFocused()) inputRef.current?.focus();
      }, 100);
    }
  };

  const onPressVideo = (attachment: DraftComposerFileAttachment, sourceIdentifier: string) => {
    wasExpandedBeforePreviewRef.current = isFocused;
    setPreviewFile(null);
    setPreviewVideo((current) => current ?? { type: "local", attachment, sourceIdentifier });
  };

  const onEditorFocusChange = props.onEditorFocusChange;
  const handleFocus = () => {
    setIsFocused(true);
    settingsSheetPresentation.onEditorFocusChange(true);
    onEditorFocusChange?.(true);
    setComposerEditing(true);
  };

  const handleBlur = () => {
    setIsFocused(false);
    settingsSheetPresentation.onEditorFocusChange(false);
    onEditorFocusChange?.(false);
    setComposerEditing(false);
  };
  const handleSend = async (followUp?: ActiveTurnComposerAction) => {
    if (
      isSubmissionLocked ||
      sendBlockedReason !== null ||
      pendingPastedTextAttachmentCountRef.current > 0 ||
      pendingNativeImagePasteCountRef.current > 0
    )
      return;
    if (usageLimitsOffered && isUsageLimitsCommand(draftMessage) && draftAttachments.length === 0) {
      if (openUsageLimits()) onChangeDraftMessage("");
      return;
    }
    const threadKey = scopedThreadKey(props.environmentId, props.selectedThread.id);
    if (inFlightThreadIdsRef.current.has(threadKey)) return;
    inFlightThreadIdsRef.current.add(threadKey);
    const draftAtSend = getComposerDraftSnapshot(composerDraftKey);
    const stillSendable = () => {
      const draft = getComposerDraftSnapshot(composerDraftKey);
      return (
        pendingPastedTextAttachmentCountRef.current === 0 &&
        pendingNativeImagePasteCountRef.current === 0 &&
        draft.text === draftAtSend.text &&
        draft.attachments.length === draftAtSend.attachments.length &&
        draft.attachments.every(
          (attachment, index) => attachment.id === draftAtSend.attachments[index]?.id,
        )
      );
    };
    const sent = await settlePromise(() => onSendMessage(followUp, stillSendable));
    inFlightThreadIdsRef.current.delete(threadKey);
    if (AsyncResult.isFailure(sent)) {
      console.error("[composer] send failed", squashAtomCommandFailure(sent));
      return;
    }
    if (sent.value === null) return;
    // Arm after send so preference reads and native Activity startup do not delay tap-frame feedback.
    armAgentAwarenessLiveActivityForLocalWork({
      environmentId: props.environmentId,
      threadTitle: props.selectedThread.title,
      projectTitle: props.environmentLabel ?? "Lecturn",
    });
  };

  const lockedProviderInstanceId = props.canSwitchProvider
    ? undefined
    : currentModelSelection.instanceId;
  const modelOptions = buildModelOptions(
    props.serverConfig,
    currentModelSelection,
    lockedProviderInstanceId,
    props.selectedThread.projectId,
  );
  const currentModelOption =
    modelOptions.find(
      (option) =>
        option.selection.instanceId === currentModelSelection.instanceId &&
        option.selection.model === currentModelSelection.model,
    ) ?? null;
  // The model tray under the composer labels the selection the settings sheet edits.
  const providerOptionDescriptors = resolveProviderOptionDescriptors({
    capabilities: currentModelOption?.capabilities,
    selections: currentModelSelection.options,
  });
  const currentRuntimeMode = props.selectedThread.runtimeMode;
  const openSettings = () => {
    settingsSheetPresentation.open();
  };

  useFocusEffect(() => {
    if (!settingsRoutePresentedRef.current) {
      return;
    }

    settingsRoutePresentedRef.current = false;
    settingsSheetPresentation.onDismissed();
  });

  // oxlint-disable-next-line lecturn/no-unreasoned-state-sync -- subscribes to the native stack's finishTransitioning event to restore the keyboard after a sheet dismisses
  useEffect(
    () =>
      // The native-stack patch exposes UIKit dismissal completion; restore the keyboard then.
      (navigation as unknown as NavigationWithFinishTransitioning).addListener(
        "finishTransitioning",
        settingsSheetPresentation.onStackTransitionsFinished,
      ),
    [navigation, settingsSheetPresentation.onStackTransitionsFinished],
  );

  // Removable attachments: inside the card, or above the focused one-row composer.
  const editingAttachments = hasEditingAttachments ? (
    <>
      {queuedEdit !== null && queuedEdit.existingAttachments.length > 0 ? (
        <Animated.View
          className="px-[14px] pb-2.5 pt-2"
          entering={COMPOSER_ATTACHMENT_ENTERING}
          exiting={FadeOut.duration(120)}
        >
          <ComposerQueuedEditAttachments
            environmentId={props.environmentId}
            attachments={queuedEdit.existingAttachments}
            disabled={isSubmissionLocked}
            onRemove={queuedEdit.onRemoveExistingAttachment}
          />
        </Animated.View>
      ) : null}
      {stripAttachments.length > 0 ? (
        <Animated.View
          className="px-[14px] pb-2.5 pt-2"
          entering={COMPOSER_ATTACHMENT_ENTERING}
          exiting={FadeOut.duration(120)}
        >
          <ComposerAttachmentStrip
            environmentId={props.environmentId}
            attachments={stripAttachments}
            onRemove={isSubmissionLocked ? () => undefined : props.onRemoveDraftImage}
            onPressPreview={isSubmissionLocked ? undefined : onPressPreview}
            onPressVideo={isSubmissionLocked ? undefined : onPressVideo}
            onPressDocument={
              isSubmissionLocked
                ? undefined
                : (attachment) =>
                    openDraftDocument({
                      attachmentId: attachment.id,
                      name: attachment.name,
                      mimeType: attachment.mimeType,
                      sizeBytes: attachment.sizeBytes,
                    })
            }
          />
        </Animated.View>
      ) : null}
    </>
  ) : null;

  return (
    <Animated.View
      onLayout={(event) => props.onHeightChange?.(event.nativeEvent.layout.height)}
      className="px-[14px]"
      style={{
        paddingTop: 6,
        paddingBottom: (props.bottomInset ?? 0) + THREAD_COMPOSER_BOTTOM_GUTTER,
        backgroundColor:
          Platform.OS === "android" ? themeColorWithAlpha(composerPanel, 1) : undefined,
      }}
    >
      {/* Use a plain View: Reanimated Animated.View drops experimental_backgroundImage on Android. */}
      <View
        className={
          Platform.OS === "android"
            ? "hidden"
            : "absolute inset-0 bg-linear-to-b from-screen/0 via-screen/60 to-screen/90"
        }
        pointerEvents="none"
      />
      <Animated.View
        className="relative w-full self-center"
        style={{ maxWidth: props.contentMaxWidth }}
      >
        {props.draftControls}
        {!isSubmissionLocked &&
        composerMenu.trigger &&
        (composerMenu.items.length > 0 || composerMenu.trigger.kind === "pull-request") ? (
          <ComposerPopoverAnchor>
            <ComposerCommandPopover
              items={composerMenu.items}
              triggerKind={composerMenu.trigger.kind}
              isLoading={composerMenu.isLoading}
              error={composerMenu.error}
              onSelect={composerMenu.onSelect}
            />
          </ComposerPopoverAnchor>
        ) : null}

        {selectedProviderStatus?.compatibilityAdvisory?.message &&
        (selectedProviderStatus.compatibilityAdvisory.status === "unsupported" ||
          selectedProviderStatus.compatibilityAdvisory.status === "broken") ? (
          <Text
            accessibilityRole={
              selectedProviderStatus.compatibilityAdvisory.status === "broken" ? "alert" : undefined
            }
            accessibilityLiveRegion={
              selectedProviderStatus.compatibilityAdvisory.status === "broken"
                ? "assertive"
                : "polite"
            }
            className={
              selectedProviderStatus.compatibilityAdvisory.status === "broken"
                ? "bg-danger px-3 py-2 text-xs text-danger-foreground"
                : "px-3 py-2 text-xs text-foreground"
            }
          >
            {selectedProviderStatus.compatibilityAdvisory.message}
          </Text>
        ) : null}
        {modelUnavailable && allows("model-picker") ? (
          <Button
            label="Model unavailable. Open model settings."
            tone="text"
            onPress={openSettings}
          />
        ) : null}

        <ComposerSurface
          animateLayout={false}
          style={{
            borderRadius: usesLargeControls ? 31 : 27,
            borderCurve: "circular",
            overflow: "hidden",
            paddingVertical: surfacePaddingVertical,
          }}
        >
          {isExpanded ? editingAttachments : null}
          <View
            onLayout={(event) => {
              compactEditor.onRowLayout(event);
              setCompactRowWidth(event.nativeEvent.layout.width);
            }}
          >
            <ComposerDictationDraftContent
              className="flex-row items-end"
              compact
              hidden={showsCompactDictation}
            >
              {allows("attachments") ? (
                <ComposerAttachmentButton
                  size={usesLargeControls ? "large" : "regular"}
                  disabled={isSubmissionLocked}
                  supportsFiles={props.serverConfig !== null}
                  onPickMedia={props.onPickDraftMedia}
                  onPickFiles={props.onPickDraftFiles}
                />
              ) : null}
              {compactEditor.isExpanded && !props.isDraft && allows("contextual") ? (
                <View className="h-[44px] justify-center pl-1">
                  <ContextualThreadControl
                    compact
                    environmentId={props.environmentId}
                    threadId={props.selectedThread.id}
                  />
                </View>
              ) : null}
              <Animated.View
                className="min-w-0 flex-1"
                onLayout={compactEditor.onEditorLayout}
                style={[
                  {
                    minWidth:
                      compactEditor.isExpanded || stripAttachments.length > 0
                        ? 0
                        : INLINE_EDITOR_MIN_WIDTH,
                  },
                  compactEditor.containerStyle,
                  compactEditor.isExpanded ? { flex: 0, width: 0 } : undefined,
                ]}
              ></Animated.View>
              {!isExpanded && stripAttachments.length > 0 ? (
                <View className="h-[44px] shrink-0 flex-row items-center gap-1 pl-1">
                  {stripAttachments.slice(0, compactAttachmentLimit).map((attachment) => (
                    <ComposerAttachmentThumbnail
                      environmentId={props.environmentId}
                      key={attachment.id}
                      attachment={attachment}
                      size={30}
                      borderRadius={8}
                      compact
                      onPressPreview={isSubmissionLocked ? undefined : onPressPreview}
                      onPressVideo={isSubmissionLocked ? undefined : onPressVideo}
                    />
                  ))}
                  {stripAttachments.length > compactAttachmentLimit ? (
                    <View className="size-[30px] items-center justify-center rounded-lg bg-subtle-strong">
                      <Text className="text-foreground-muted text-2xs font-lecturn-bold">
                        +{stripAttachments.length - compactAttachmentLimit}
                      </Text>
                    </View>
                  ) : null}
                </View>
              ) : null}
              <View
                className="min-w-0 shrink flex-row items-center"
                style={
                  compactEditor.isExpanded ? { flex: 1, justifyContent: "flex-end" } : undefined
                }
              >
                <ComposerDictationStartAction
                  size={usesLargeControls ? "large" : "regular"}
                  state={voiceInput.state}
                  isAvailable={voiceInput.isAvailable}
                  disabled={isSubmissionLocked}
                  onStart={voiceInput.start}
                  onCancel={voiceInput.cancel}
                />
                {showStopAction ? (
                  <ComposerActionButton
                    size={usesLargeControls ? "large" : "regular"}
                    accessibilityLabel="Stop agent"
                    icon="stop.fill"
                    variant="danger"
                    disabled={!props.canOperateThread}
                    onPress={props.onStopThread}
                  />
                ) : showResumeAction ? (
                  <ComposerActionButton
                    size={usesLargeControls ? "large" : "regular"}
                    accessibilityLabel="Resume queue"
                    icon="play"
                    disabled={!props.canOperateThread || resumingQueue}
                    onPress={() => void handleResumeQueue()}
                  />
                ) : (
                  <SendActionButton
                    size={usesLargeControls ? "large" : "regular"}
                    accessibilityLabel={sendBlockedReason ?? sendLabel}
                    presentation={sendPresentation}
                    disabled={!canSend}
                    onSend={handleSend}
                  />
                )}
              </View>
            </ComposerDictationDraftContent>
            <Animated.View
              style={[
                compactEditor.editorStyle,
                showsCompactDictation ? { display: "none" } : undefined,
              ]}
            >
              <ComposerEditor
                hidden={props.hidden}
                draftKey={composerDraftKey}
                environmentId={props.environmentId}
                onOpenMention={(path) => {
                  Keyboard.dismiss();
                  if (props.isDraft) {
                    navigation.navigate("NewTaskFile", {
                      environmentId: String(props.environmentId),
                      cwd: props.projectCwd ?? undefined,
                      path: fileRoutePathSegments(path),
                    });
                  } else {
                    navigation.navigate("ThreadFile", {
                      environmentId: String(props.environmentId),
                      threadId: String(props.selectedThread.id),
                      path: fileRoutePathSegments(path),
                    });
                  }
                }}
                onOpenAttachment={openDraftDocument}
                chipsInert={!isExpanded}
                onInertChipPress={() => inputRef.current?.focus()}
                ref={inputRef}
                multiline
                value={draftMessage}
                // The save uses a draft snapshot; further typing would be discarded on success.
                readOnly={isSubmissionLocked}
                skills={composerMenu.skills}
                selection={composerMenu.selection}
                onChangeText={(text) => {
                  if (!isSubmissionLocked) props.onChangeDraftMessage(text);
                }}
                onSelectionChange={composerMenu.onSelectionChange}
                onPasteImages={(uris) => {
                  if (!allows("attachments") || isSubmissionLocked) return;
                  pendingNativeImagePasteCountRef.current += 1;
                  void props.onNativePasteImages(uris).finally(() => {
                    pendingNativeImagePasteCountRef.current -= 1;
                  });
                }}
                onPasteText={(paste) => {
                  if (isSubmissionLocked) return;
                  const insertPaste = () => {
                    const insertion = replaceTextSelection({
                      value: paste.value,
                      selection: paste.selection,
                      text: paste.text,
                    });
                    const selection = { start: insertion.cursor, end: insertion.cursor };
                    props.onChangeDraftMessage(insertion.value);
                    composerMenu.onSelectionChange(selection);
                  };
                  const capabilities = props.serverConfig?.environment.capabilities;
                  const advertisedMax = capabilities?.fileAttachments?.maxUploadBytes;
                  const maxBytes =
                    advertisedMax === undefined
                      ? null
                      : clampFileAttachmentUploadBytes(advertisedMax);
                  const wouldExceedInputLimit =
                    paste.value.length -
                      Math.max(0, paste.selection.end - paste.selection.start) +
                      paste.text.length >
                    PROVIDER_SEND_TURN_MAX_INPUT_CHARS;
                  const canAttach =
                    allows("attachments") &&
                    maxBytes !== null &&
                    countComposerDraftAttachmentsAfterSelection(composerDraftKey, {
                      text: paste.value,
                      ...paste.selection,
                    }) < PROVIDER_SEND_TURN_MAX_ATTACHMENTS &&
                    new TextEncoder().encode(paste.text).byteLength <= maxBytes;
                  if (
                    pastedTextDisposition({
                      text: paste.text,
                      wouldExceedInputLimit,
                      canAttach: true,
                    }) === "attachment"
                  ) {
                    if (canAttach) {
                      pendingPastedTextAttachmentCountRef.current += 1;
                      setPendingPastedTextAttachmentCount(
                        pendingPastedTextAttachmentCountRef.current,
                      );
                      const finishAttachment = () => {
                        pendingPastedTextAttachmentCountRef.current = Math.max(
                          0,
                          pendingPastedTextAttachmentCountRef.current - 1,
                        );
                        setPendingPastedTextAttachmentCount(
                          pendingPastedTextAttachmentCountRef.current,
                        );
                      };
                      void props.onNativePasteText(paste).then(finishAttachment, finishAttachment);
                    } else if (!wouldExceedInputLimit) {
                      insertPaste();
                    } else {
                      Dialog.alert(
                        "Pasted text is too large for this message",
                        "Remove some text or an attachment, then paste again.",
                      );
                    }
                    return;
                  }
                  insertPaste();
                }}
                placeholder={props.placeholder}
                onFocus={handleFocus}
                onBlur={handleBlur}
                onSubmit={(alternate) =>
                  void handleSend(
                    alternate && sendPresentation.alternate !== null
                      ? sendPresentation.alternate
                      : undefined,
                  )
                }
                submitTitle={sendPresentation.label}
                alternateSubmitTitle={
                  sendPresentation.alternate === null
                    ? sendPresentation.label
                    : FOLLOW_UP_ACTION_LABEL[sendPresentation.alternate]
                }
                {...compactEditor.editorProps}
                textStyle={{
                  ...bodyText,
                  color: foregroundColor,
                }}
              />
            </Animated.View>
          </View>
          <Animated.View
            accessibilityElementsHidden={!isToolbarVisible}
            collapsable={false}
            importantForAccessibility={isToolbarVisible ? "auto" : "no-hide-descendants"}
            pointerEvents={isToolbarVisible ? "auto" : "none"}
            style={{ position: "absolute", bottom: surfacePaddingVertical, left: 0, right: 0 }}
          >
            <ComposerDictationToolbar
              showsDictation={isVoiceInputPresented}
              visible={isToolbarVisible}
            >
              <ComposerToolbarRow
                paddingBottom={0}
                paddingHorizontal={0}
                paddingTop={0}
                style={{ gap: 0 }}
              >
                <ComposerDictationCancelAction
                  size={usesLargeControls ? "large" : "regular"}
                  presentation={voicePresentation}
                  onCancel={voiceInput.cancel}
                />
                <ComposerDictationStatus
                  audioLevels={voiceInput.audioLevels}
                  elapsedSeconds={voiceInput.elapsedSeconds}
                  phase={voiceInput.state.phase}
                  presentation={voicePresentation}
                  onDismissError={voiceInput.cancel}
                />
                <View className="shrink-0 flex-row items-center">
                  <ComposerDictationPrimaryAction
                    size={usesLargeControls ? "large" : "regular"}
                    state={voiceInput.state}
                    presentation={voicePresentation}
                    isAvailable={voiceInput.isAvailable}
                    disabled={isSubmissionLocked}
                    onStart={voiceInput.start}
                    onConfirm={voiceInput.stop}
                    onCancel={voiceInput.cancel}
                  />
                  {showStopAction ? (
                    <ComposerActionButton
                      size={usesLargeControls ? "large" : "regular"}
                      accessibilityLabel="Stop agent"
                      icon="stop.fill"
                      variant="danger"
                      disabled={!props.canOperateThread}
                      onPress={props.onStopThread}
                    />
                  ) : showResumeAction && voicePresentation.showsSend ? (
                    <ComposerActionButton
                      size={usesLargeControls ? "large" : "regular"}
                      accessibilityLabel="Resume queue"
                      icon="play"
                      disabled={!props.canOperateThread || resumingQueue}
                      onPress={() => void handleResumeQueue()}
                    />
                  ) : voicePresentation.showsSend ? (
                    <SendActionButton
                      size={usesLargeControls ? "large" : "regular"}
                      accessibilityLabel={sendBlockedReason ?? sendLabel}
                      presentation={sendPresentation}
                      disabled={!canSend}
                      onSend={handleSend}
                    />
                  ) : null}
                </View>
              </ComposerToolbarRow>
            </ComposerDictationToolbar>
          </Animated.View>
        </ComposerSurface>
        {allows("model-picker") ? (
          <GlassCard
            radius={19}
            style={{
              marginHorizontal: 18,
              marginTop: -2,
              borderTopLeftRadius: 0,
              borderTopRightRadius: 0,
              borderTopWidth: 0,
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={[
                "Model and reasoning settings",
                currentModelOption?.label ?? currentModelSelection.model,
                ...providerOptionValueLabels(providerOptionDescriptors),
                RUNTIME_MODE_CHOICES.find((choice) => choice.mode === currentRuntimeMode)?.label ??
                  currentRuntimeMode,
                props.selectedThread.interactionMode === "plan" ? "Plan mode" : "Chat mode",
              ].join(", ")}
              onPress={openSettings}
              disabled={voiceInput.isBusy}
              accessibilityState={{ disabled: voiceInput.isBusy }}
              style={{ minHeight: 44, opacity: voiceInput.isBusy ? 0.6 : 1 }}
              className="flex-row items-center gap-2 px-3 active:opacity-70"
            >
              <ProviderIcon
                iconUrl={currentModelOption?.providerIconUrl}
                provider={currentModelOption?.providerDriver}
                size={17}
              />
              <Text
                className="shrink text-xs font-lecturn-medium text-foreground"
                numberOfLines={1}
                style={{ maxWidth: "38%" }}
              >
                {currentModelOption?.shortName ??
                  currentModelOption?.label ??
                  currentModelSelection.model}
              </Text>
              <View className="h-3.5 w-px bg-border" />
              <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
                {[
                  ...providerOptionValueLabels(providerOptionDescriptors),
                  RUNTIME_MODE_CHOICES.find((choice) => choice.mode === currentRuntimeMode)
                    ?.label ?? currentRuntimeMode,
                  ...(props.selectedThread.interactionMode === "plan" ? ["Plan"] : []),
                ].join(" · ")}
              </Text>
              <SymbolView name="chevron.right" size={11} tintColorClassName="accent-icon-muted" />
            </Pressable>
          </GlassCard>
        ) : null}

        {props.connectionState === "connected" && !props.canOperateThread ? (
          <Text className="pt-2 text-xs text-foreground-muted">
            This connection cannot control this task. You can still edit your draft.
          </Text>
        ) : null}
      </Animated.View>

      <VideoPreviewModal source={previewVideo} onRequestClose={closePreview} />
      <FilePreviewModal source={previewFile} onRequestClose={closePreview} />
    </Animated.View>
  );
};

import type { ChatComposerProps } from "./ChatComposer";
import type { PromptUltrathink } from "./TraitsPicker";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { type AppModelOption } from "../../modelSelection";
import { CircleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";
import { allowsChatViewControl, type ChatViewControls } from "./chatViewControls";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { ComposerControl, ComposerControlSeparator } from "./ComposerControl";
import {
  ComposerPermissionsSection,
  ComposerFooterModeControls,
  ComposerModelPicker,
  type RuntimeModeOption,
} from "./ComposerFooterControls";
import {
  type EnvironmentId,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerProvider,
} from "@lecturn/contracts";
import type { EffortDisplay } from "@lecturn/contracts/settings";
import { cn } from "~/lib/utils";
import { shortcutLabelForCommand } from "../../keybindings";
import {
  renderProviderTraitsMenuContent,
  renderProviderTraitsPicker,
} from "./composerProviderState";
import type { useComposerProviderModel } from "./useComposerProviderModel";
import { resolveComposerControlsOwnership } from "./composerControlsOwnership";

/**
 * The composer footer controls: model picker, traits, mode controls and the overflow menu for
 * blocks that do not fit. Rendered in the footer or the collapsed mobile controls row.
 */
// Model and effort sit a word space apart, so hover and open states brighten text, not a box.
// The Lecturn look keeps its hover box.
const TEXT_CONTROL_STATES =
  "redesign:hover:bg-transparent redesign:data-pressed:bg-transparent redesign:data-popup-open:bg-transparent data-pressed:text-foreground data-popup-open:text-foreground";

export function ComposerControlsBar(props: {
  environmentId: EnvironmentId;
  routeKind: ChatComposerProps["routeKind"];
  routeThreadRef: ChatComposerProps["routeThreadRef"];
  draftId: ChatComposerProps["draftId"];
  selectedProvider: ProviderDriverKind;
  selectedInstanceId: ProviderInstanceId;
  selectedModel: string;
  selectedProviderModels: ServerProvider["models"];
  composerModelOptions: ReturnType<typeof useComposerProviderModel>["composerModelOptions"];
  reportedModelSelection: ChatComposerProps["reportedModelSelection"];
  promptUltrathink: PromptUltrathink;
  onPromptEdit: (edit: (prompt: string) => string) => void;
  planModeEnabled: boolean;
  planModeUiEnabled: boolean;
  effortDisplay: EffortDisplay;
  /** The strip under a new thread names the permissions, so the row does not repeat them. */
  permissionsShownInStrip: boolean;
  /** The new design: Permissions live in the effort menu. The Lecturn look keeps its chip. */
  permissionsInEffortMenu: boolean;
  interactionMode: ProviderInteractionMode;
  compatibleRuntimeMode: RuntimeMode;
  defaultRuntimeMode: RuntimeMode | undefined;
  compatibleRuntimeModeOptions: ReadonlyArray<RuntimeModeOption>;
  toggleInteractionMode: () => void;
  handleRuntimeModeChange: (mode: RuntimeMode) => void;
  composerControlsCollapsed: boolean;
  composerControlsHidden: boolean;
  restingHiddenBlockCount: number;
  iconOnlyBlockCount: number;
  showProviderUnavailable: boolean;
  providerSetupInstanceId: ProviderInstanceId | undefined;
  onOpenProviderSetup: ChatComposerProps["onOpenProviderSetup"];
  providerCatalogPending: boolean;
  isSendBusy: boolean;
  multipleModelsEnabled: boolean;
  multipleModelSelections: ChatComposerProps["multipleModelSelections"];
  onMultipleModelSelectionsChange: ChatComposerProps["onMultipleModelSelectionsChange"];
  selectedModelSelection: ModelSelection;
  onProviderModelSelect: ChatComposerProps["onProviderModelSelect"];
  activeThreadModelSelection: ChatComposerProps["activeThreadModelSelection"];
  selectedModelForPickerWithCustomFallback: string;
  lockedProvider: ChatComposerProps["lockedProvider"];
  lockedContinuationGroupKey: string | null;
  /** Lecturn: an unsent import resumes only on the instance it was imported with. */
  lockedInstanceId: ProviderInstanceId | null;
  providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings: ChatComposerProps["keybindings"];
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>;
  terminalOpen: boolean;
  modelPickerOpen: boolean;
  onModelPickerOpenChange: (open: boolean) => void;
  modelPickerIconClassName: string | undefined;
  getModelDisabledReason: ChatComposerProps["getModelDisabledReason"];
  /** Lecturn: ChatView's allowlist; absent shows every composer control. */
  controls: ChatViewControls | undefined;
  contextualBlock: boolean;
  contextualControl: (size: "xs" | "sm", hidden?: boolean) => ReactNode;
  embedFooterStacked: boolean;
}) {
  const {
    environmentId,
    routeKind,
    routeThreadRef,
    draftId,
    selectedProvider,
    selectedInstanceId,
    selectedModel,
    selectedProviderModels,
    composerModelOptions,
    reportedModelSelection,
    promptUltrathink,
    onPromptEdit,
    planModeEnabled,
    planModeUiEnabled,
    interactionMode,
    compatibleRuntimeMode,
    defaultRuntimeMode,
    compatibleRuntimeModeOptions,
    toggleInteractionMode,
    handleRuntimeModeChange,
    composerControlsCollapsed,
    composerControlsHidden,
    restingHiddenBlockCount: measuredHiddenBlockCount,
    iconOnlyBlockCount,
    showProviderUnavailable,
    providerSetupInstanceId,
    onOpenProviderSetup,
    providerCatalogPending,
    isSendBusy,
    multipleModelsEnabled,
    multipleModelSelections,
    onMultipleModelSelectionsChange,
    selectedModelSelection,
    onProviderModelSelect,
    activeThreadModelSelection,
    selectedModelForPickerWithCustomFallback,
    lockedProvider,
    lockedContinuationGroupKey,
    lockedInstanceId,
    providerInstanceEntries,
    keybindings,
    modelOptionsByInstance,
    terminalOpen,
    modelPickerOpen,
    onModelPickerOpenChange,
    modelPickerIconClassName,
    getModelDisabledReason,
    controls,
    contextualBlock,
    contextualControl,
    embedFooterStacked,
  } = props;
  const modelPickerAllowed = allowsChatViewControl(controls, "model-picker");
  const runtimeModeAllowed = allowsChatViewControl(controls, "runtime-mode");
  const interactionModeAllowed =
    planModeUiEnabled && allowsChatViewControl(controls, "interaction-mode");
  const contextualBlockShown = contextualBlock && !embedFooterStacked;
  // The measured count includes Contextual, the last block, before traits and mode.
  const contextualHidden = contextualBlockShown && measuredHiddenBlockCount > 0;
  const providerTraitsMenuContent = renderProviderTraitsMenuContent({
    provider: selectedProvider,
    instanceId: selectedInstanceId,
    ...(routeKind === "server" ? { threadRef: routeThreadRef } : {}),
    ...(routeKind === "draft" && draftId ? { draftId } : {}),
    model: selectedModel,
    models: selectedProviderModels,
    modelOptions: composerModelOptions?.[selectedInstanceId],
    reportedModelSelection,
    promptUltrathink,
    onPromptEdit,
    planModeEnabled,
  });
  const { permissionsInEffortMenu } = props;
  const accessMatchesDefault = compatibleRuntimeMode === defaultRuntimeMode;
  const permissionsChipHidden =
    permissionsInEffortMenu && (accessMatchesDefault || props.permissionsShownInStrip);
  const effortMenuPermissions = permissionsInEffortMenu && runtimeModeAllowed;
  const providerTraitsPickerInput = {
    provider: selectedProvider,
    instanceId: selectedInstanceId,
    ...(routeKind === "server" ? { threadRef: routeThreadRef } : {}),
    ...(routeKind === "draft" && draftId ? { draftId } : {}),
    model: selectedModel,
    models: selectedProviderModels,
    modelOptions: composerModelOptions?.[selectedInstanceId],
    reportedModelSelection,
    promptUltrathink,
    onPromptEdit,
    planModeEnabled,
    isComposerOwned: true,
    effortDisplay: props.effortDisplay,
    triggerClassName: cn("redesign:ps-1.5 redesign:pe-1", TEXT_CONTROL_STATES),
    // In the new design Permissions always live here, so the section never unmounts while open.
    extraMenuContent: effortMenuPermissions ? (
      <ComposerPermissionsSection
        runtimeMode={compatibleRuntimeMode}
        runtimeModeOptions={compatibleRuntimeModeOptions}
        onRuntimeModeChange={handleRuntimeModeChange}
      />
    ) : undefined,
    ...(permissionsChipHidden && effortMenuPermissions
      ? {
          extraMenuHint: [
            `Permissions: ${
              compatibleRuntimeModeOptions.find((option) => option.mode === compatibleRuntimeMode)
                ?.label ?? compatibleRuntimeMode
            }`,
            shortcutLabelForCommand(keybindings, "composer.mode"),
          ]
            .filter(Boolean)
            .join(" · "),
        }
      : {}),
  } satisfies Parameters<typeof renderProviderTraitsPicker>[0];
  const providerTraitsPicker = renderProviderTraitsPicker(providerTraitsPickerInput);
  const {
    accessDisplay,
    showModeBlock,
    hiddenBlockCount: ownedHiddenBlockCount,
    hiddenBlockIds: ownedHiddenBlockIds,
    traitsHidden: traitsBlockHidden,
    effortOwnsModeShortcut,
    overflowShowsPermissions,
  } = resolveComposerControlsOwnership({
    permissionsInEffortMenu,
    matchesDefault: permissionsChipHidden,
    hasTraits: providerTraitsPicker !== null && modelPickerAllowed,
    planModeUiEnabled: interactionModeAllowed,
    collapsed: composerControlsCollapsed,
    measuredHiddenBlockCount: Math.max(0, measuredHiddenBlockCount - (contextualHidden ? 1 : 0)),
  });
  const restingHiddenBlockCount = ownedHiddenBlockCount + (contextualHidden ? 1 : 0);
  const hiddenRestingBlockIds: ReadonlyArray<string> = [
    ...ownedHiddenBlockIds,
    ...(contextualHidden ? ["contextual"] : []),
  ];
  const restingProviderTraitsPicker = renderProviderTraitsPicker({
    ...providerTraitsPickerInput,
    size: composerControlsCollapsed ? "xs" : "sm",
    hidden: composerControlsHidden || traitsBlockHidden,
    extraMenuOwnsModeShortcut: effortOwnsModeShortcut,
  });
  const restingBlockDefs = [
    ...(providerTraitsPicker && modelPickerAllowed
      ? [
          {
            id: "traits",
            content: (
              <>
                <ComposerControlSeparator
                  size={composerControlsCollapsed ? "xs" : "sm"}
                  className="redesign:hidden!"
                />
                {restingProviderTraitsPicker}
              </>
            ),
          },
        ]
      : []),
    ...(!showModeBlock || !(runtimeModeAllowed || interactionModeAllowed)
      ? []
      : [
          {
            id: "mode",
            content: (
              <ComposerFooterModeControls
                showInteractionModeToggle={interactionModeAllowed}
                interactionMode={interactionMode}
                runtimeMode={compatibleRuntimeMode}
                runtimeModeOptions={compatibleRuntimeModeOptions}
                size={composerControlsCollapsed ? "xs" : "sm"}
                hidden={composerControlsHidden || ownedHiddenBlockCount > 0}
                accessDisplay={runtimeModeAllowed ? accessDisplay : "hidden"}
                emphasized={permissionsInEffortMenu && !accessMatchesDefault}
                onToggleInteractionMode={toggleInteractionMode}
                onRuntimeModeChange={handleRuntimeModeChange}
              />
            ),
          },
        ]),
    // Lecturn: Contextual is the last block, so it overflows first.
    ...(contextualBlockShown
      ? [
          {
            id: "contextual",
            content: (
              <>
                <ComposerControlSeparator size={composerControlsCollapsed ? "xs" : "sm"} />
                {contextualControl(
                  composerControlsCollapsed ? "xs" : "sm",
                  composerControlsHidden || contextualHidden,
                )}
              </>
            ),
          },
        ]
      : []),
  ];
  // Its own element, so typing (which rebuilds the controls around it) leaves it cached.
  const composerModelPicker = (
    <ComposerModelPicker
      environmentId={environmentId}
      compact={false}
      isComposerOwned
      disabled={providerCatalogPending || isSendBusy}
      multipleModelsEnabled={multipleModelsEnabled}
      multipleModelSelections={multipleModelSelections}
      onMultipleModelSelectionsChange={onMultipleModelSelectionsChange}
      selectedModelSelection={selectedModelSelection}
      onProviderModelSelect={onProviderModelSelect}
      activeInstanceId={
        providerCatalogPending
          ? (activeThreadModelSelection?.instanceId ?? selectedInstanceId)
          : selectedInstanceId
      }
      model={
        providerCatalogPending
          ? (activeThreadModelSelection?.model ?? selectedModelForPickerWithCustomFallback)
          : selectedModelForPickerWithCustomFallback
      }
      lockedProvider={lockedProvider}
      lockedContinuationGroupKey={lockedContinuationGroupKey}
      lockedInstanceId={lockedInstanceId}
      instanceEntries={providerInstanceEntries}
      keybindings={keybindings}
      modelOptionsByInstance={modelOptionsByInstance}
      size={composerControlsCollapsed ? "xs" : "sm"}
      triggerClassName={cn(
        "redesign:pe-1",
        TEXT_CONTROL_STATES,
        composerControlsCollapsed
          ? "min-w-13 shrink text-xs!"
          : // The Lecturn look starts the controls row, aligned with the prompt text.
            "-ms-2.5 min-w-13 redesign:ms-0",
      )}
      terminalOpen={terminalOpen}
      open={modelPickerOpen}
      instanceIndicatorBackground={
        composerControlsCollapsed
          ? "color-mix(in srgb, var(--chat-composer-glass-surface) var(--glass-opacity), transparent)"
          : "var(--contrast-input)"
      }
      {...(modelPickerIconClassName
        ? { activeProviderIconClassName: modelPickerIconClassName }
        : {})}
      onOpenChange={onModelPickerOpenChange}
      getModelDisabledReason={getModelDisabledReason}
      onOpenProviderSetup={onOpenProviderSetup}
    />
  );
  const showProviderSetupControl = showProviderUnavailable && modelPickerAllowed;
  return showProviderSetupControl ? (
    <>
      <ComposerControl
        type="button"
        disabled={!providerSetupInstanceId}
        onClick={() => {
          if (providerSetupInstanceId) {
            onOpenProviderSetup(providerSetupInstanceId);
          }
        }}
        data-chat-provider-unavailable="true"
        className="shrink-0"
      >
        <CircleAlertIcon className="size-4" />
        {providerSetupInstanceId ? "Open provider settings" : "No provider available"}
      </ComposerControl>
      {contextualControl(composerControlsCollapsed ? "xs" : "sm")}
    </>
  ) : (
    <>
      {modelPickerAllowed ? composerModelPicker : null}

      <>
        {restingBlockDefs.map((def, index) => {
          const hidden = index >= restingBlockDefs.length - restingHiddenBlockCount;
          return (
            <div
              key={def.id}
              data-resting-block={def.id}
              data-composer-block-icon-only={
                index >= restingBlockDefs.length - iconOnlyBlockCount ? "true" : "false"
              }
              aria-hidden={hidden || undefined}
              inert={hidden || undefined}
              className={cn(
                "flex w-max min-w-max shrink-0 items-center gap-1",
                hidden && "pointer-events-none invisible absolute",
                index >= restingBlockDefs.length - iconOnlyBlockCount &&
                  "[&_[data-composer-control-label]]:pointer-events-none [&_[data-composer-control-label]]:invisible [&_[data-composer-control-label]]:absolute [&_[data-composer-control-label]]:w-max [&_[data-composer-control-label]]:max-w-none [&_[data-composer-control-compact-icon]]:[visibility:inherit] [&_[data-composer-control-compact-icon]]:relative",
              )}
            >
              {def.content}
            </div>
          );
        })}
        <div
          data-resting-controls-overflow
          aria-hidden={hiddenRestingBlockIds.length === 0 || undefined}
          inert={hiddenRestingBlockIds.length === 0 || undefined}
          className={cn(
            "min-w-0 shrink-0",
            hiddenRestingBlockIds.length === 0 && "pointer-events-none invisible absolute",
          )}
        >
          <CompactComposerControlsMenu
            interactionMode={interactionMode}
            runtimeMode={compatibleRuntimeMode}
            runtimeModeOptions={compatibleRuntimeModeOptions}
            size={composerControlsCollapsed ? "xs" : "sm"}
            hidden={composerControlsHidden || hiddenRestingBlockIds.length === 0}
            showInteractionModeToggle={planModeUiEnabled && hiddenRestingBlockIds.includes("mode")}
            traitsMenuContent={
              hiddenRestingBlockIds.includes("traits") ? providerTraitsMenuContent : undefined
            }
            contextualControl={
              hiddenRestingBlockIds.includes("contextual")
                ? contextualControl(composerControlsCollapsed ? "xs" : "sm")
                : null
            }
            // Permissions join the overflow only when their normal home is in it.
            showPermissions={overflowShowsPermissions && runtimeModeAllowed}
            onToggleInteractionMode={toggleInteractionMode}
            onRuntimeModeChange={handleRuntimeModeChange}
          />
        </div>
      </>
    </>
  );
}

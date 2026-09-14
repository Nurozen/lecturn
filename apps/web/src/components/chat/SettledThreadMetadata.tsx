import type {
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  ServerProvider,
} from "@lecturn/contracts";
import { getProviderOptionCurrentLabel, getProviderOptionDescriptors } from "@lecturn/shared/model";
import {
  BrainCircuitIcon,
  CircleGaugeIcon,
  ListChecksIcon,
  LockIcon,
  LockOpenIcon,
  PenLineIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { getTriggerDisplayModelName } from "./providerIconUtils";

function MetadataItem(props: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            aria-label={props.label}
            className="inline-flex min-w-0 items-center gap-1.5 rounded outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

const ACCESS = {
  "approval-required": { label: "Supervised", Icon: LockIcon },
  "auto-accept-edits": { label: "Auto-accept edits", Icon: PenLineIcon },
  auto: { label: "Auto", Icon: SparklesIcon },
  "full-access": { label: "Full access", Icon: LockOpenIcon },
} satisfies Record<RuntimeMode, { label: string; Icon: typeof LockIcon }>;

const readableOption = (value: string | boolean) =>
  typeof value === "boolean"
    ? value
      ? "On"
      : "Off"
    : value
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .replace(/^\w/, (letter) => letter.toUpperCase());

/** Read-only settings retained below a settled conversation's Unsettle action. */
export function SettledThreadMetadata(props: {
  modelSelection: ModelSelection;
  providerStatuses: readonly ServerProvider[];
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  contextWindowLabel?: string | null;
}) {
  const provider = props.providerStatuses.find(
    (entry) => entry.instanceId === props.modelSelection.instanceId,
  );
  const model = provider?.models.find(
    (entry) =>
      entry.slug === props.modelSelection.model ||
      entry.aliases?.includes(props.modelSelection.model),
  );
  const modelLabel = model ? getTriggerDisplayModelName(model) : props.modelSelection.model;
  const descriptors = getProviderOptionDescriptors({
    caps: model?.capabilities ?? { optionDescriptors: [] },
    selections: props.modelSelection.options,
  });
  const optionLabels = descriptors.flatMap((descriptor) => {
    const saved = props.modelSelection.options?.find((option) => option.id === descriptor.id);
    // Preserve a saved value even if the provider's current catalog has removed it.
    const knownValue =
      descriptor.type !== "select" ||
      saved === undefined ||
      descriptor.options.some((option) => option.id === saved.value);
    const label = knownValue
      ? getProviderOptionCurrentLabel(descriptor)
      : readableOption(saved.value);
    return label ? [{ id: descriptor.id, label, title: `${descriptor.label}: ${label}` }] : [];
  });
  for (const option of props.modelSelection.options ?? []) {
    if (descriptors.some((descriptor) => descriptor.id === option.id)) continue;
    const label = readableOption(option.value);
    optionLabels.push({ id: option.id, label, title: `${readableOption(option.id)}: ${label}` });
  }
  const access = ACCESS[props.runtimeMode];
  const AccessIcon = access.Icon;
  return (
    <div
      aria-label="Thread settings"
      className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 px-3 pb-3 text-xs text-muted-foreground"
    >
      <MetadataItem
        label={`${modelLabel} · ${provider?.displayName ?? props.modelSelection.instanceId}`}
      >
        {provider ? (
          <ProviderInstanceIcon
            driverKind={provider.driver}
            displayName={provider.displayName ?? provider.instanceId}
            accentColor={provider.accentColor}
            iconClassName="size-3.5"
          />
        ) : null}
        <span className="max-w-64 truncate">{modelLabel}</span>
      </MetadataItem>
      {optionLabels.map((option) => {
        const Icon = /effort|reason|thinking/i.test(option.id)
          ? BrainCircuitIcon
          : SlidersHorizontalIcon;
        return (
          <MetadataItem key={option.id} label={option.title}>
            <Icon aria-hidden className="size-3.5" />
            {option.label}
          </MetadataItem>
        );
      })}
      {props.contextWindowLabel ? (
        <MetadataItem label={`Context window: ${props.contextWindowLabel}`}>
          <CircleGaugeIcon aria-hidden className="size-3.5" />
          {props.contextWindowLabel}
        </MetadataItem>
      ) : null}
      <MetadataItem label={`Access mode: ${access.label}`}>
        <AccessIcon aria-hidden className="size-3.5" />
        {access.label}
      </MetadataItem>
      {props.interactionMode === "plan" ? (
        <span className="inline-flex items-center gap-1.5">
          <ListChecksIcon aria-hidden className="size-3.5" />
          Plan mode
        </span>
      ) : null}
    </div>
  );
}

import { Button } from "../../components/ui/Button";
import type {
  ProviderApprovalDecision,
  ProviderApprovalOption,
  RuntimeRequestId,
} from "@lecturn/contracts";
import {
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
} from "@lecturn/client-runtime/state/thread-requests";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { GlassCard } from "../../components/GlassCard";
import { AppText as Text } from "../../components/ui/AppText";
import type { PendingApproval } from "../../lib/threadActivity";
import { pendingApprovalCardText } from "./pendingApprovalCardText";

export interface PendingApprovalCardProps {
  readonly canOperateThread: boolean;
  readonly approval: PendingApproval;
  readonly respondingApprovalId: RuntimeRequestId | null;
  readonly onRespond: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

const DEFAULT_APPROVAL_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "accept", label: "Allow once" },
  { decision: "acceptForSession", label: "Allow session" },
  { decision: "decline", label: "Decline" },
];

export function PendingApprovalCard(props: PendingApprovalCardProps) {
  const canRespond = props.approval.responseCapability === "live";
  const disabled = !canRespond || props.respondingApprovalId === props.approval.requestId;
  const { eyebrow, title, detail, detailMaxLines } = pendingApprovalCardText(props.approval);
  const [explanationOpen, setExplanationOpen] = useState(false);
  return (
    <GlassCard tone="accent" radius={24} className="gap-2.5 p-4" opaque>
      <Text className="font-lecturn-medium text-xs text-primary">{eyebrow}</Text>
      <Text className="font-lecturn-bold text-lg text-foreground">{title}</Text>
      {detail ? (
        <Text
          className="font-sans text-sm leading-normal text-foreground-secondary"
          numberOfLines={detailMaxLines}
        >
          {detail}
        </Text>
      ) : null}
      {props.approval.reason ? (
        <Text className="font-sans text-xs leading-normal text-warning-foreground">
          {props.approval.reason}
        </Text>
      ) : null}
      {props.approval.fullAccessOverride ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: explanationOpen }}
          onPress={() => setExplanationOpen((open) => !open)}
        >
          <Text className="font-lecturn-bold text-xs text-foreground-secondary underline">
            {FULL_ACCESS_OVERRIDE_QUESTION}
          </Text>
          {explanationOpen ? (
            <Text className="mt-1 font-sans text-xs leading-normal text-foreground-muted">
              {fullAccessOverrideExplanation(props.approval.fullAccessOverride)}
            </Text>
          ) : null}
        </Pressable>
      ) : null}
      {!canRespond ? (
        <Text className="font-sans text-sm leading-5 text-foreground-muted">
          The provider process for this request is no longer available. Interrupt or restart the run
          to continue.
        </Text>
      ) : null}
      <PendingApprovalOptions
        options={props.approval.options}
        disabled={disabled || !props.canOperateThread}
        onRespond={(decision) => void props.onRespond(props.approval.requestId, decision)}
      />
      {!props.canOperateThread ? (
        <Text className="font-sans text-xs text-foreground-muted">
          This connection cannot respond to approvals.
        </Text>
      ) : null}
    </GlassCard>
  );
}

// Lecturn: prop-driven so a Squire question card answers with exactly the thread's options.
export function PendingApprovalOptions(props: {
  readonly options: ReadonlyArray<ProviderApprovalOption> | undefined;
  readonly disabled: boolean;
  readonly onRespond: (decision: ProviderApprovalDecision) => void;
}) {
  const options = props.options ?? DEFAULT_APPROVAL_OPTIONS;
  const warning = options.find((option) => option.warning)?.warning;
  return (
    <>
      {warning ? (
        <Text className="font-sans text-xs leading-normal text-warning-foreground">{warning}</Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2.5">
        {options.map((option) => (
          <Button
            key={option.decision}
            label={option.label}
            tone={
              option.decision === "accept"
                ? "primary"
                : option.decision === "decline"
                  ? "danger"
                  : "secondary"
            }
            disabled={props.disabled}
            onPress={() => props.onRespond(option.decision)}
          />
        ))}
      </View>
    </>
  );
}

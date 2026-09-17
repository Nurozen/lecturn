import type {
  ApprovalRequestId,
  ProviderApprovalDecision,
  ProviderApprovalOption,
} from "@lecturn/contracts";
import { Pressable, View } from "react-native";

import { GlassCard } from "../../components/GlassCard";
import { AppText as Text } from "../../components/AppText";
import type { PendingApproval } from "../../lib/threadActivity";

export interface PendingApprovalCardProps {
  readonly approval: PendingApproval;
  readonly respondingApprovalId: ApprovalRequestId | null;
  readonly onRespond: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

const DEFAULT_APPROVAL_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "accept", label: "Allow once" },
  { decision: "acceptForSession", label: "Allow session" },
  { decision: "decline", label: "Decline" },
];

export function PendingApprovalCard(props: PendingApprovalCardProps) {
  const options: ReadonlyArray<ProviderApprovalOption> =
    props.approval.options ?? DEFAULT_APPROVAL_OPTIONS;
  const warning = options.find((option) => option.warning)?.warning;
  // Opaque for the same reason as PendingUserInputCard: nothing blurs the feed
  // behind this card, so a translucent surface bleeds messages through it.
  return (
    <GlassCard tone="accent" radius={24} className="gap-2.5 p-4" opaque>
      <Text className="font-lecturn-medium text-xs text-primary">Approval needed</Text>
      <Text className="font-lecturn-bold text-lg text-adaptive-neutral-950-50">
        {props.approval.appName ?? props.approval.requestKind}
      </Text>
      {props.approval.detail ? (
        <Text className="font-sans text-sm leading-normal text-adaptive-neutral-600-400">
          {props.approval.detail}
        </Text>
      ) : null}
      {warning ? (
        <Text className="font-sans text-xs leading-normal text-adaptive-amber-700-300">
          {warning}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2.5">
        {options.map((option) => (
          <Pressable
            key={option.decision}
            className={`items-center justify-center rounded-[14px] px-3.5 py-3 ${
              option.decision === "accept"
                ? "bg-primary"
                : option.decision === "decline"
                  ? "bg-adaptive-rose-100-500-a18"
                  : "bg-adaptive-neutral-200-800"
            }`}
            accessibilityRole="button"
            accessibilityState={{
              disabled: props.respondingApprovalId === props.approval.requestId,
            }}
            disabled={props.respondingApprovalId === props.approval.requestId}
            onPress={() => void props.onRespond(props.approval.requestId, option.decision)}
          >
            <Text
              className={`text-sm ${
                option.decision === "accept"
                  ? "font-lecturn-bold text-primary-foreground"
                  : option.decision === "decline"
                    ? "font-lecturn-bold text-adaptive-rose-700-300"
                    : "font-lecturn-bold text-adaptive-neutral-950-50"
              }`}
            >
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </GlassCard>
  );
}

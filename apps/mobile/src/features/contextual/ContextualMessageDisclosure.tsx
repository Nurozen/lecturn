import {
  contextualTranscriptOutcome,
  contextualDisclosurePreview,
} from "@lecturn/client-runtime/state/contextual";
import { GlassCard } from "../../components/GlassCard";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type NavigationProp } from "@react-navigation/native";
import type { EnvironmentId, MessageId, ThreadId } from "@lecturn/contracts";
import { Pressable } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { contextualEnvironment } from "../../state/contextual";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";

export function ContextualMessageDisclosure({
  environmentId,
  threadId,
  messageId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  messageId: MessageId;
}) {
  const navigation =
    useNavigation<
      NavigationProp<{ Contextual: { environmentId: string; threadId: string; messageId: string } }>
    >();
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const supported = config?.environment.capabilities.contextual === true;
  const disclosures = useEnvironmentQuery(
    supported
      ? contextualEnvironment.disclosures({
          environmentId,
          input: { threadId, messageId, limit: 1 },
        })
      : null,
  );
  const status = useEnvironmentQuery(
    supported ? contextualEnvironment.status({ environmentId, input: { threadId } }) : null,
  );
  const preparation = disclosures.data?.preparation ?? status.data?.preparation;
  const outcome =
    preparation?.task.messageId === messageId ? contextualTranscriptOutcome(preparation) : null;
  const item = disclosures.data?.items[0];
  if (!item && !outcome) return null;
  return (
    <GlassCard
      tone="accent"
      radius={18}
      className="mt-2 self-start max-w-[90%] px-4 py-3 gap-2"
      accessibilityLabel="Contextual message"
    >
      <Text className="text-xs font-lecturn-bold text-primary">Contextual</Text>
      {outcome ? <Text className="text-sm text-muted-foreground">{outcome}</Text> : null}
      {item ? (
        <Text className="text-sm text-foreground">
          {item.retention !== "available"
            ? `Context ${item.retention}`
            : item.receipt.acceptance === "accepted" && item.receipt.evidenceIncluded
              ? "Context added to this message"
              : item.receipt.disposition === "skipped"
                ? "No context was added"
                : item.receipt.acceptance === "unknown"
                  ? "Context delivery could not be confirmed"
                  : "Context was not delivered"}
        </Text>
      ) : null}
      {item && contextualDisclosurePreview(item) ? (
        <Text className="text-sm leading-relaxed text-foreground">
          {contextualDisclosurePreview(item)}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Inspect Contextual for this message"
        className="min-h-11 justify-center"
        onPress={() => navigation.navigate("Contextual", { environmentId, threadId, messageId })}
      >
        <Text className="text-sm text-primary">
          {item ? "View original sources" : "Review Contextual settings"}
        </Text>
      </Pressable>
    </GlassCard>
  );
}

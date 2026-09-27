import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type NavigationProp } from "@react-navigation/native";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@lecturn/contracts";
import { contextualStateLabel } from "@lecturn/client-runtime/state/contextual";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { ThemedSwitch } from "../../components/ThemedSwitch";
import { contextualEnvironment as contextual } from "../../state/contextual";
import { serverEnvironment } from "../../state/server";
import { environmentSession } from "../../state/session";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

export function ContextualButton({
  label,
  onPress,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className="min-h-11 justify-center rounded-lg border border-border px-3 py-2 disabled:opacity-40"
    >
      <Text className="text-foreground">{label}</Text>
    </Pressable>
  );
}

/** This control commits independently of the model picker's pending selection. */
export function ContextualThreadControl({
  environmentId,
  threadId,
  compact = false,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  compact?: boolean;
}) {
  const navigation =
    useNavigation<NavigationProp<{ Contextual: { environmentId: string; threadId: string } }>>();
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const supported = config?.environment.capabilities.contextual === true;
  const access = useEnvironmentQuery(environmentSession.sessionStateAtom(environmentId));
  const status = useEnvironmentQuery(
    supported ? contextual.status({ environmentId, input: { threadId } }) : null,
  );
  const update = useAtomCommand(contextual.updateThreadSettings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canOperate = access.data?.scopes?.includes(AuthOrchestrationOperateScope) === true;
  if (!supported) return null;
  const state = status.data;
  return (
    <View className={compact ? "flex-row items-center gap-2" : "gap-2 p-4"}>
      <ThemedSwitch
        accessibilityLabel="Contextual"
        value={state?.thread.enabled ?? false}
        disabled={busy || !state || !canOperate}
        onValueChange={async (enabled) => {
          if (!state || busy) return;
          setBusy(true);
          setError(null);
          try {
            const result = await update({
              environmentId,
              input: {
                threadId,
                expectedRevision: state.thread.revision,
                enabled,
                sourceIds: state.thread.sourceIds,
              },
            });
            if (result._tag !== "Success") {
              setError("Could not change Contextual. Refresh and try again.");
              status.refresh();
            }
          } finally {
            setBusy(false);
          }
        }}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Contextual settings and evidence"
        className="min-h-11 justify-center"
        onPress={() => navigation.navigate("Contextual", { environmentId, threadId })}
      >
        <Text className="text-foreground">
          Contextual
          {compact ? "" : ` · ${state ? contextualStateLabel(state.effective) : "Loading"}`}
        </Text>
        {compact && state?.preparation?.state === "awaiting-conflict-review" ? (
          <Text className="text-destructive">Review conflict</Text>
        ) : null}
        {!compact && state ? (
          <Text className="text-muted-foreground">Sources on {state.hostName}</Text>
        ) : null}
      </Pressable>
      {error ? (
        <Text accessibilityRole="alert" className="text-destructive">
          {error}
        </Text>
      ) : null}
      {!compact && !canOperate ? (
        <Text className="text-muted-foreground">
          This connection has read-only access. Ask the host administrator to enable thread
          controls.
        </Text>
      ) : null}
    </View>
  );
}

/** A held turn remains visible even while the keyboard and composer toolbar are closed. */
export function ContextualPreparationNotice({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const navigation =
    useNavigation<NavigationProp<{ Contextual: { environmentId: string; threadId: string } }>>();
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const supported = config?.environment.capabilities.contextual === true;
  const status = useEnvironmentQuery(
    supported ? contextual.status({ environmentId, input: { threadId } }) : null,
  );
  const preparation = status.data?.preparation;
  if (
    !preparation ||
    ![
      "requested",
      "retrieving",
      "evaluating",
      "checking-conflicts",
      "awaiting-conflict-review",
    ].includes(preparation.state)
  )
    return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLiveRegion="polite"
      accessibilityLabel={
        preparation.state === "awaiting-conflict-review"
          ? "Turn waiting for your conflict review"
          : "Contextual is preparing this turn. Inspect, skip context or cancel."
      }
      onPress={() => navigation.navigate("Contextual", { environmentId, threadId })}
      className="mx-3 mb-2 rounded-xl border border-border bg-screen p-3"
    >
      <Text className="font-lecturn-medium text-foreground">
        {preparation.state === "awaiting-conflict-review"
          ? "Turn waiting for your conflict review"
          : "Preparing Contextual evidence"}
      </Text>
      <Text className="text-sm text-muted-foreground">
        {preparation.state === "awaiting-conflict-review"
          ? "Choose which guidance applies, skip context, or cancel the turn."
          : "Inspect progress, send without context, or cancel the turn."}
      </Text>
    </Pressable>
  );
}

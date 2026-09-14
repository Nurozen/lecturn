import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type PullRequestRef,
  type ThreadId,
} from "@lecturn/contracts";
import { useNavigation } from "@react-navigation/native";
import * as Cause from "effect/Cause";
import { useRef, useState } from "react";
import { Alert, Pressable } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { uuidv4 } from "../../lib/uuid";
import { pullRequestWatchEnvironment } from "../../state/pull-request-watch";
import { useEnvironmentQuery } from "../../state/query";
import { environmentSession } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRemoteEnvironmentRuntime } from "../../state/use-remote-environment-registry";

export function WatchPullRequestButton(props: {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly threadId?: ThreadId;
}) {
  const navigation = useNavigation();
  const runtime = useRemoteEnvironmentRuntime(props.environmentId);
  const access = useEnvironmentQuery(environmentSession.sessionStateAtom(props.environmentId));
  const canOperate =
    runtime?.connectionState === "connected" &&
    access.data?.authenticated === true &&
    access.data.scopes?.includes(AuthOrchestrationOperateScope) === true;
  const track = useAtomCommand(pullRequestWatchEnvironment.track, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const onPress = async () => {
    if (!canOperate || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await track({
        environmentId: props.environmentId,
        input: {
          requestId: uuidv4(),
          reference: props.reference,
          ...(props.threadId ? { threadId: props.threadId } : {}),
        },
      });
      if (result._tag === "Success")
        navigation.navigate("PullRequestWatch", {
          environmentId: props.environmentId,
          watchId: result.value.id,
        });
      else {
        const failure = Cause.squash(result.cause);
        Alert.alert(
          "Could not watch pull request",
          failure instanceof Error ? failure.message : "The request failed.",
        );
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return (
    <Pressable
      accessibilityRole="button"
      disabled={!canOperate || busy}
      onPress={() => {
        void onPress();
      }}
      className="min-h-11 justify-center px-3 disabled:opacity-40"
    >
      <Text className="text-primary text-sm">{busy ? "Opening watch…" : "Watch pull request"}</Text>
    </Pressable>
  );
}

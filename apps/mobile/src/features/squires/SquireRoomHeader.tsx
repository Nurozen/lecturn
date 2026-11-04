import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  SquireId,
  SquireRoom,
  SquireRoomRow,
  SquireRoomUpdateInput,
} from "@lecturn/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { uuidv4 } from "../../lib/uuid";
import { squireEnvironment } from "../../state/squire";
import { useAtomCommand } from "../../state/use-atom-command";
import { RequestActionButton } from "../threads/RequestActionButton";
import { SquireRoomPortraits } from "./SquireRoomPortraits";
import { squireRoomPortraits, squireRoomStatusLine } from "./squireRooms.logic";

const PORTRAIT_SIZE = 36;

type RoomPatch = Pick<typeof SquireRoomUpdateInput.Type, "muted" | "botMessaging">;

/** A room's header: topic, members, status, then bot messaging, mute, and close or reopen. */
export function SquireRoomHeader(props: {
  readonly environmentId: EnvironmentId;
  readonly row: SquireRoomRow;
  /** The full record, whose revision every edit needs; null until the log loads. */
  readonly room: SquireRoom | null;
  readonly nameOf: (squireId: SquireId) => string;
  readonly leadName: string | null;
}) {
  const { environmentId, row, room } = props;
  const canUpdate = useAtomValue(squireEnvironment.roomUpdate.permissionAtom(environmentId));
  const canClose = useAtomValue(squireEnvironment.roomClose.permissionAtom(environmentId));
  const canReopen = useAtomValue(squireEnvironment.roomReopen.permissionAtom(environmentId));
  const update = useAtomCommand(squireEnvironment.roomUpdate, { reportFailure: false });
  const close = useAtomCommand(squireEnvironment.roomClose, { reportFailure: false });
  const reopen = useAtomCommand(squireEnvironment.roomReopen, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closed = row.status === "closed";
  const editable = canUpdate && room !== null && !pending;
  const canToggleOpen = closed ? canReopen : canClose;
  const { portraits, overflow } = squireRoomPortraits(row.members);

  const run = async (action: () => Promise<{ readonly _tag: string }>) => {
    setPending(true);
    setError(null);
    const result = await action();
    setPending(false);
    if (result._tag === "Failure") setError("The room could not be updated. Try again.");
  };

  const patch = (change: RoomPatch) => {
    if (room === null) return;
    void run(() =>
      update({
        environmentId,
        input: {
          requestId: uuidv4(),
          roomId: row.id,
          expectedRevision: room.revision,
          ...change,
        },
      }),
    );
  };

  const toggleOpen = () => {
    const input = { requestId: uuidv4(), roomId: row.id };
    void run(() => (closed ? reopen({ environmentId, input }) : close({ environmentId, input })));
  };

  return (
    <View className="gap-3 border-b border-border-subtle pb-4">
      <View className="flex-row items-center gap-3">
        <SquireRoomPortraits
          environmentId={environmentId}
          portraits={portraits}
          overflow={overflow}
          size={PORTRAIT_SIZE}
        />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="font-lecturn-bold text-lg text-foreground" numberOfLines={2}>
            {row.topic}
          </Text>
          <Text className="font-sans text-xs text-foreground-muted" numberOfLines={2}>
            {squireRoomStatusLine({
              row,
              room,
              nameOf: props.nameOf,
              leadName: props.leadName,
            })}
          </Text>
        </View>
      </View>
      {canUpdate ? (
        <View className="flex-row items-center justify-between gap-3">
          <View className="min-w-0 flex-1">
            <Text className="font-lecturn-medium text-sm text-foreground">Bot messaging</Text>
            <Text className="font-sans text-xs text-foreground-muted">
              Squires' posts can wake other Squires.
            </Text>
          </View>
          <ThemedSwitch
            accessibilityLabel="Bot messaging"
            disabled={!editable || closed}
            value={room?.botMessaging ?? true}
            onValueChange={(botMessaging) => patch({ botMessaging })}
          />
        </View>
      ) : null}
      {canUpdate || canToggleOpen ? (
        <View className="flex-row flex-wrap gap-2">
          {canUpdate ? (
            <RequestActionButton
              label={row.muted ? "Unmute" : "Mute"}
              tone="secondary"
              disabled={!editable}
              accessibilityHint="A muted room shows no unread dot"
              onPress={() => patch({ muted: !row.muted })}
            />
          ) : null}
          {canToggleOpen ? (
            <RequestActionButton
              label={closed ? "Reopen" : "Close room"}
              tone="secondary"
              disabled={pending}
              onPress={toggleOpen}
            />
          ) : null}
        </View>
      ) : null}
      {error === null ? null : (
        <Text accessibilityRole="alert" className="font-sans text-sm text-danger-foreground">
          {error}
        </Text>
      )}
    </View>
  );
}

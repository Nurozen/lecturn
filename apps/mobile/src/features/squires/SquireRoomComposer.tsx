import { useAtomValue } from "@effect/atom-react";
import {
  SQUIRE_MESSAGE_MAX_CHARS,
  type EnvironmentId,
  type SquireId,
  type SquireRoomId,
} from "@lecturn/contracts";
import { useRef, useState } from "react";
import { Pressable, View, type TextInputInstance } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { uuidv4 } from "../../lib/uuid";
import { squireEnvironment } from "../../state/squire";
import { useAtomCommand } from "../../state/use-atom-command";
import { RequestActionButton } from "../threads/RequestActionButton";
import { squireRoomCompletion, squireRoomComposerPlaceholder } from "./squireRooms.logic";

interface Named {
  readonly squireId: SquireId;
  readonly name: string;
}

/** P19.8 composer: `@` suggests the room's members and the Lead; the request id is the message key. */
export function SquireRoomComposer(props: {
  readonly environmentId: EnvironmentId;
  readonly roomId: SquireRoomId;
  readonly members: ReadonlyArray<Named>;
  readonly lead: Named | null;
  readonly closed: boolean;
  readonly onSent: () => void;
}) {
  const { environmentId, roomId } = props;
  const insets = useSafeAreaInsets();
  const canPost = useAtomValue(squireEnvironment.roomPost.permissionAtom(environmentId));
  const post = useAtomCommand(squireEnvironment.roomPost, { reportFailure: false });
  const inputRef = useRef<TextInputInstance>(null);
  const [text, setText] = useState("");
  const [cursor, setCursor] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = props.closed || !canPost;
  const completion = disabled
    ? null
    : squireRoomCompletion(text, cursor, props.members, props.lead);

  const choose = (name: string) => {
    if (completion === null) return;
    const next = completion.insert(name);
    setText(next.text);
    setCursor(next.cursor);
    // After the new value commits, so the caret lands after the inserted name.
    requestAnimationFrame(() => inputRef.current?.setSelection(next.cursor, next.cursor));
  };

  const send = async () => {
    const body = text.trim();
    if (body === "" || sending || disabled) return;
    setSending(true);
    setError(null);
    const result = await post({
      environmentId,
      input: { requestId: uuidv4(), roomId, body },
    });
    setSending(false);
    if (result._tag === "Failure") {
      setError("The post could not be sent. Try again.");
      return;
    }
    setText("");
    setCursor(0);
    props.onSent();
  };

  return (
    <View
      className="gap-2 border-t border-border-subtle bg-screen px-3 pt-2"
      style={{ paddingBottom: Math.max(insets.bottom, 10) }}
    >
      {completion === null ? null : (
        <View accessibilityLabel="Mention suggestions" className="gap-0.5">
          {completion.candidates.map((candidate) => (
            <Pressable
              key={candidate.squireId}
              accessibilityRole="button"
              accessibilityLabel={`Mention ${candidate.name}`}
              onPress={() => choose(candidate.name)}
              className="min-h-11 flex-row items-center gap-2 rounded-xl px-3 active:bg-subtle"
            >
              <Text className="min-w-0 flex-1 font-lecturn-medium text-base text-foreground">
                @{candidate.name}
              </Text>
              {candidate.isLead ? (
                <Text className="font-sans text-xs text-foreground-muted">Lead</Text>
              ) : null}
            </Pressable>
          ))}
        </View>
      )}
      {error === null ? null : (
        <Text accessibilityRole="alert" className="font-sans text-sm text-danger-foreground">
          {error}
        </Text>
      )}
      <View className="flex-row items-end gap-2">
        <AppTextInput
          ref={inputRef}
          accessibilityLabel="Post to room"
          className="max-h-36 min-w-0 flex-1"
          multiline
          value={text}
          maxLength={SQUIRE_MESSAGE_MAX_CHARS}
          editable={!disabled}
          placeholder={squireRoomComposerPlaceholder(props.closed, canPost)}
          onChangeText={setText}
          onSelectionChange={({ nativeEvent }) => setCursor(nativeEvent.selection.start)}
        />
        <RequestActionButton
          label="Send"
          disabled={disabled || sending || text.trim() === ""}
          onPress={() => void send()}
        />
      </View>
    </View>
  );
}

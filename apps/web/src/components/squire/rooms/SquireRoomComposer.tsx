import { useAtomValue } from "@effect/atom-react";
import {
  applySquireMention,
  squireMentionStep,
  squireRoomMentionState,
} from "@lecturn/client-runtime/state/squire";
import type { EnvironmentId, Squire, SquireId, SquireRoomId } from "@lecturn/contracts";
import { SQUIRE_MESSAGE_MAX_CHARS } from "@lecturn/contracts";
import { SendIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import { cn, randomUUID } from "../../../lib/utils";
import { squireEnvironment, useSquireEnvironmentState } from "../../../state/squires";
import { useAtomCommand } from "../../../state/use-atom-command";
import { Button } from "../../ui/button";
import { Textarea } from "../../ui/textarea";
import { toastManager } from "../../ui/toast";
import { commandFailureMessage } from "../queue/SquireEvidenceCard";
import { SquireIndicator } from "../SquireIndicator";
import { SQUIRE_MEMBER_FULL_COLOR } from "./SquireRoomPortraits";

interface Named {
  readonly squireId: SquireId;
  readonly name: string;
}

// The smallest size SquireIndicator still draws a face at (P16.4).
const MENTION_PORTRAIT_PX = 22;

/** P19.8 composer: `@` completes the room's members and the Lead; the request id is the message key. */
export function SquireRoomComposer(props: {
  readonly environmentId: EnvironmentId;
  readonly roomId: SquireRoomId;
  readonly members: ReadonlyArray<Named>;
  readonly lead: Named | null;
  readonly closed: boolean;
}) {
  const { environmentId, roomId } = props;
  const canPost = useAtomValue(squireEnvironment.roomPost.permissionAtom(environmentId));
  const squires = useSquireEnvironmentState(environmentId)?.squires;
  const post = useAtomCommand(squireEnvironment.roomPost, { reportFailure: false });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Setting a controlled value moves the caret to the end. The picked mention's caret is restored
  // in the same commit, before the next keystroke can land at the end (a frame later is too late).
  const pendingCaret = useRef<number | null>(null);
  const [text, setText] = useState("");
  const [cursor, setCursor] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const disabled = props.closed || !canPost;

  const completion =
    disabled || dismissedAt === cursor
      ? null
      : squireRoomMentionState(text, cursor, props.members, props.lead);
  const active = completion === null ? 0 : Math.min(highlight, completion.candidates.length - 1);

  const track = (element: HTMLTextAreaElement) => {
    setText(element.value);
    setCursor(element.selectionStart);
  };

  const choose = (name: string) => {
    if (completion === null) return;
    const next = applySquireMention(text, completion.mention, name);
    setText(next.text);
    setCursor(next.cursor);
    setHighlight(0);
    pendingCaret.current = next.cursor;
  };

  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    const element = textareaRef.current;
    if (caret === null || element === null) return;
    pendingCaret.current = null;
    element.focus();
    element.setSelectionRange(caret, caret);
  });

  const send = async () => {
    const body = text.trim();
    if (body === "" || sending || disabled) return;
    setSending(true);
    const result = await post({
      environmentId,
      input: { requestId: randomUUID(), roomId, body },
    });
    setSending(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: commandFailureMessage(result, "The post could not be sent. Try again."),
      });
      return;
    }
    setText("");
    setCursor(0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (completion !== null) {
      const count = completion.candidates.length;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setHighlight(squireMentionStep(active, count, event.key === "ArrowDown" ? 1 : -1));
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        choose(completion.candidates[active]!.name);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedAt(cursor);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div className="relative shrink-0 border-t px-4 pt-3 pb-4">
      {completion === null ? null : (
        <ul
          id="squire-room-mentions"
          role="listbox"
          aria-label="Mention"
          className="absolute inset-x-4 bottom-full mb-1 flex flex-col gap-0.5 rounded-lg border bg-popover p-1 text-sm shadow-md"
        >
          {completion.candidates.map((candidate, index) => (
            <li
              key={candidate.squireId}
              id={`squire-room-mention-${candidate.squireId}`}
              role="option"
              aria-selected={index === active}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1",
                index === active && "bg-accent text-accent-foreground",
              )}
              // Keeps focus in the textarea, so the caret survives the click.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(candidate.name)}
            >
              <MentionPortrait
                squire={squires?.find((entry) => entry.squire.id === candidate.squireId)?.squire}
                isLead={candidate.isLead}
              />
              <span className="min-w-0 flex-1 truncate">{candidate.name}</span>
              {candidate.isLead ? (
                <span className="text-xs text-muted-foreground">Lead</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-end gap-2">
        <Textarea
          ref={textareaRef}
          size="sm"
          value={text}
          maxLength={SQUIRE_MESSAGE_MAX_CHARS}
          disabled={disabled}
          aria-label="Post to room"
          aria-autocomplete="list"
          aria-controls={completion === null ? undefined : "squire-room-mentions"}
          aria-activedescendant={
            completion === null
              ? undefined
              : `squire-room-mention-${completion.candidates[active]!.squireId}`
          }
          placeholder={
            props.closed
              ? "This room is closed. Reopen it to post."
              : !canPost
                ? "You can read this room but not post in it."
                : "Post to the room. @ to mention a Squire."
          }
          onChange={(event) => {
            setDismissedAt(null);
            track(event.currentTarget);
          }}
          onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
        />
        <Button
          size="icon"
          aria-label="Send"
          disabled={disabled || sending || text.trim() === ""}
          onClick={() => void send()}
        >
          <SendIcon />
        </Button>
      </div>
    </div>
  );
}

/**
 * A still identity portrait: the picker says who, not what they are doing, so it never animates
 * and reads at full color (as room member portraits do).
 */
function MentionPortrait(props: {
  readonly squire: Pick<Squire, "name" | "companion"> | undefined;
  readonly isLead: boolean;
}) {
  const { squire } = props;
  if (squire === undefined) return <span aria-hidden className="size-5.5 shrink-0" />;
  return (
    <span aria-hidden className={cn("flex shrink-0", SQUIRE_MEMBER_FULL_COLOR)}>
      <SquireIndicator
        state="idle"
        palette={squire.companion.palette}
        presence={squire.companion.presence}
        appearance={squire.companion.appearance}
        hood={squire.companion.hood}
        isLead={props.isLead}
        size={MENTION_PORTRAIT_PX}
        label={squire.name}
      />
    </span>
  );
}

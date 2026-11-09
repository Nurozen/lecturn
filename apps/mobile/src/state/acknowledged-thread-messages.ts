import * as Option from "effect/Option";
import type { Atom } from "effect/reactivity";
import { acknowledgedThreadMessagesAtom } from "./acknowledged-thread-messages-atom";
import { appAtomRegistry } from "./atom-registry";
import { threadHasCaughtUpTo } from "@lecturn/client-runtime/state/threads";
import type { AcknowledgedThreadMessage, QueuedThreadMessage } from "./thread-outbox-model";
import { environmentThreadDetails } from "./threads";

// Peeks at a thread only when something already has it in the registry: reading
// it through the registry would open a snapshot load and a live stream of its own.
function isEchoedInMountedThread(message: AcknowledgedThreadMessage): boolean {
  const stateAtom = environmentThreadDetails.stateAtom({
    environmentId: message.environmentId,
    threadId: message.threadId,
  });
  const node = appAtomRegistry.getNodes().get(stateAtom);
  if (node === undefined) return false;
  const loaded: Option.Option<Atom.Type<typeof stateAtom>> = node.valueOption();
  return Option.match(loaded, {
    onNone: () => false,
    onSome: (thread) =>
      threadHasCaughtUpTo(message, {
        sequence: thread.sequence,
        messages: Option.getOrUndefined(thread.data)?.messages,
      }),
  });
}

// Render hides rows the projection has echoed, so dropping them here only frees memory.
function writeAcknowledgedThreadMessages(
  update: (
    current: ReadonlyArray<AcknowledgedThreadMessage>,
  ) => ReadonlyArray<AcknowledgedThreadMessage>,
) {
  const current = appAtomRegistry.get(acknowledgedThreadMessagesAtom);
  const next = update(current).filter((entry) => !isEchoedInMountedThread(entry));
  if (next.length === current.length && next.every((entry, index) => entry === current[index])) {
    return;
  }
  appAtomRegistry.set(acknowledgedThreadMessagesAtom, next);
}

export function retainAcknowledgedThreadMessage(message: AcknowledgedThreadMessage) {
  writeAcknowledgedThreadMessages((current) =>
    current.some((entry) => entry.messageId === message.messageId)
      ? current
      : [...current, message],
  );
}

export function forgetAcknowledgedThreadMessage(message: QueuedThreadMessage) {
  writeAcknowledgedThreadMessages((current) =>
    current.filter((entry) => entry.messageId !== message.messageId),
  );
}

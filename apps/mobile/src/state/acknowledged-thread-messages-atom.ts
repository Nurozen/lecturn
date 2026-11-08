import { Atom } from "effect/reactivity";
import type { QueuedThreadMessage } from "./thread-outbox-model";

// Keep acknowledged rows until their subscribed projection arrives; command receipts can precede messages.
// A leaf module: outbox removal clears it without importing the thread stores (import cycle).
export const acknowledgedThreadMessagesAtom = Atom.make<ReadonlyArray<QueuedThreadMessage>>(
  [],
).pipe(Atom.keepAlive);

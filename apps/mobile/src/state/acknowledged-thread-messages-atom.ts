import { Atom } from "effect/reactivity";
import type { AcknowledgedThreadMessage } from "./thread-outbox-model";

// Keep acknowledged rows until the thread catches up; command receipts can precede messages.
// A leaf module: outbox removal clears it without importing the thread stores (import cycle).
export const acknowledgedThreadMessagesAtom = Atom.make<ReadonlyArray<AcknowledgedThreadMessage>>(
  [],
).pipe(Atom.keepAlive);

import type { SupervisorConnectionState } from "@lecturn/client-runtime/connection";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";

/** Re-read link ownership once the host is ready, never on intermediate retry states. */
export function connectedGenerationSignal(
  state: Atom.Atom<SupervisorConnectionState | undefined>,
): Atom.Atom<number> {
  return Atom.make((get) => {
    const current = get(state);
    const previous = Option.getOrElse(get.self<number>(), () => -1);
    return current?.phase === "connected" ? current.generation : previous;
  });
}

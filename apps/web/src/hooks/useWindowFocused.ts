import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

export const windowFocusedAtom = Atom.make((get) => {
  const sync = () => get.setSelf(document.hasFocus());
  window.addEventListener("focus", sync);
  window.addEventListener("blur", sync);
  get.addFinalizer(() => {
    window.removeEventListener("focus", sync);
    window.removeEventListener("blur", sync);
  });
  return document.hasFocus();
}).pipe(Atom.withLabel("window-focused"));

export function useWindowFocused(): boolean {
  return useAtomValue(windowFocusedAtom);
}

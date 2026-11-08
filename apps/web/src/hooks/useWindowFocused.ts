import { useSyncExternalStore } from "react";

const subscribe = (onChange: () => void) => {
  window.addEventListener("focus", onChange);
  window.addEventListener("blur", onChange);
  return () => {
    window.removeEventListener("focus", onChange);
    window.removeEventListener("blur", onChange);
  };
};
const read = () => document.hasFocus();

export function useWindowFocused(): boolean {
  return useSyncExternalStore(subscribe, read, () => true);
}

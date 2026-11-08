import { createContext, use } from "react";
import type { ChatComposerHandle } from "./components/chat/ChatComposer";

export type ComposerHandleRef = React.RefObject<ChatComposerHandle | null>;

export const ComposerHandleContext = createContext<ComposerHandleRef | null>(null);

/** The app shell's composer (CommandPalette provides it); event-time commands such as Cmd+N focus it. */
export const appComposerHandleRef: ComposerHandleRef = { current: null };

export function useComposerHandleContext(): ComposerHandleRef | null {
  return use(ComposerHandleContext);
}

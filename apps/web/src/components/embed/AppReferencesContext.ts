import { createContext, use } from "react";

/** How a thread's app references look and what activating one does. */
export interface AppReferences {
  readonly refPrefixes: ReadonlyArray<string>;
  readonly iconUrl: string | null;
  /** Null where nothing can open the app, such as a remote environment. */
  readonly activate: ((ref: string) => void) | null;
}

export const AppReferencesContext = createContext<AppReferences | null>(null);

export function useAppReferences(): AppReferences | null {
  return use(AppReferencesContext);
}

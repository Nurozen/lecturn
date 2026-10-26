import { createContext, use } from "react";

/** Names for references, by reference; one the app cannot name is left out. */
export type DescribeAppReferences = (
  refs: ReadonlyArray<string>,
) => Promise<Readonly<Record<string, string>>>;

/** How a thread's app references look and what activating one does. */
export interface AppReferences {
  readonly refPrefixes: ReadonlyArray<string>;
  readonly iconUrl: string | null;
  /** Null where nothing can open the app, such as a remote environment. */
  readonly activate: ((ref: string) => void) | null;
  /** The thread whose stored and described labels the chips read. */
  readonly labelScope?: string | null;
  /** Asks the app to name references no message stored a label for; only an embed's host can. */
  readonly describe?: DescribeAppReferences | null;
}

export const AppReferencesContext = createContext<AppReferences | null>(null);

export function useAppReferences(): AppReferences | null {
  return use(AppReferencesContext);
}

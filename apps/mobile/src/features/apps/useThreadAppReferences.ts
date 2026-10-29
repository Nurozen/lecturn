import { scopeProjectRef, scopeThreadRef } from "@lecturn/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@lecturn/contracts";
import { createContext, useContext, useState } from "react";

import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { useAppEmbedContext } from "../../state/apps";
import { useProject, useThreadShell } from "../../state/entities";
import { appReferenceLabelsFromFeed, sameAppReferenceLabels } from "./app-reference-chips";

const NO_PREFIXES: ReadonlyArray<string> = [];

/** The reference prefixes of the app a thread's project is bound to; none for any other thread. */
export function useThreadAppRefPrefixes(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ReadonlyArray<string> {
  const thread = useThreadShell(scopeThreadRef(environmentId, threadId));
  const projectRef = thread === null ? null : scopeProjectRef(environmentId, thread.projectId);
  const binding = useProject(projectRef)?.appBinding;
  const context = useAppEmbedContext(binding === undefined ? null : projectRef);
  return context?.refPrefixes ?? NO_PREFIXES;
}

/** The thread feed's app reference prefixes, for message text drawn below it. */
export const AppRefPrefixesContext = createContext<ReadonlyArray<string>>(NO_PREFIXES);

export function useAppRefPrefixes(): ReadonlyArray<string> {
  return useContext(AppRefPrefixesContext);
}

/**
 * Names change only when a message with chips arrives, so the map keeps its identity across
 * streamed chunks and the rows whose link handlers read it are not all redrawn.
 */
export function useAppReferenceLabels(
  feed: ReadonlyArray<ThreadFeedEntry>,
): ReadonlyMap<string, string> {
  const next = appReferenceLabelsFromFeed(feed);
  const [labels, setLabels] = useState(next);
  if (labels !== next && !sameAppReferenceLabels(labels, next)) setLabels(next);
  return labels;
}

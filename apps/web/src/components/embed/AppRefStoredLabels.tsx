import { scopeThreadRef, scopedThreadKey } from "@lecturn/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@lecturn/contracts";
import { useEffect } from "react";

import { useThreadVisibleTurnItems } from "../../state/entities";
import { storedAppRefLabels, useAppRefLabelStore } from "./appRefLabels";

/**
 * Feeds the labels the thread's messages stored to its reference chips. A leaf of its own, because
 * the items it reads change on every streamed event and must not re-render the view beside it.
 */
export function AppRefStoredLabels({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const threadRef = scopeThreadRef(environmentId, threadId);
  const scope = scopedThreadKey(threadRef);
  const items = useThreadVisibleTurnItems(threadRef);
  const remember = useAppRefLabelStore((state) => state.remember);
  useEffect(() => remember(scope, storedAppRefLabels(items)), [remember, scope, items]);
  return null;
}

export function appRefLabelScope(environmentId: EnvironmentId, threadId: ThreadId): string {
  return scopedThreadKey(scopeThreadRef(environmentId, threadId));
}

import { useAtomMount } from "@effect/atom-react";
import { scopedThreadKey } from "@lecturn/client-runtime/environment";
import { parseThreadKey, threadKey } from "@lecturn/client-runtime/state/entities";
import { createThreadVisitTracker } from "@lecturn/client-runtime/state/thread-visits";
import { type ScopedThreadRef } from "@lecturn/contracts";
import { Atom } from "effect/reactivity";

import { windowFocusedAtom } from "../../hooks/useWindowFocused";
import { useUiStateStore } from "../../uiStateStore";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";

// An open window nobody is looking at has not been read. Hiding the shell pauses
// the tracker without a remount, which would re-record the open and forget a mark-unread.
const focusedVisitShell = Atom.family((key: string) => {
  const ref = parseThreadKey(key);
  return Atom.make((get) =>
    get(windowFocusedAtom) ? get(environmentThreadShells.threadShellAtom(ref)) : null,
  ).pipe(Atom.withLabel(`web-thread-visit-shell:${key}`));
});

const threadVisitTracker = createThreadVisitTracker({
  threadShellAtom: (ref) => focusedVisitShell(threadKey(ref)),
  visit: threadEnvironment.visit,
  markLocalVisit: (ref, visitedAt) =>
    useUiStateStore.getState().markThreadVisited(scopedThreadKey(ref), visitedAt),
});

// The visit watermark is the one part of the chat view that follows the
// shell's updatedAt, which ticks while a run streams. The tracker subscribes to
// it outside React, so ChatView keeps reading the quiet shell.
export function ThreadVisitWatermark(props: { readonly threadRef: ScopedThreadRef }) {
  useAtomMount(threadVisitTracker(props.threadRef));
  return null;
}

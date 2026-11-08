import { scopedThreadKey } from "@lecturn/client-runtime/environment";
import type { AnyRouter } from "@tanstack/react-router";
import type { AtomRegistry } from "effect/reactivity";

import { useComposerDraftStore } from "../composerDraftStore";
import { createLiveRegion } from "../hooks/useLiveRegion";
import { liveShellEnvironmentIdsAtom } from "../state/shell";
import { environmentThreadShells } from "../state/threads";
import { resolveActiveThreadRouteRef, resolveThreadRouteTarget } from "../threadRoutes";
import {
  type BackgroundThreadMemory,
  backgroundThreadSnapshots,
  nextBackgroundThreadAnnouncement,
} from "./backgroundThreadAnnouncement";

const backgroundThreadLiveRegion = createLiveRegion();
const attachBackgroundThreadRegion = backgroundThreadLiveRegion.attach;

function readOpenThreadKey(router: AnyRouter): string | null {
  const target = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
  const draft =
    target?.kind === "draft"
      ? useComposerDraftStore.getState().getDraftSession(target.draftId)
      : null;
  const ref = resolveActiveThreadRouteRef(target, draft);
  return ref === null ? null : scopedThreadKey(ref);
}

/** Speaks status changes for threads other than the open one, for the life of the app. */
export function startBackgroundThreadAnnouncements(
  registry: AtomRegistry.AtomRegistry,
  router: AnyRouter,
): () => void {
  let memory: BackgroundThreadMemory = new Map();
  let openThreadKey = readOpenThreadKey(router);

  const update = () => {
    const threads = registry.get(environmentThreadShells.quietThreadShellsAtom);
    const liveEnvironmentIds = registry.get(liveShellEnvironmentIdsAtom);
    const snapshots = backgroundThreadSnapshots(
      threads,
      liveEnvironmentIds,
      registry.get(environmentThreadShells.listingCapabilitiesAtom),
      new Date().toISOString(),
    );
    const next = nextBackgroundThreadAnnouncement(memory, snapshots, openThreadKey);
    memory = next.memory;
    if (next.announcement !== null) backgroundThreadLiveRegion.announce(next.announcement);
  };

  // The draft store changes on every keystroke; only a new open thread matters here.
  const updateOpenThread = () => {
    const next = readOpenThreadKey(router);
    if (next === openThreadKey) return;
    openThreadKey = next;
    update();
  };

  const unsubscribes = [
    registry.subscribe(environmentThreadShells.quietThreadShellsAtom, update),
    registry.subscribe(liveShellEnvironmentIdsAtom, update),
    registry.subscribe(environmentThreadShells.listingCapabilitiesAtom, update),
    router.subscribe("onResolved", updateOpenThread),
    useComposerDraftStore.subscribe(updateOpenThread),
  ];
  update();
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}

/**
 * The region the background announcements are spoken through. It lives outside
 * the sidebar because a collapsed sidebar is inert, which silences its rows.
 */
export function BackgroundThreadAnnouncer() {
  // No role="status": Orca 50 maps it to a status bar in Chromium and drops its updates.
  return <div ref={attachBackgroundThreadRegion} aria-live="polite" className="sr-only" />;
}

import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@lecturn/client-runtime/environment";
import { useEffect, useRef } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { useLiveRegion } from "../hooks/useLiveRegion";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { useQuietThreadShells, useThreadListingCapabilities } from "../state/entities";
import { liveShellEnvironmentIdsAtom } from "../state/shell";
import { resolveActiveThreadRouteRef } from "../threadRoutes";
import {
  type BackgroundThreadMemory,
  backgroundThreadSnapshots,
  nextBackgroundThreadAnnouncement,
} from "./backgroundThreadAnnouncement";

/**
 * Speaks status changes for threads other than the open one. It lives outside
 * the sidebar because a collapsed sidebar is inert, which silences its rows.
 */
export function BackgroundThreadAnnouncer() {
  const threads = useQuietThreadShells();
  const liveEnvironmentIds = useAtomValue(liveShellEnvironmentIdsAtom);
  const listingCapabilities = useThreadListingCapabilities();
  const routeTarget = useThreadRouteTarget();
  const routeDraftThread = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const openThreadRef = resolveActiveThreadRouteRef(routeTarget, routeDraftThread);
  const openThreadKey = openThreadRef === null ? null : scopedThreadKey(openThreadRef);
  const { regionRef, announce } = useLiveRegion();
  const memoryRef = useRef<BackgroundThreadMemory>(new Map());

  useEffect(() => {
    const snapshots = backgroundThreadSnapshots(
      threads,
      liveEnvironmentIds,
      listingCapabilities,
      new Date().toISOString(),
    );
    const { memory, announcement } = nextBackgroundThreadAnnouncement(
      memoryRef.current,
      snapshots,
      openThreadKey,
    );
    memoryRef.current = memory;
    if (announcement !== null) announce(announcement);
  }, [threads, liveEnvironmentIds, listingCapabilities, openThreadKey, announce]);

  // No role="status": Orca 50 maps it to a status bar in Chromium and drops its updates.
  return <div ref={regionRef} aria-live="polite" className="sr-only" />;
}

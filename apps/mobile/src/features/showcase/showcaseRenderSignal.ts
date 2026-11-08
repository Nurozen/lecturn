import { useEffect, useSyncExternalStore } from "react";

import type { MobileThemeId } from "../../lib/mobileTheme";
import type { ShowcaseScene } from "./nativeShowcaseScene";

const SHOWCASE_ENABLED = process.env.EXPO_PUBLIC_SHOWCASE === "1";

// Scenes whose route can be current before their content has drawn: the thread
// feed fades in after its messages load, the terminal replays its buffer after
// the surface measures, and the review diff draws natively.
const CONTENT_SIGNALED_SCENES: ReadonlySet<ShowcaseScene> = new Set([
  "thread",
  "terminal",
  "review",
]);

/** Lecturn: the theme each mounted scene last drew in, so surfaces report independently. */
export type ShowcaseRenderSignal = ReadonlyMap<ShowcaseScene, MobileThemeId>;

type ShowcaseRenderReport = Readonly<{
  scene: ShowcaseScene;
  themeId: MobileThemeId;
}>;

const listeners = new Set<() => void>();
export type ShowcaseRenderSnapshot = Readonly<{
  signal: ShowcaseRenderSignal;
  // A redraw can repeat the same scene and theme; counting reports lets it restart the settle delay.
  reports: number;
}>;

let snapshot: ShowcaseRenderSnapshot = { signal: new Map(), reports: 0 };

function publish(signal: ShowcaseRenderSignal): void {
  snapshot = { signal, reports: snapshot.reports + 1 };
  for (const listener of listeners) listener();
}

export function getShowcaseRenderSnapshot(): ShowcaseRenderSnapshot {
  return snapshot;
}

export function getShowcaseRenderSignal(): ShowcaseRenderSignal {
  return snapshot.signal;
}

export function subscribeToShowcaseRenderSignal(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function reportShowcaseSceneRendered(report: ShowcaseRenderReport): void {
  const current = snapshot.signal;
  publish(
    current.get(report.scene) === report.themeId
      ? current
      : new Map(current).set(report.scene, report.themeId),
  );
}

export function clearShowcaseRenderSignal(): void {
  if (snapshot.signal.size === 0) return;
  publish(new Map());
}

/**
 * Reports a scene's content for as long as it stays drawn, including after a
 * new scene request clears the signal while this surface is still mounted.
 */
export function useShowcaseSceneRendered(
  scene: ShowcaseScene,
  themeId: MobileThemeId,
  rendered: boolean,
): void {
  const signal = useSyncExternalStore(
    subscribeToShowcaseRenderSignal,
    getShowcaseRenderSignal,
    getShowcaseRenderSignal,
  );
  const reported = signal.get(scene) === themeId;
  // oxlint-disable-next-line lecturn/no-unreasoned-state-sync -- publishes to the external showcase capture signal after the surface commits
  useEffect(() => {
    if (SHOWCASE_ENABLED && rendered && !reported) reportShowcaseSceneRendered({ scene, themeId });
  }, [rendered, reported, scene, themeId]);
}

export function isShowcaseNativeContentReady(input: {
  readonly scene: ShowcaseScene;
  readonly themeId: MobileThemeId;
  readonly renderSignal: ShowcaseRenderSignal | null;
}): boolean {
  if (!CONTENT_SIGNALED_SCENES.has(input.scene)) return true;
  return input.renderSignal?.get(input.scene) === input.themeId;
}

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

export type ShowcaseRenderSignal = ReadonlyMap<ShowcaseScene, MobileThemeId>;

type ShowcaseRenderReport = Readonly<{
  scene: ShowcaseScene;
  themeId: MobileThemeId;
}>;

const listeners = new Set<() => void>();
let renderSignal: ShowcaseRenderSignal = new Map();

function publish(next: ShowcaseRenderSignal): void {
  renderSignal = next;
  for (const listener of listeners) listener();
}

export function getShowcaseRenderSignal(): ShowcaseRenderSignal {
  return renderSignal;
}

export function subscribeToShowcaseRenderSignal(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function reportShowcaseSceneRendered(report: ShowcaseRenderReport): void {
  if (renderSignal.get(report.scene) === report.themeId) return;
  publish(new Map(renderSignal).set(report.scene, report.themeId));
}

export function clearShowcaseRenderSignal(): void {
  if (renderSignal.size === 0) return;
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
  useEffect(() => {
    if (SHOWCASE_ENABLED && rendered && !reported) reportShowcaseSceneRendered({ scene, themeId });
  }, [rendered, reported, scene, themeId]);
}

export function isShowcaseNativeContentReady(input: {
  readonly scene: ShowcaseScene;
  readonly themeId: MobileThemeId;
  readonly renderSignal: ShowcaseRenderSignal;
}): boolean {
  if (!CONTENT_SIGNALED_SCENES.has(input.scene)) return true;
  return input.renderSignal.get(input.scene) === input.themeId;
}

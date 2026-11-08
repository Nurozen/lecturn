import { describe, expect, it } from "vite-plus/test";

import {
  clearShowcaseRenderSignal,
  getShowcaseRenderSignal,
  isShowcaseNativeContentReady,
  reportShowcaseSceneRendered,
} from "./showcaseRenderSignal";

function ready(scene: "thread" | "terminal" | "review" | "threads", themeId: "lecturn" | "grove") {
  return isShowcaseNativeContentReady({ scene, themeId, renderSignal: getShowcaseRenderSignal() });
}

describe("showcase render signal", () => {
  it("holds thread and terminal captures until their content reports drawn", () => {
    clearShowcaseRenderSignal();
    expect(ready("thread", "lecturn")).toBe(false);
    expect(ready("terminal", "lecturn")).toBe(false);
    expect(ready("threads", "lecturn")).toBe(true);

    reportShowcaseSceneRendered({ scene: "thread", themeId: "lecturn" });
    expect(ready("thread", "lecturn")).toBe(true);
    expect(ready("terminal", "lecturn")).toBe(false);
  });

  it("keeps each scene's report when another mounted surface reports", () => {
    clearShowcaseRenderSignal();
    reportShowcaseSceneRendered({ scene: "terminal", themeId: "lecturn" });
    reportShowcaseSceneRendered({ scene: "thread", themeId: "lecturn" });
    expect(ready("terminal", "lecturn")).toBe(true);
    expect(ready("thread", "lecturn")).toBe(true);
  });

  it("requires the report to match the applied palette and a fresh report after a new request", () => {
    clearShowcaseRenderSignal();
    reportShowcaseSceneRendered({ scene: "review", themeId: "grove" });
    expect(ready("review", "lecturn")).toBe(false);

    reportShowcaseSceneRendered({ scene: "review", themeId: "lecturn" });
    expect(ready("review", "lecturn")).toBe(true);
    clearShowcaseRenderSignal();
    expect(ready("review", "lecturn")).toBe(false);
  });
});

import { describe, expect, it } from "vite-plus/test";
import {
  activityBounds,
  activityCameraHeight,
  hasNotchSpace,
  selectActivityDisplay,
  type ActivityDisplay,
} from "./geometry.ts";

const builtIn: ActivityDisplay = {
  id: 1,
  internal: true,
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  workArea: { x: 0, y: 38, width: 1512, height: 889 },
};
describe("activity display placement", () => {
  it("fits a micro card and steer field below the camera without expanding the whole panel", () => {
    expect(activityBounds(builtIn, "micro")).toEqual({ x: 546, y: 0, width: 420, height: 298 });
    expect(activityBounds({ ...builtIn, internal: false }, "micro").height).toBe(296);
  });
  it("sizes peek to its visible rows while clamping untrusted counts", () => {
    expect(activityBounds(builtIn, "peek", 1).height).toBe(163);
    expect(activityBounds(builtIn, "peek", 2).height).toBe(241);
    expect(activityBounds(builtIn, "peek", 3).height).toBe(319);
    expect(activityBounds(builtIn, "peek", 100).height).toBe(319);
  });
  it("encloses the camera area at the screen edge with enough room for scrollable expanded content", () => {
    expect(hasNotchSpace(builtIn)).toBe(true);
    expect(activityCameraHeight(builtIn)).toBe(38);
    expect(activityBounds(builtIn, false)).toEqual({ x: 546, y: 0, width: 420, height: 38 });
    expect(activityBounds(builtIn, true)).toEqual({ x: 546, y: 0, width: 420, height: 588 });
  });
  it("uses the menu fallback for external and ambiguous auto-hidden menu bars", () => {
    expect(hasNotchSpace({ ...builtIn, internal: false })).toBe(false);
    expect(activityCameraHeight({ ...builtIn, internal: false })).toBe(0);
    expect(hasNotchSpace({ ...builtIn, workArea: { ...builtIn.workArea, y: 0 } })).toBe(false);
    expect(hasNotchSpace({ ...builtIn, workArea: { ...builtIn.workArea, y: 24 } })).toBe(false);
  });
  it("clamps a tiny display at negative desktop coordinates and recovers when a monitor disconnects", () => {
    const external = {
      ...builtIn,
      id: 2,
      internal: false,
      bounds: { x: -300, y: -200, width: 300, height: 200 },
      workArea: { x: -300, y: -176, width: 300, height: 176 },
    };
    expect(selectActivityDisplay([builtIn, external], 2)).toBe(external);
    expect(activityBounds(external, true)).toEqual({ x: -300, y: -176, width: 300, height: 176 });
    expect(selectActivityDisplay([builtIn], 2)).toBe(builtIn);
    expect(selectActivityDisplay([], 2)).toBeUndefined();
  });
  it("centers on the camera even with a side dock", () => {
    expect(
      activityBounds({ ...builtIn, workArea: { ...builtIn.workArea, x: 70, width: 1442 } }, false)
        .x,
    ).toBe(546);
  });
});

import type { ActivityMode } from "./interaction.ts";

export interface ActivityRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface ActivityDisplay {
  id: number;
  internal: boolean;
  bounds: ActivityRectangle;
  workArea: ActivityRectangle;
}

/** Electron has no camera-housing API. A tall internal menu bar is a conservative hint;
 * auto-hidden or ambiguous menu bars use the tray fallback. The compact header sits alongside the camera; the expanded body starts below it. */
export function hasNotchSpace(display: ActivityDisplay): boolean {
  const inset = display.workArea.y - display.bounds.y;
  return display.internal && inset >= 32 && inset <= 80;
}

export function selectActivityDisplay(displays: readonly ActivityDisplay[], preferredId: number) {
  return displays.find((display) => display.id === preferredId) ?? displays[0];
}

export function activityBounds(
  display: ActivityDisplay,
  mode: ActivityMode | boolean,
  peekCount = 3,
): ActivityRectangle {
  const expanded = mode === true || mode === "expanded";
  const peek = mode === "peek";
  const area = display.workArea;
  const cameraHeight = activityCameraHeight(display);
  const width = Math.min(
    cameraHeight || expanded || peek || mode === "micro" ? 420 : 292,
    area.width,
  );
  const height = Math.min(
    expanded
      ? 550 + cameraHeight
      : mode === "micro"
        ? 260 + (cameraHeight || 36)
        : peek
          ? 47 + Math.max(1, Math.min(3, peekCount)) * 78 + (cameraHeight || 36)
          : cameraHeight || 36,
    area.height + cameraHeight,
  );
  return {
    x: Math.round(
      Math.max(
        area.x,
        Math.min(
          area.x + area.width - width,
          display.bounds.x + (display.bounds.width - width) / 2,
        ),
      ),
    ),
    y: cameraHeight ? display.bounds.y : area.y,
    width,
    height,
  };
}

/** Header height: controls sit in wings outside a reserved central camera housing. */
export function activityCameraHeight(display: ActivityDisplay): number {
  return hasNotchSpace(display) ? display.workArea.y - display.bounds.y : 0;
}

import { describe, expect, it } from "vite-plus/test";
import { ActivityHoverIntent } from "./hover.ts";

describe("activity hover intent", () => {
  it("keeps a newly shown panel collapsed beneath a stationary cursor", () => {
    const hover = new ActivityHoverIntent();
    hover.enter({ screenX: 800, screenY: 12 });
    expect(hover.move({ screenX: 800, screenY: 12 })).toBe(false);
    expect(hover.move({ screenX: 800, screenY: 12 })).toBe(false);
    expect(hover.move({ screenX: 801, screenY: 12 })).toBe(true);
  });

  it("requires fresh movement after leaving and reappearing under the pointer", () => {
    const hover = new ActivityHoverIntent();
    hover.enter({ screenX: 800, screenY: 12 });
    expect(hover.move({ screenX: 800, screenY: 13 })).toBe(true);
    hover.leave();
    hover.enter({ screenX: 500, screenY: 10 });
    expect(hover.move({ screenX: 500, screenY: 10 })).toBe(false);
    expect(hover.move({ screenX: 501, screenY: 10 })).toBe(true);
  });

  it("establishes a baseline if Chromium delivers movement before entry", () => {
    const hover = new ActivityHoverIntent();
    expect(hover.move({ screenX: 800, screenY: 12 })).toBe(false);
    expect(hover.move({ screenX: 802, screenY: 12 })).toBe(true);
  });
});

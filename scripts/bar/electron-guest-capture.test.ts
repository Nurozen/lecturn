import { assert, it } from "@effect/vitest";
import { PNG } from "pngjs";

import { captureEmbedComposite, compositeGuest } from "./electron-guest-capture.ts";

function solid(width: number, height: number, value: number): PNG {
  const image = new PNG({ width, height });
  image.data.fill(value);
  return image;
}

const pixel = (image: PNG, x: number, y: number) => image.data[(y * image.width + x) * 4];

it("pastes the guest at its bounds and leaves the rest of the window", () => {
  const out = compositeGuest(solid(20, 10, 10), solid(5, 4, 200), {
    x: 12,
    y: 3,
    width: 5,
    height: 4,
  });
  assert.equal(pixel(out, 12, 3), 200);
  assert.equal(pixel(out, 16, 6), 200);
  assert.equal(pixel(out, 11, 3), 10);
  assert.equal(pixel(out, 17, 6), 10);
  assert.equal(pixel(out, 12, 7), 10);
});

it("refuses a guest whose pixels do not match its bounds or that leaves the window", () => {
  assert.throws(
    () => compositeGuest(solid(20, 10, 0), solid(10, 8, 0), { x: 0, y: 0, width: 5, height: 4 }),
    /DPR 1/u,
  );
  assert.throws(
    () => compositeGuest(solid(20, 10, 0), solid(5, 4, 0), { x: 18, y: 0, width: 5, height: 4 }),
    /leave/u,
  );
});

it("composites every guest over the window capture", async () => {
  const image = await captureEmbedComposite({
    captureWindow: async () => PNG.sync.write(solid(20, 10, 10)),
    guests: [
      {
        bounds: () => ({ x: 0, y: 0, width: 4, height: 4 }),
        capture: async () => PNG.sync.write(solid(4, 4, 90)),
      },
      {
        bounds: () => ({ x: 10, y: 5, width: 4, height: 4 }),
        capture: async () => PNG.sync.write(solid(4, 4, 160)),
      },
    ],
  });
  assert.equal(pixel(image, 1, 1), 90);
  assert.equal(pixel(image, 11, 6), 160);
  assert.equal(pixel(image, 6, 1), 10);
});

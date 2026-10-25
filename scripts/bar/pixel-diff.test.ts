import { assert, it } from "@effect/vitest";
import { PNG } from "pngjs";

import { diffPngs, extractRegion, parsePixelDiffArgs } from "./pixel-diff.ts";

function solid(width: number, height: number, rgb: readonly [number, number, number]): PNG {
  const image = new PNG({ width, height });
  for (let offset = 0; offset < image.data.length; offset += 4) {
    image.data[offset] = rgb[0];
    image.data[offset + 1] = rgb[1];
    image.data[offset + 2] = rgb[2];
    image.data[offset + 3] = 255;
  }
  return image;
}

function paintBox(
  image: PNG,
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  rgb: readonly [number, number, number],
): PNG {
  for (let y = box.y; y < box.y + box.height; y++) {
    for (let x = box.x; x < box.x + box.width; x++) {
      const offset = (y * image.width + x) * 4;
      image.data[offset] = rgb[0];
      image.data[offset + 1] = rgb[1];
      image.data[offset + 2] = rgb[2];
    }
  }
  return image;
}

const background = [27, 30, 32] as const;
const accent = [240, 200, 90] as const;

it("reports 0% for identical images", () => {
  const result = diffPngs(solid(100, 80, background), solid(100, 80, background));
  assert.equal(result.changedPixels, 0);
  assert.equal(result.percent, 0);
  assert.equal(result.diff.width, 100);
});

it("reports a known box as its share of the compared area", () => {
  const candidate = paintBox(
    solid(100, 100, background),
    { x: 10, y: 20, width: 10, height: 10 },
    accent,
  );
  const result = diffPngs(solid(100, 100, background), candidate);
  assert.equal(result.changedPixels, 100);
  assert.equal(result.percent, 1);
});

it("compares only the cropped region", () => {
  const candidate = paintBox(
    solid(100, 100, background),
    { x: 0, y: 0, width: 10, height: 10 },
    accent,
  );
  const baseline = solid(100, 100, background);
  assert.equal(
    diffPngs(baseline, candidate, { crop: { x: 0, y: 50, width: 100, height: 50 } }).percent,
    0,
  );
  assert.equal(
    diffPngs(baseline, candidate, { crop: { x: 0, y: 0, width: 20, height: 10 } }).percent,
    50,
  );
});

it("aligns shifted content before comparing", () => {
  const box = { x: 30, y: 30, width: 20, height: 20 };
  const baseline = paintBox(solid(120, 100, background), box, accent);
  const candidate = paintBox(solid(120, 100, background), { ...box, x: box.x + 8 }, accent);
  const crop = { x: 0, y: 0, width: 100, height: 100 };
  assert.isAbove(diffPngs(baseline, candidate, { crop }).percent, 0);
  assert.equal(diffPngs(baseline, candidate, { crop, align: { dx: 8, dy: 0 } }).percent, 0);
});

it("refuses unequal sizes without a crop and crops that leave the image", () => {
  assert.throws(
    () => diffPngs(solid(10, 10, background), solid(12, 10, background)),
    /sizes differ/u,
  );
  assert.throws(
    () => extractRegion(solid(10, 10, background), { x: 5, y: 0, width: 6, height: 10 }),
    /does not fit/u,
  );
});

it("parses crop, align and threshold flags", () => {
  const args = parsePixelDiffArgs([
    "a.png",
    "b.png",
    "--crop",
    "0,48,280,852",
    "--align",
    "0,-2",
    "--threshold",
    "0.1",
    "--max-percent",
    "0.5",
  ]);
  assert.deepEqual(args.options, {
    crop: { x: 0, y: 48, width: 280, height: 852 },
    align: { dx: 0, dy: -2 },
    threshold: 0.1,
  });
  assert.equal(args.maxPercent, 0.5);
  assert.throws(() => parsePixelDiffArgs(["a.png"]), /Usage/u);
});

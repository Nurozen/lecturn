// @effect-diagnostics nodeBuiltinImport:off - expectations mirror the host path joins the script under test performs.
import { assert, it } from "@effect/vitest";
import { PNG } from "pngjs";

import { type ShowcaseConfig, type ShowcaseStoreAssetSpec } from "./mobile-showcase.config.ts";
import {
  encodeAndroidPairingUrls,
  manifestBundleUrl,
  normalizeStorePng,
  parsePairingCredentialOutput,
  parseShowcaseCliArgs,
  planShowcaseCaptures,
  readPngMetadata,
  screenshotsMatch,
  showcaseStallText,
} from "./mobile-showcase.ts";

const appleSpec: ShowcaseStoreAssetSpec = {
  store: "apple",
  directory: "apple/iphone-test",
  width: 1284,
  height: 2778,
  minimumUploadCount: 1,
  maximumUploadCount: 10,
};

const googleSpec: ShowcaseStoreAssetSpec = {
  store: "google-play",
  directory: "google-play/phone",
  width: 1080,
  height: 1920,
  minimumUploadCount: 2,
  maximumUploadCount: 8,
  maximumFileSizeBytes: 8 * 1024 * 1024,
};

const config: ShowcaseConfig = {
  outputDirectory: "artifacts",
  metroPort: 8199,
  settleDelayMs: 1,
  devices: [
    {
      id: "phone",
      platform: "ios",
      simulator: "iPhone Test",
      appearance: "dark",
      theme: "lecturn",
      scenes: ["thread", "review"],
      storeAsset: appleSpec,
    },
    {
      id: "pixel",
      platform: "android",
      avd: "Pixel_Test",
      appearance: "light",
      theme: "lecturn",
      scenes: ["thread", "terminal"],
      storeAsset: googleSpec,
    },
  ],
};

function rgbaPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(255);
  return PNG.sync.write(png);
}

it("converts simulator RGBA captures to upload-safe 24-bit RGB PNGs", () => {
  const normalized = normalizeStorePng(rgbaPng(2, 3));
  assert.deepStrictEqual(readPngMetadata(normalized), {
    width: 2,
    height: 3,
    bitDepth: 8,
    colorType: 2,
    hasAlpha: false,
  });
});

it("reads multiline JSON from the pairing CLI", () => {
  assert.equal(
    parsePairingCredentialOutput('server log\n{\n  "credential": "PAIR-ME"\n}\n'),
    "PAIR-ME",
  );
});

it("encodes Android pairing URLs without shell-sensitive JSON quotes", () => {
  const urls = ["http://10.0.2.2:65164/#token=ONE", "http://10.0.2.2:65198/#token=TWO"];
  const encoded = encodeAndroidPairingUrls(urls);
  assert.equal(encoded.startsWith("json-uri:"), true);
  assert.deepStrictEqual(JSON.parse(decodeURIComponent(encoded.slice("json-uri:".length))), urls);
  assert.equal(encoded.includes('"'), false);
});

it("captures the optional PR watch route without expanding the default store matrix", () => {
  const selected = planShowcaseCaptures(
    config,
    parseShowcaseCliArgs(["--device", "phone", "--scene", "pr-watch"]),
  );
  assert.deepStrictEqual(selected[0]?.scenes, ["pr-watch"]);
  const defaults = planShowcaseCaptures(config, parseShowcaseCliArgs(["--device", "phone"]));
  assert.deepStrictEqual(defaults[0]?.scenes, ["thread", "review"]);
});

it("warms the bundle URL the dev client loads from the manifest", () => {
  const bundleUrl =
    "http://192.168.64.8:8199/apps/mobile/index.bundle?platform=ios&dev=true&lazy=false&transform.engine=hermes";
  assert.equal(manifestBundleUrl({ launchAsset: { url: bundleUrl } }), bundleUrl);
  assert.throws(() => manifestBundleUrl({ launchAsset: {} }), /no launch asset URL/);
  assert.throws(() => manifestBundleUrl(null), /no launch asset URL/);
});

it("treats a capture that still shows the previous scene as a match", () => {
  const frame = (paint: (x: number, y: number) => number) => {
    const png = new PNG({ width: 200, height: 400 });
    for (let y = 0; y < 400; y += 1) {
      for (let x = 0; x < 200; x += 1) {
        const offset = (y * 200 + x) * 4;
        png.data[offset] = paint(x, y);
        png.data[offset + 1] = 40;
        png.data[offset + 2] = 60;
        png.data[offset + 3] = 255;
      }
    }
    return PNG.sync.write(png);
  };
  const thread = frame(() => 20);
  const sameThreadAfterStatusBarTick = frame((x, y) => (x === 0 && y === 0 ? 240 : 20));
  const terminal = frame((_x, y) => (y < 200 ? 20 : 200));
  assert.equal(screenshotsMatch(thread, sameThreadAfterStatusBarTick), true);
  assert.equal(screenshotsMatch(thread, terminal), false);
  assert.equal(screenshotsMatch(thread, normalizeStorePng(thread)), true);
});

it("refuses scenes that settled on a stall or error screen", () => {
  assert.equal(
    showcaseStallText('{"AXLabel":"Reconnecting to Moonbase Terminal..."}'),
    "Reconnecting",
  );
  assert.equal(
    showcaseStallText('{"AXLabel":"Could not check terminal access"}'),
    "Could not check terminal access",
  );
  assert.equal(showcaseStallText('{"AXLabel":"Review unavailable"}'), "Review unavailable");
  assert.equal(
    showcaseStallText(
      '{"AXLabel":"Remote environment endpoint http://127.0.0.1:1/api/auth/session timed out after 6000ms."}',
    ),
    "timed out after",
  );
  assert.equal(
    showcaseStallText('{"AXLabel":"Sends on reconnect"},{"AXLabel":"Changes vs main"}'),
    null,
  );
});

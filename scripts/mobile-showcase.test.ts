// @effect-diagnostics nodeBuiltinImport:off - expectations mirror the host path joins the script under test performs.
import { assert, it } from "@effect/vitest";
import { PNG } from "pngjs";

import { type ShowcaseConfig, type ShowcaseStoreAssetSpec } from "./mobile-showcase.config.ts";
import {
  encodeAndroidPairingUrls,
  normalizeStorePng,
  parsePairingCredentialOutput,
  parseShowcaseCliArgs,
  planShowcaseCaptures,
  readPngMetadata,
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

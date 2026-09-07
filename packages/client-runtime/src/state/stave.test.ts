import { describe, expect, it } from "vite-plus/test";

import { environmentSupportsStave, staveFeatureAvailable } from "./stave.ts";

const supported = { environment: { capabilities: { stave: { protocolVersion: 1 } } } };
const unsupported = { environment: { capabilities: {} } };
const enabled = { stave: { enabled: true } };
const disabled = { stave: { enabled: false } };
const runnable = {
  runnable: {
    path: "/usr/local/bin/stave",
    source: "path" as const,
    version: "0.4.0",
    commit: null,
  },
};
const notRunnable = { runnable: null };

describe("environmentSupportsStave", () => {
  it("is true only when the capability descriptor is present", () => {
    expect(environmentSupportsStave(supported)).toBe(true);
    expect(environmentSupportsStave(unsupported)).toBe(false);
    expect(environmentSupportsStave(null)).toBe(false);
    expect(environmentSupportsStave(undefined)).toBe(false);
  });
});

describe("staveFeatureAvailable", () => {
  it("requires capability, the enabled setting, and a runnable binary", () => {
    expect(staveFeatureAvailable({ config: supported, settings: enabled, status: runnable })).toBe(
      true,
    );
  });

  it("is false when any of the three facts is missing", () => {
    expect(
      staveFeatureAvailable({ config: unsupported, settings: enabled, status: runnable }),
    ).toBe(false);
    expect(staveFeatureAvailable({ config: supported, settings: disabled, status: runnable })).toBe(
      false,
    );
    expect(
      staveFeatureAvailable({ config: supported, settings: enabled, status: notRunnable }),
    ).toBe(false);
    expect(staveFeatureAvailable({ config: supported, settings: enabled, status: null })).toBe(
      false,
    );
    expect(staveFeatureAvailable({ config: supported, settings: null, status: runnable })).toBe(
      false,
    );
    expect(staveFeatureAvailable({ config: null, settings: enabled, status: runnable })).toBe(
      false,
    );
  });
});

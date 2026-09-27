import { sign as signApplication, type SignOptions } from "@electron/osx-sign";
import { expect, it, vi } from "vite-plus/test";

import { resolveExtensionsBinary } from "../apps/server/src/extensions/ExtensionsBinary.ts";
vi.mock("../apps/server/src/extensions/ExtensionsBinary.ts", () => ({
  resolveExtensionsBinary: vi.fn(async () => null),
}));

import sign from "./sign-macos.ts";

vi.mock("@electron/osx-sign", () => ({ sign: vi.fn() }));

it("batches codesign calls without changing existing signing options", async () => {
  const options = {
    app: "/tmp/Lecturn.app",
    identity: "Developer ID Application: Cloud Gatherer Labs LLC",
    keychain: "/tmp/lecturn.keychain",
    provisioningProfile: "/tmp/lecturn.provisionprofile",
    optionsForFile: () => ({
      entitlements: "/tmp/lecturn.entitlements.plist",
      hardenedRuntime: true,
    }),
  } satisfies SignOptions;

  await sign(options);

  expect(signApplication).toHaveBeenCalledExactlyOnceWith({
    ...options,
    batchCodesignCalls: true,
  });
});

it("preserves only verified helper bytes while signing the rest of the app", async () => {
  vi.mocked(signApplication).mockClear();
  const helper = {
    path: "/tmp/Lecturn.app/Contents/Resources/extensions/darwin-arm64/lecturn-extensions-helper",
    sha256: "pinned",
    buildVersion: "build",
    source: "bundled" as const,
  };
  vi.mocked(resolveExtensionsBinary).mockImplementation(async (input) =>
    input.architecture === "arm64" ? helper : null,
  );
  await sign({ app: "/tmp/Lecturn.app", identity: "Developer ID", ignore: ["existing-ignore"] });
  const options = vi.mocked(signApplication).mock.calls[0]![0];
  expect(options.ignore).toEqual(["existing-ignore", expect.any(Function)]);
  const matcher = (options.ignore as ((path: string) => boolean)[])[1]!;
  expect(matcher(helper.path)).toBe(true);
  expect(matcher("/tmp/Lecturn.app/Contents/MacOS/Lecturn")).toBe(false);
  expect(matcher(helper.path + "-other")).toBe(false);
  expect(
    vi
      .mocked(resolveExtensionsBinary)
      .mock.calls.slice(-4)
      .map(([value]) => value.architecture),
  ).toEqual(["arm64", "x64", "arm64", "x64"]);
  vi.mocked(resolveExtensionsBinary).mockResolvedValue(null);
});

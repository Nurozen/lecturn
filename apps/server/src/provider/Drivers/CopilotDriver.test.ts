import { describe, expect, it } from "@effect/vitest";

import { COPILOT_UPDATE_RESOLVER } from "./CopilotDriver.ts";

describe("COPILOT_UPDATE_RESOLVER", () => {
  it("updates an npm global install through npm", () => {
    const capabilities = COPILOT_UPDATE_RESOLVER.resolve({
      binaryPath: "copilot",
      resolvedCommandPath: "/usr/local/bin/copilot",
      realCommandPath: "/usr/local/lib/node_modules/@github/copilot/npm-loader.js",
    });
    expect(capabilities.packageName).toBe("@github/copilot");
    expect(capabilities.update?.executable).toBe("npm");
    expect(capabilities.update?.lockKey).toBe("npm-global");
  });

  it("updates a Windows npm shim through npm, not copilot update", () => {
    const capabilities = COPILOT_UPDATE_RESOLVER.resolve({
      binaryPath: "copilot",
      resolvedCommandPath: "C:\\Users\\me\\AppData\\Roaming\\npm\\copilot.cmd",
    });
    expect(capabilities.update?.lockKey).toBe("npm-global");
    expect(capabilities.update?.args).not.toEqual(["update"]);
  });

  it("lets a Homebrew cask install update itself instead of running brew", () => {
    const capabilities = COPILOT_UPDATE_RESOLVER.resolve({
      binaryPath: "copilot",
      resolvedCommandPath: "/opt/homebrew/bin/copilot",
      realCommandPath: "/opt/homebrew/Caskroom/copilot-cli/1.0.88/copilot",
    });
    expect(capabilities.packageName).toBe("@github/copilot");
    expect(capabilities.update).toEqual({
      command: "/opt/homebrew/bin/copilot update",
      executable: "/opt/homebrew/bin/copilot",
      args: ["update"],
      lockKey: "copilot-native",
    });
  });
});

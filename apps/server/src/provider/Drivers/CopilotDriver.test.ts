// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@lecturn/shared/hostProcess";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import type { ProviderMaintenanceResolutionContext } from "../providerMaintenance.ts";
import { COPILOT_UPDATE_RESOLVER } from "./CopilotDriver.ts";

const noSpawn = ChildProcessSpawner.make(() =>
  Effect.die("Resolving Copilot updates must not spawn a process"),
);

const resolve = (
  context: Pick<ProviderMaintenanceResolutionContext, "resolvedCommandPath" | "realCommandPath">,
  platform: NodeJS.Platform = "darwin",
) =>
  COPILOT_UPDATE_RESOLVER.resolve({
    binaryPath: "copilot",
    env: { PATH: "" },
    platform,
    ...context,
  }).pipe(
    Effect.provideService(HostProcessPlatform, platform),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
    Effect.provide(NodeServices.layer),
  );

describe("COPILOT_UPDATE_RESOLVER", () => {
  it.effect("updates an npm global install through npm", () =>
    Effect.gen(function* () {
      const capabilities = yield* resolve({
        resolvedCommandPath: "/usr/local/bin/copilot",
        realCommandPath: "/usr/local/lib/node_modules/@github/copilot/npm-loader.js",
      });
      expect(capabilities.packageName).toBe("@github/copilot");
      expect(capabilities.update?.executable).toBe("npm");
      expect(capabilities.update?.lockKey).toBe("npm-global:/usr/local");
    }),
  );

  it.effect("updates a Windows npm shim through npm, not copilot update", () =>
    Effect.gen(function* () {
      const prefix = NodePath.join(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lecturn-copilot-windows-")),
        "npm",
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(NodePath.dirname(prefix), { recursive: true })),
      );
      const shim = NodePath.join(prefix, "copilot.cmd");
      const manifestDir = NodePath.join(prefix, "node_modules", "@github", "copilot");
      NodeFS.mkdirSync(manifestDir, { recursive: true });
      NodeFS.writeFileSync(shim, "@echo off\r\n");
      NodeFS.writeFileSync(NodePath.join(manifestDir, "package.json"), "{}");

      const capabilities = yield* resolve(
        { resolvedCommandPath: shim, realCommandPath: shim },
        "win32",
      );
      expect(capabilities.update?.executable).toBe("npm");
      expect(capabilities.update?.args).toEqual(expect.arrayContaining(["--prefix", prefix]));
    }).pipe(Effect.scoped),
  );

  it.effect("leaves a node package install it cannot prove to the user", () =>
    Effect.gen(function* () {
      const capabilities = yield* resolve({
        resolvedCommandPath: "/work/app/node_modules/.bin/copilot",
        realCommandPath: "/work/app/node_modules/@github/copilot/npm-loader.js",
      });
      expect(capabilities.packageName).toBe("@github/copilot");
      expect(capabilities.update).toBeNull();
    }),
  );

  it.effect("lets a Homebrew cask install update itself instead of running brew", () =>
    Effect.gen(function* () {
      const capabilities = yield* resolve({
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
    }),
  );

  it.effect("offers no update command for an executable that was not found", () =>
    Effect.gen(function* () {
      const capabilities = yield* COPILOT_UPDATE_RESOLVER.resolve(null).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
        Effect.provide(NodeServices.layer),
      );
      expect(capabilities.packageName).toBe("@github/copilot");
      expect(capabilities.update).toBeNull();
    }),
  );
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import {
  HostProcessArguments,
  HostProcessExecutablePath,
  HostProcessIsExecutable,
  HostProcessPlatform,
} from "@lecturn/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { formatCliCommand, resolveServerInstallation } from "./invocation.ts";

it("never suggests package runner commands from cache entry paths", () => {
  for (const entryPath of [
    "/home/theo/.npm/_npx/abc123/node_modules/lecturn/dist/bin.mjs",
    "C:\\Users\\theo\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\lecturn\\dist\\bin.mjs",
    "/home/theo/.cache/pnpm/dlx/abc/node_modules/lecturn/dist/bin.mjs",
    "/home/theo/.local/share/pnpm/.pnpm/dlx/abc/node_modules/lecturn/dist/bin.mjs",
    "C:\\Users\\theo\\AppData\\Local\\pnpm-cache\\dlx\\abc\\node_modules\\lecturn\\dist\\bin.mjs",
    "/home/theo/.bun/install/cache/lecturn@0.0.31/dist/bin.mjs",
    "/tmp/bunx-1000-lecturn@latest/node_modules/lecturn/dist/bin.mjs",
    "C:\\Users\\theo\\AppData\\Local\\Temp\\bunx-0-lecturn@latest\\node_modules\\lecturn\\dist\\bin.mjs",
  ]) {
    assert.equal(
      formatCliCommand({ subcommand: "serve", entryPath, version: "0.0.31" }),
      "lecturn serve",
    );
  }
});

it("treats stable installs as direct invocations", () => {
  for (const entryPath of [
    "/usr/local/lib/node_modules/lecturn/dist/bin.mjs",
    "/home/theo/Code/work/lecturn/apps/server/dist/bin.mjs",
    "/home/theo/.lecturn/runtime/0.0.31/node_modules/lecturn/dist/bin.mjs",
    "",
  ]) {
    assert.equal(
      formatCliCommand({ subcommand: "serve", entryPath, version: "0.0.31" }),
      "lecturn serve",
    );
  }
});

it("never re-suggests a prerelease channel, even for prerelease builds", () => {
  for (const version of [
    "0.0.31-nightly.20260729",
    "0.0.31-preview.20260729.1",
    "0.0.31-foo-preview.20260729.1",
    "0.0.31",
  ]) {
    assert.equal(
      formatCliCommand({
        subcommand: "serve",
        entryPath: "/home/theo/.npm/_npx/abc123/node_modules/lecturn/dist/bin.mjs",
        version,
      }),
      "lecturn serve",
    );
  }
});

it("formats the requested subcommand", () => {
  assert.equal(
    formatCliCommand({
      subcommand: "connect",
      entryPath: "/tmp/bunx-1000-lecturn@latest/node_modules/lecturn/dist/bin.mjs",
      version: "0.0.31",
    }),
    "lecturn connect",
  );
});

it.layer(NodeServices.layer)("manual server installation ownership", (it) => {
  it.effect("leaves every install unknown until Lecturn publishes an npm distribution", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      for (const relative of [
        "npm/_npx/hash/node_modules/lecturn/dist/bin.mjs",
        "pnpm/dlx/hash/node_modules/lecturn/dist/bin.mjs",
        ".bun/install/cache/lecturn/dist/bin.mjs",
        "prefix/lib/node_modules/lecturn/dist/bin.mjs",
        "project/apps/server/dist/bin.mjs",
        ".lecturn/runtime/0.0.45/lecturn",
      ]) {
        const entry = path.join(root, relative);
        yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
        yield* fs.writeFileString(entry, "");
        const installation = yield* resolveServerInstallation.pipe(
          Effect.provideService(HostProcessArguments, ["node", entry]),
          Effect.provideService(HostProcessExecutablePath, entry),
          Effect.provideService(HostProcessIsExecutable, entry.endsWith("/lecturn")),
          Effect.provideService(HostProcessPlatform, "linux"),
        );
        expect(installation).toBeNull();
      }
    }),
  );
});

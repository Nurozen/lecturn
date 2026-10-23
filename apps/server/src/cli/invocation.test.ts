import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as HostProcess from "@lecturn/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  formatCliCommand,
  resolveHostCliCommand,
  resolveRootCliCommand,
  resolveServerInstallation,
} from "./invocation.ts";

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

it.layer(NodeServices.layer)("root CLI commands", (it) => {
  /** `sudo lecturn browser setup` as this process would render it, with `lecturn` on PATH or not. */
  const rootCommand = (input: {
    readonly node: string;
    readonly entry: string;
    readonly path?: string;
    readonly env?: Record<string, string>;
    readonly executable?: boolean;
  }) =>
    resolveRootCliCommand("browser setup").pipe(
      Effect.provideService(HostProcess.ExecutablePath, input.node),
      Effect.provideService(HostProcess.Arguments, [input.node, input.entry]),
      Effect.provideService(HostProcess.IsExecutable, input.executable ?? false),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, { PATH: input.path ?? "", ...input.env }),
    );

  /** A directory holding an executable `lecturn`, to stand in for one on PATH. */
  const pathWithLecturn = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const bin = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(path.join(bin, "lecturn"), "#!/bin/sh\n", { mode: 0o755 });
    return bin;
  });

  it.effect("keeps a user-installed Node reachable when the command runs under sudo", () =>
    Effect.gen(function* () {
      const npx = "/home/theo/.npm/_npx/abc/node_modules/lecturn/dist/bin.mjs";
      // sudo's secure_path already has a system Node.
      expect(yield* rootCommand({ node: "/usr/bin/node", entry: npx })).toBe(
        "sudo lecturn browser setup",
      );
      // nvm, fnm, and tarball installs are dropped by sudo's PATH reset.
      expect(
        yield* rootCommand({ node: "/home/theo/.nvm/versions/node/v24/bin/node", entry: npx }),
      ).toBe('sudo env "PATH=$PATH" lecturn browser setup');
      expect(
        yield* rootCommand({
          node: "/home/theo/.local/node/bin/node",
          entry: "/home/theo/.local/lib/node_modules/lecturn/dist/bin.mjs",
          path: yield* pathWithLecturn,
        }),
      ).toBe('sudo env "PATH=$PATH" lecturn browser setup');
    }).pipe(Effect.scoped),
  );

  it.effect("names this install's launcher when lecturn is not on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const shim = path.join(home, ".local bin", "lecturn");
      yield* fs.makeDirectory(path.dirname(shim), { recursive: true });
      yield* fs.writeFileString(shim, "#!/bin/sh\n", { mode: 0o755 });
      const desktop = {
        node: "/tmp/.mount_Lecturnabc/lecturn",
        entry: "/tmp/.mount_Lecturnabc/resources/app.asar/apps/server/dist/bin.mjs",
        env: { LECTURN_CLI_PATH: shim },
      };

      expect(yield* rootCommand(desktop)).toBe(`sudo '${shim}' browser setup`);
      // A `lecturn` the person put on PATH still wins.
      expect(yield* rootCommand({ ...desktop, path: yield* pathWithLecturn })).toBe(
        'sudo env "PATH=$PATH" lecturn browser setup',
      );

      expect(
        yield* rootCommand({
          node: "/opt/lecturn/lecturn",
          entry: "/opt/lecturn/lecturn",
          executable: true,
        }),
      ).toBe("sudo /opt/lecturn/lecturn browser setup");
      // A stale shim path, then no launcher at all, fall back to plain `lecturn`.
      expect(
        yield* rootCommand({ ...desktop, env: { LECTURN_CLI_PATH: path.join(home, "gone") } }),
      ).toBe('sudo env "PATH=$PATH" lecturn browser setup');
    }).pipe(Effect.scoped),
  );
});

it.layer(NodeServices.layer)("host CLI commands", (it) => {
  it.effect("renders a PowerShell command line on Windows", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const shim = path.join(home, "lecturn.cmd");
      yield* fs.writeFileString(shim, "@echo off\r\n");
      const hostCommand = (platform: NodeJS.Platform, env: Record<string, string>) =>
        resolveHostCliCommand("doctor", ["--base-dir", "C:\\Users\\Jane Doe\\.lecturn"]).pipe(
          Effect.provideService(
            HostProcess.ExecutablePath,
            "C:\\Program Files\\Lecturn\\lecturn.exe",
          ),
          Effect.provideService(HostProcess.Arguments, [
            "C:\\Program Files\\Lecturn\\lecturn.exe",
            "C:\\Program Files\\Lecturn\\resources\\app.asar\\apps\\server\\dist\\bin.mjs",
          ]),
          Effect.provideService(HostProcess.IsExecutable, false),
          Effect.provideService(HostProcess.Platform, platform),
          Effect.provideService(HostProcess.Environment, { PATH: "", ...env }),
        );
      // The desktop shim is called through `&`, and each argument is quoted
      // the PowerShell way: no POSIX single quotes anywhere.
      expect((yield* hostCommand("win32", { LECTURN_CLI_PATH: shim })).command).toBe(
        `& "${shim}" doctor "--base-dir" "C:\\Users\\Jane Doe\\.lecturn"`,
      );
      // Without a launcher, plain `lecturn` with PowerShell-quoted arguments.
      expect((yield* hostCommand("win32", {})).command).toBe(
        'lecturn doctor "--base-dir" "C:\\Users\\Jane Doe\\.lecturn"',
      );
      // Typographic quotes also delimit PowerShell strings; doubling keeps them.
      expect(
        (yield* resolveHostCliCommand("doctor", [
          "--base-dir",
          "C:\\Lecturn\\\u201CArchive\u201D",
        ]).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(HostProcess.Environment, { PATH: "" }),
          Effect.provideService(HostProcess.ExecutablePath, "C:\\lecturn.exe"),
          Effect.provideService(HostProcess.Arguments, ["C:\\lecturn.exe", "C:\\bin.mjs"]),
          Effect.provideService(HostProcess.IsExecutable, false),
        )).command,
      ).toBe('lecturn doctor "--base-dir" "C:\\Lecturn\\\u201C\u201CArchive\u201D\u201D"');
      // POSIX hosts keep single quotes for the same input. The shim prefix is
      // a host path, so only the arguments are asserted.
      expect((yield* hostCommand("linux", { LECTURN_CLI_PATH: shim })).command).toMatch(
        / doctor --base-dir 'C:\\Users\\Jane Doe\\\.lecturn'$/,
      );
    }).pipe(Effect.scoped),
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
          Effect.provideService(HostProcess.Arguments, ["node", entry]),
          Effect.provideService(HostProcess.ExecutablePath, entry),
          Effect.provideService(HostProcess.IsExecutable, entry.endsWith("/lecturn")),
          Effect.provideService(HostProcess.Platform, "linux"),
        );
        expect(installation).toBeNull();
      }
    }),
  );
});

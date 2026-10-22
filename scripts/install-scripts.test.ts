import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CLI_PUBLISHED_ARCHIVE_PLATFORM_KEYS } from "@lecturn/shared/cliRelease";
import { HostProcessPlatform } from "@lecturn/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const scriptPath = (name: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(import.meta.dirname, name);
  });

// The install scripts cannot import the shared key list, so they hard-code it.
describe("install scripts", () => {
  it.effect("accept exactly the platforms a release publishes an archive for", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const installSh = yield* fs.readFileString(yield* scriptPath("install.sh"));
      const installPs1 = yield* fs.readFileString(yield* scriptPath("install.ps1"));
      const shKeys = /case "\$\{platform\}-\$\{arch\}" in\n {2}([^)]+)\) ;;/
        .exec(installSh)?.[1]
        ?.split("|")
        .map((key) => key.trim());
      const ps1Keys = /if \(@\(([^)]*)\) -notcontains "win32-\$arch"\)/
        .exec(installPs1)?.[1]
        ?.split(",")
        .map((key) => key.trim().replaceAll('"', ""));
      assert.deepEqual(
        [...(shKeys ?? []), ...(ps1Keys ?? [])].toSorted(),
        [...CLI_PUBLISHED_ARCHIVE_PLATFORM_KEYS].toSorted(),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "points unpublished platforms at npx before any download",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "lecturn-install-sh-" });
        const stub = (name: string, body: string) =>
          fs
            .writeFileString(`${root}/${name}`, `#!/bin/sh\n${body}\n`)
            .pipe(Effect.andThen(fs.chmod(`${root}/${name}`, 0o755)));
        yield* stub("uname", 'case "$1" in -s) echo Linux ;; -m) echo aarch64 ;; esac');
        // Any network access would fail the run with a different message.
        yield* stub("curl", "echo unexpected download >&2; exit 99");
        yield* stub("wget", "echo unexpected download >&2; exit 99");
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const child = yield* spawner.spawn(
          ChildProcess.make("sh", [yield* scriptPath("install.sh")], {
            env: { PATH: `${root}:/usr/bin:/bin`, HOME: root },
            extendEnv: false,
          }),
        );
        const [stderr, exitCode] = yield* Effect.all(
          [
            child.stderr.pipe(
              Stream.decodeText(),
              Stream.runFold(
                () => "",
                (acc, chunk) => acc + chunk,
              ),
            ),
            child.exitCode.pipe(Effect.map(Number)),
          ],
          { concurrency: "unbounded" },
        );
        assert.equal(exitCode, 1);
        assert.include(stderr, "no self-contained CLI for linux-arm64");
        assert.include(stderr, "npx lecturn");
        assert.notInclude(stderr, "unexpected download");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

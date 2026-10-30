// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- The probe is a plain Node child; this deadline kills it if it hangs.
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect } from "vite-plus/test";

import * as CursorSdk from "./CursorSdk.ts";
import { isCursorShellSpawnFailure } from "./CursorSdk.ts";

const cursorSdkUrl = new URL("./CursorSdk.ts", import.meta.url).href;

// The vitest worker already has its own unhandledRejection listener, which
// would hide the process-exit behavior.
const probeProgram = `
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "cursor-sdk-stub-"));
const stub = join(dir, "stub.cjs");
writeFileSync(
  stub,
  "module.exports = { Agent: {}, AuthenticationError: class {}, createAgentPlatform: () => ({}), Cursor: {}, CursorSdkError: class {}, InMemoryCredentialStore: class {} };",
);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@cursor/sdk" || specifier === "@cursor/sdk/sqlite") {
      return { url: pathToFileURL(stub).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const { layer } = await import(${JSON.stringify(cursorSdkUrl)});
const Effect = await import("effect/Effect");
const Layer = await import("effect/Layer");
const Exit = await import("effect/Exit");
const Scope = await import("effect/Scope");
const scope = Scope.makeUnsafe();
await Effect.runPromise(Layer.buildWithScope(layer, scope));
const mode = process.argv[1];
const missingCwd = join(tmpdir(), "lecturn-missing-cwd-" + process.pid);

if (mode === "cursor-shell") {
  const child = spawn("/bin/zsh", ["-c", "dump_zsh_state >&4", "--", "true"], {
    cwd: missingCwd,
  });
  child.on("error", (error) => {
    Promise.reject(error);
  });
  setTimeout(() => process.exit(0), 500);
} else if (mode === "released") {
  await Effect.runPromise(Scope.close(scope, Exit.void));
  Promise.reject(
    Object.assign(new Error("spawn /bin/zsh ENOENT"), {
      code: "ENOENT",
      syscall: "spawn /bin/zsh",
      spawnargs: ["-c", "dump_zsh_state >&4"],
    }),
  );
  setTimeout(() => process.exit(0), 500);
} else if (mode === "other-spawn") {
  Promise.reject(
    Object.assign(new Error("spawn git ENOENT"), {
      code: "ENOENT",
      syscall: "spawn git",
      path: "git",
      spawnargs: ["status"],
    }),
  );
  setTimeout(() => process.exit(0), 500);
} else if (mode === "other-rejection") {
  Promise.reject(new Error("boom"));
  setTimeout(() => process.exit(0), 500);
} else if (mode === "spawn-without-listener") {
  spawn(process.execPath, ["-e", "process.exit(0)"], { cwd: missingCwd });
  setTimeout(() => process.exit(0), 500);
} else {
  console.error("Unknown cursor shell spawn guard probe: " + mode);
  process.exit(2);
}
`;

function runProbe(mode: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--disable-warning=ExperimentalWarning",
        "--input-type=module",
        "-e",
        probeProgram,
        mode,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`probe ${mode} timed out`));
    }, 5_000);
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Node's error when `missing` cannot be resolved while requiring the SDK. */
const requireWithMissingModule = (missing: string) => () => {
  throw Object.assign(
    new Error(
      `Cannot find module '${missing}'\nRequire stack:\n- /app/node_modules/@cursor/sdk/dist/cjs/index.js`,
    ),
    { code: "MODULE_NOT_FOUND" },
  );
};

const loadWith = (require: (id: string) => unknown) =>
  Effect.flatMap(CursorSdk.CursorSdk, (cursorSdk) => cursorSdk.load).pipe(
    Effect.provide(CursorSdk.layerFromRequire(require)),
  );

const providerServerUrl = new URL("../server.ts", import.meta.url).href;
// Absolute, so the child does not resolve Effect from the test runner's cwd.
const effectUrl = NodeURL.pathToFileURL(
  NodeModule.createRequire(import.meta.url).resolve("effect/Effect"),
).href;

// The hook is registered before anything from this package loads, so an eager
// SDK import or require anywhere in the provider makes the first import throw.
const sdkOmittedProgram = `
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@cursor/sdk")) {
      throw Object.assign(new Error("Cannot find module '" + specifier + "'"), {
        code: "MODULE_NOT_FOUND",
      });
    }
    return next(specifier, context);
  },
});
await import(${JSON.stringify(providerServerUrl)});
const CursorSdk = await import(${JSON.stringify(cursorSdkUrl)});
const Effect = await import(${JSON.stringify(effectUrl)});
const error = await Effect.runPromise(
  Effect.flatMap(CursorSdk.CursorSdk, (cursorSdk) => cursorSdk.load).pipe(
    Effect.provide(CursorSdk.layer),
    Effect.flip,
  ),
);
process.stdout.write(error._tag);
`;

describe("CursorSdk.load", () => {
  it("lets the provider load and report not installed when @cursor/sdk cannot resolve", async () => {
    const { stdout } = await NodeUtil.promisify(NodeChildProcess.execFile)(process.execPath, [
      "--experimental-strip-types",
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      sdkOmittedProgram,
    ]);
    expect(stdout).toBe("CursorSdkNotInstalledError");
  });

  it.effect("treats only a missing @cursor/sdk as not installed", () =>
    Effect.gen(function* () {
      const omitted = yield* loadWith(requireWithMissingModule("@cursor/sdk")).pipe(Effect.flip);
      expect(omitted._tag).toBe("CursorSdkNotInstalledError");

      const broken = yield* loadWith(requireWithMissingModule("@connectrpc/connect")).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(broken) && Cause.hasDies(broken.cause)).toBe(true);
    }),
  );
});

describe("isCursorShellSpawnFailure", () => {
  it("matches only Cursor's shell wrapper", () => {
    const spawnFailure = (syscall: string, spawnargs: ReadonlyArray<string>) =>
      Object.assign(new Error(`${syscall} ENOENT`), { code: "ENOENT", syscall, spawnargs });
    expect(
      isCursorShellSpawnFailure(
        spawnFailure("spawn /bin/zsh", ["-c", "dump_zsh_state >&4", "--", "true"]),
      ),
    ).toBe(true);
    expect(
      isCursorShellSpawnFailure(spawnFailure("spawn bash", ["-c", "dump_bash_state >&4"])),
    ).toBe(true);
    expect(
      isCursorShellSpawnFailure(
        spawnFailure("spawn /bin/zsh", ["-c", 'builtin eval "${__CURSOR_SANDBOX_ENV_RESTORE:-}"']),
      ),
    ).toBe(true);
    expect(isCursorShellSpawnFailure(spawnFailure("spawn git", ["status"]))).toBe(false);
    expect(isCursorShellSpawnFailure(spawnFailure("spawn /bin/zsh", ["-lc", "true"]))).toBe(false);
    expect(
      isCursorShellSpawnFailure(
        Object.assign(new Error("open failed"), { code: "ENOENT", syscall: "open" }),
      ),
    ).toBe(false);
    expect(isCursorShellSpawnFailure(new Error("boom"))).toBe(false);
    expect(isCursorShellSpawnFailure("spawn ENOENT")).toBe(false);
  });
});

describe("Cursor shell spawn guard", () => {
  it("keeps the process alive when Cursor's shell spawn rejects", async () => {
    const result = await runProbe("cursor-shell");
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("The server will keep running.");
    expect(result.stderr).toContain("ENOENT");
  });

  it("still exits when a different spawn failure is unhandled", async () => {
    const result = await runProbe("other-spawn");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("spawn git ENOENT");
    expect(result.stderr).not.toContain("The server will keep running.");
  });

  it("still exits on unrelated unhandled rejections", async () => {
    const result = await runProbe("other-rejection");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("boom");
  });

  it("removes the guard when the layer is released", async () => {
    const result = await runProbe("released");
    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain("The server will keep running.");
  });

  it("leaves a spawn with no error listener fatal", async () => {
    const result = await runProbe("spawn-without-listener");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unhandled");
    expect(result.stderr).not.toContain("The server will keep running.");
  });
});

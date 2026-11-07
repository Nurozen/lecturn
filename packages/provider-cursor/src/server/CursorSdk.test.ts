// @effect-diagnostics nodeBuiltinImport:off -- The probe is a plain Node child.
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { describe, expect, vi } from "vite-plus/test";

import * as CursorSdk from "./CursorSdk.ts";

const cursorSdkUrl = new URL("./CursorSdk.ts", import.meta.url).href;

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

// Shaped like the SDK's minified class: the constructor is not named after the error.
class o extends Error {
  override name = "WriteIterableClosedError";
}

// Calls the guard directly, with Vitest's own listener detached so the guard does not defer to it.
const rejectThroughGuard = (reason: unknown) =>
  Effect.gen(function* () {
    const others = process.listeners("unhandledRejection");
    yield* Layer.build(CursorSdk.layer);
    const guard = process.listeners("unhandledRejection").find((l) => !others.includes(l));
    assert.isDefined(guard);
    using exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    using _log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const listener of others) process.off("unhandledRejection", listener);
    try {
      guard(reason, Promise.resolve());
    } finally {
      for (const listener of others) process.on("unhandledRejection", listener);
    }
    return exit.mock.calls;
  }).pipe(Effect.scoped);

describe("CursorSdk unhandled rejection guard", () => {
  it.effect("keeps the server running when the SDK writes to a closed stream", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* rejectThroughGuard(new o("WritableIterable is closed")), []);
    }),
  );

  it.effect("still exits on other rejections", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* rejectThroughGuard(new Error("WritableIterable is closed")), [
        [1],
      ]);
    }),
  );
});

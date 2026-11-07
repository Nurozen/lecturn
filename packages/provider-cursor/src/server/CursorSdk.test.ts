// @effect-diagnostics nodeBuiltinImport:off -- The probe is a plain Node child.
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

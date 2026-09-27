// @effect-diagnostics nodeBuiltinImport:off - Electron signing callback uses native filesystem path matching.
import { sign as signApplication, type SignOptions } from "@electron/osx-sign";
import * as NodePath from "node:path";
import { resolveExtensionsBinary } from "../apps/server/src/extensions/ExtensionsBinary.ts";

/** Preserve independently signed helper bytes; the enclosing bundle still seals them. */
export default async function sign(options: SignOptions): Promise<void> {
  const bundledRoot = NodePath.join(options.app, "Contents", "Resources", "extensions");
  const helpers = (
    await Promise.all(
      ["arm64", "x64"].map((architecture) =>
        resolveExtensionsBinary({ platform: "darwin", architecture, bundledRoot }),
      ),
    )
  ).filter((value) => value !== null);
  const originalIgnore = options.ignore;
  const wasIgnored = (file: string): boolean => {
    if (typeof originalIgnore === "function") return originalIgnore(file);
    const patterns =
      originalIgnore === undefined
        ? []
        : Array.isArray(originalIgnore)
          ? originalIgnore
          : [originalIgnore];
    return patterns.some((pattern) => file.match(pattern) !== null);
  };
  await signApplication({
    ...options,
    batchCodesignCalls: true,
    ...(helpers.length
      ? {
          ignore: (file: string) =>
            wasIgnored(file) ||
            helpers.some((helper) => NodePath.resolve(file) === NodePath.resolve(helper.path)),
        }
      : {}),
  });
  // Detect any signer/bundler that rewrote a pinned helper despite the exclusion.
  for (const architecture of ["arm64", "x64"])
    await resolveExtensionsBinary({ platform: "darwin", architecture, bundledRoot });
}

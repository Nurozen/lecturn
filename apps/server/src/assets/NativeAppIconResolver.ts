import * as NodeCrypto from "node:crypto";
import type { ToolActivityNativeAppReference } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as ServerConfig from "../config.ts";

const ICON_SIZE = 64;
const COMMAND_TIMEOUT = "5 seconds";
const RESOLUTION_CACHE_TTL_MS = 60 * 60 * 1000;
const RESOLUTION_CACHE_MAX_ENTRIES = 256;
const resolvedIconPathByApp = new Map<
  string,
  { readonly path: string | null; readonly expiresAt: number }
>();
const resolutionSemaphore = Semaphore.makeUnsafe(2);

function appCacheKey(cacheDirectory: string, app: ToolActivityNativeAppReference): string {
  const identity = app._tag === "app-id" ? `id:${app.appId}` : `name:${app.displayName}`;
  return `${cacheDirectory}\0${identity.toLowerCase()}`;
}

function cacheResolution(key: string, path: string | null, now: number): void {
  for (const [cachedKey, cached] of resolvedIconPathByApp) {
    if (cached.expiresAt <= now) resolvedIconPathByApp.delete(cachedKey);
  }
  resolvedIconPathByApp.delete(key);
  while (resolvedIconPathByApp.size >= RESOLUTION_CACHE_MAX_ENTRIES) {
    const oldestKey = resolvedIconPathByApp.keys().next().value;
    if (oldestKey === undefined) break;
    resolvedIconPathByApp.delete(oldestKey);
  }
  resolvedIconPathByApp.set(key, { path, expiresAt: now + RESOLUTION_CACHE_TTL_MS });
}

const existingFile = Effect.fn("NativeAppIconResolver.existingFile")(function* (filePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* fileSystem.stat(filePath).pipe(
    Effect.map(Option.some),
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(Option.none()) : Effect.fail(error),
    }),
  );
  return Option.isSome(info) && info.value.type === "File" ? filePath : null;
});

const commandOutput = Effect.fn("NativeAppIconResolver.commandOutput")(function* (
  command: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner
    .string(ChildProcess.make(command, args, { stdin: "ignore", stderr: "ignore" }))
    .pipe(Effect.timeout(COMMAND_TIMEOUT));
});

const plistValue = Effect.fn("NativeAppIconResolver.plistValue")(function* (
  infoPlistPath: string,
  key: string,
) {
  return yield* commandOutput("/usr/bin/plutil", [
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    infoPlistPath,
  ]).pipe(
    Effect.map((value) => value.trim()),
    Effect.orElseSucceed(() => ""),
  );
});

function escapeSpotlightString(value: string): string {
  return value.replace(/([\\'*?])/gu, "\\$1");
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

const resolveApplicationPath = Effect.fn("NativeAppIconResolver.resolveApplicationPath")(function* (
  app: ToolActivityNativeAppReference,
) {
  const path = yield* Path.Path;
  const query =
    app._tag === "app-id"
      ? `kMDItemCFBundleIdentifier == '${app.appId}'`
      : `kMDItemContentType == 'com.apple.application-bundle' && kMDItemDisplayName == '${escapeSpotlightString(app.displayName)}'`;
  const spotlightOutput = yield* commandOutput("/usr/bin/mdfind", [query]);
  const candidates = spotlightOutput
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter((value) => value.endsWith(".app"));
  const matchingCandidates =
    app._tag === "app-id"
      ? candidates
      : candidates.filter(
          (value) =>
            path.basename(value, ".app").toLocaleLowerCase() ===
            app.displayName.toLocaleLowerCase(),
        );
  const rankedCandidates = matchingCandidates.length > 0 ? matchingCandidates : candidates;
  let mostRecentlyUsed: { readonly path: string; readonly lastUsed: string } | null = null;
  for (const candidate of rankedCandidates) {
    const lastUsed = yield* commandOutput("/usr/bin/mdls", [
      "-raw",
      "-name",
      "kMDItemLastUsedDate",
      candidate,
    ]).pipe(
      Effect.map((value) => value.trim()),
      Effect.orElseSucceed(() => ""),
    );
    if (!mostRecentlyUsed || lastUsed > mostRecentlyUsed.lastUsed) {
      mostRecentlyUsed = { path: candidate, lastUsed };
    }
  }
  return mostRecentlyUsed?.path ?? null;
});

const resolveNativeAppIconUncached = Effect.fn("NativeAppIconResolver.resolveUncached")(function* (
  app: ToolActivityNativeAppReference,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const appPath = yield* resolveApplicationPath(app);
  if (!appPath) return null;

  const canonicalAppPath = yield* fileSystem.realPath(appPath);
  const infoPlistPath = path.join(canonicalAppPath, "Contents", "Info.plist");
  const resourcesDirectory = path.join(canonicalAppPath, "Contents", "Resources");
  const iconName =
    (yield* plistValue(infoPlistPath, "CFBundleIconFile")) ||
    (yield* plistValue(infoPlistPath, "CFBundleIconName"));
  if (iconName && path.basename(iconName) !== iconName) return null;
  const iconFileName = iconName ? (path.extname(iconName) ? iconName : `${iconName}.icns`) : null;
  const resourceEntries = yield* fileSystem
    .readDirectory(resourcesDirectory)
    .pipe(Effect.orElseSucceed(() => []));
  const sourceIconCandidate =
    (iconFileName ? yield* existingFile(path.join(resourcesDirectory, iconFileName)) : null) ??
    (yield* existingFile(path.join(resourcesDirectory, "AppIcon.icns"))) ??
    (resourceEntries.find((entry) => entry.toLowerCase().endsWith(".icns"))
      ? yield* existingFile(
          path.join(
            resourcesDirectory,
            resourceEntries.find((entry) => entry.toLowerCase().endsWith(".icns"))!,
          ),
        )
      : null);
  if (!sourceIconCandidate) return null;
  const sourceIconPath = yield* fileSystem.realPath(sourceIconCandidate);
  const relativeSource = path.relative(resourcesDirectory, sourceIconPath);
  if (
    relativeSource === ".." ||
    relativeSource.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeSource)
  ) {
    return null;
  }

  const appVersion =
    (yield* plistValue(infoPlistPath, "CFBundleVersion")) ||
    (yield* plistValue(infoPlistPath, "CFBundleShortVersionString"));
  const cacheKey = NodeCrypto.createHash("sha256")
    .update(`${canonicalAppPath}\0${appVersion}\0${sourceIconPath}`)
    .digest("hex");
  const cacheDirectory = path.join(config.providerStatusCacheDir, "native-app-icons");
  const cachePath = path.join(cacheDirectory, `${cacheKey}.png`);
  if (yield* existingFile(cachePath)) return cachePath;

  yield* fileSystem.makeDirectory(cacheDirectory, { recursive: true });
  const temporaryPath = path.join(
    cacheDirectory,
    `.${cacheKey}-${process.pid}-${(yield* Clock.currentTimeMillis).toString(36)}-${NodeCrypto.randomUUID()}.png`,
  );
  yield* commandOutput("/usr/bin/sips", [
    "-z",
    String(ICON_SIZE),
    String(ICON_SIZE),
    "-s",
    "format",
    "png",
    sourceIconPath,
    "--out",
    temporaryPath,
  ]).pipe(
    Effect.tap(() => fileSystem.rename(temporaryPath, cachePath)),
    Effect.ensuring(
      fileSystem.remove(temporaryPath).pipe(Effect.catchTags({ PlatformError: () => Effect.void })),
    ),
  );
  return yield* existingFile(cachePath);
});

/** Resolves and caches a macOS application icon without exposing host paths to clients. */
export const resolveNativeAppIcon = Effect.fn("NativeAppIconResolver.resolve")(function* (
  app: ToolActivityNativeAppReference,
) {
  if (
    (yield* HostProcessPlatform) !== "darwin" ||
    (app._tag === "display-name" && containsControlCharacter(app.displayName))
  ) {
    return null;
  }

  const config = yield* ServerConfig.ServerConfig;
  const resolvedAppCacheKey = appCacheKey(config.providerStatusCacheDir, app);
  const now = yield* Clock.currentTimeMillis;
  const cached = resolvedIconPathByApp.get(resolvedAppCacheKey);
  if (cached && cached.expiresAt > now) {
    if (cached.path === null) return null;
    if (yield* existingFile(cached.path)) return cached.path;
  }
  if (cached) resolvedIconPathByApp.delete(resolvedAppCacheKey);

  const availableResolution = yield* resolutionSemaphore.withPermitsIfAvailable(1)(
    resolveNativeAppIconUncached(app),
  );
  if (Option.isNone(availableResolution)) return null;

  const resolvedPath = availableResolution.value;
  cacheResolution(resolvedAppCacheKey, resolvedPath, now);
  return resolvedPath;
});

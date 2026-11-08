#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Host-side simulator and emulator automation uses Node subprocess and timing APIs directly.

import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import { PNG } from "pngjs";

import showcaseConfig, {
  type ShowcaseAppearance,
  type ShowcaseAndroidDevice,
  type ShowcaseConfig,
  type ShowcaseDevice,
  type ShowcaseIosDevice,
  type ShowcaseStoreAssetSpec,
  SHOWCASE_SCENES,
  type ShowcaseScene,
  SHOWCASE_THEMES,
  type ShowcaseTheme,
} from "./mobile-showcase.config.ts";
import {
  SHOWCASE_ENVIRONMENTS,
  SHOWCASE_PROJECTS,
  SHOWCASE_THREADS,
  seedShowcaseEnvironment,
} from "./mobile-showcase-environment.ts";

const REPO_ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const MOBILE_ROOT = NodePath.join(REPO_ROOT, "apps/mobile");
const ANDROID_PACKAGE = "com.cloudgatherer.lecturn";
const APP_SCHEME = "lecturn";
// expo-dev-launcher strips these off the launch URL and applies them to the dev
// menu before the app loads, keeping captures free of dev chrome. An iOS
// --initialUrl launch honors only the reserved __expo_ names.
const DEV_CLIENT_LAUNCH_FLAGS =
  "__expo_disable_onboarding=1&__expo_disable_fab=1&__expo_disable_auto_launch=1";
const IOS_READY_FILENAME = "LecturnShowcaseReadyScene";
const SERVER_HOST = "0.0.0.0";
const IOS_SIMULATOR_ARCH = NodeProcess.arch === "arm64" ? "arm64" : "x86_64";
const IOS_APP_PATH = NodePath.join(
  MOBILE_ROOT,
  ".showcase/ios-derived-data/Build/Products/Debug-iphonesimulator/Lecturn.app",
);
const ANDROID_APK_PATH = NodePath.join(
  MOBILE_ROOT,
  "android/app/build/outputs/apk/debug/app-debug.apk",
);
export function resolveAndroidSdkRoot(
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = NodeProcess.platform,
): string {
  const configured = environment.ANDROID_HOME ?? environment.ANDROID_SDK_ROOT;
  if (configured) return configured;
  const home = environment.HOME ?? environment.USERPROFILE ?? "";
  const path = platform === "win32" ? NodePath.win32 : NodePath.posix;
  return path.join(home, platform === "darwin" ? "Library/Android/sdk" : "Android/Sdk");
}

const ANDROID_SDK_ROOT = resolveAndroidSdkRoot(NodeProcess.env);
const MOBILE_BUILD_ENV = {
  ...NodeProcess.env,
  ANDROID_HOME: ANDROID_SDK_ROOT,
  APP_VARIANT: "production",
  EXPO_NO_GIT_STATUS: "1",
  // Metro resolves the runtime version for every launch manifest. Fingerprinting
  // the native project overruns the dev launcher's 10s manifest timeout on a
  // loaded CI host, which leaves the app on the launcher's home screen.
  MOBILE_VERSION_POLICY: "appVersion",
  // iPad self-rotation needs the capture build's fullscreen mode (app.config.ts).
  LECTURN_SHOWCASE_CAPTURE_BUILD: "1",
  JAVA_HOME:
    NodeProcess.env.JAVA_HOME ??
    (NodeProcess.platform === "darwin"
      ? "/Applications/Android Studio.app/Contents/jbr/Contents/Home"
      : undefined),
  NODE_ENV: "development",
};

interface CliOptions {
  readonly platforms: ReadonlySet<ShowcaseDevice["platform"]>;
  readonly deviceIds: ReadonlySet<string>;
  readonly scenes: ReadonlySet<ShowcaseScene>;
  readonly appearances: ReadonlySet<ShowcaseAppearance>;
  readonly themes: ReadonlySet<ShowcaseTheme>;
  readonly skipBuild: boolean;
  readonly skipMetro: boolean;
  readonly keepRunning: boolean;
  readonly validateOnly: boolean;
  readonly list: boolean;
}

export interface ShowcaseCapture {
  readonly device: ShowcaseDevice;
  readonly scenes: ReadonlyArray<ShowcaseScene>;
  readonly appearance: ShowcaseAppearance;
  readonly theme: ShowcaseTheme;
}

interface IosCaptureCleanup {
  readonly udid: string;
  readonly startedByRunner: boolean;
  readonly createdByRunner: boolean;
}

interface AndroidCaptureCleanup {
  readonly device: ShowcaseAndroidDevice;
  readonly serial: string;
  readonly startedByRunner: boolean;
}

interface NetworkAddress {
  readonly address: string;
  readonly family: string;
  readonly internal: boolean;
}

export function selectLanIpv4Address(addresses: ReadonlyArray<NetworkAddress>): string | null {
  return (
    addresses.find(
      ({ address, family, internal }) =>
        family === "IPv4" && !internal && !address.startsWith("169.254."),
    )?.address ?? null
  );
}

function lanIpv4Address(): string {
  const address = selectLanIpv4Address(
    Object.values(NodeOS.networkInterfaces()).flatMap((addresses) => addresses ?? []),
  );
  if (!address) {
    throw new Error("No LAN IPv4 address is available for the iOS Simulator to reach Metro.");
  }
  return address;
}

export interface PngMetadata {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
  readonly hasAlpha: boolean;
}

export function readPngMetadata(bytes: Uint8Array): PngMetadata {
  const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.byteLength < 26 || !pngSignature.every((value, index) => bytes[index] === value)) {
    throw new Error("Captured file is not a valid PNG.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const colorType = view.getUint8(25);
  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
    bitDepth: view.getUint8(24),
    colorType,
    hasAlpha: colorType === 4 || colorType === 6,
  };
}

export function readPngDimensions(bytes: Uint8Array): {
  readonly width: number;
  readonly height: number;
} {
  const { width, height } = readPngMetadata(bytes);
  return { width, height };
}

export function normalizeStorePng(bytes: Uint8Array): Buffer {
  const png = PNG.sync.read(Buffer.from(bytes));
  return PNG.sync.write(png, {
    bitDepth: 8,
    colorType: 2,
    inputColorType: 6,
    inputHasAlpha: true,
  });
}

export function validateStoreAsset(
  spec: ShowcaseStoreAssetSpec,
  bytes: Uint8Array,
  label = "Screenshot",
): PngMetadata {
  const metadata = readPngMetadata(bytes);
  if (metadata.width !== spec.width || metadata.height !== spec.height) {
    throw new Error(
      `${label} is ${metadata.width}×${metadata.height}; ${spec.store} requires ${spec.width}×${spec.height}.`,
    );
  }
  if (metadata.bitDepth !== 8 || metadata.colorType !== 2 || metadata.hasAlpha) {
    throw new Error(
      `${label} must be an 8-bit, 24-bit RGB PNG without alpha (found bit depth ${metadata.bitDepth}, color type ${metadata.colorType}).`,
    );
  }
  if (spec.maximumFileSizeBytes && bytes.byteLength > spec.maximumFileSizeBytes) {
    throw new Error(
      `${label} is ${bytes.byteLength} bytes; ${spec.store} allows at most ${spec.maximumFileSizeBytes} bytes.`,
    );
  }
  if (spec.store === "google-play") {
    const shortestSide = Math.min(metadata.width, metadata.height);
    const longestSide = Math.max(metadata.width, metadata.height);
    if (shortestSide < 320 || longestSide > 3_840 || longestSide > shortestSide * 2) {
      throw new Error(
        `${label} does not meet Google Play's 320–3,840 px bounds and 2:1 maximum aspect ratio.`,
      );
    }
    if (metadata.width * 16 !== metadata.height * 9) {
      throw new Error(`${label} must use Google Play's recommended portrait 9:16 aspect ratio.`);
    }
  }
  return metadata;
}

export function validateStoreAssetCount(
  spec: ShowcaseStoreAssetSpec,
  count: number,
  requireMinimum: boolean,
): void {
  if (count > spec.maximumUploadCount) {
    throw new Error(
      `${spec.directory} contains ${count} screenshots; ${spec.store} allows at most ${spec.maximumUploadCount}.`,
    );
  }
  if (requireMinimum && count < spec.minimumUploadCount) {
    throw new Error(
      `${spec.directory} contains ${count} screenshots; ${spec.store} requires at least ${spec.minimumUploadCount}.`,
    );
  }
}

export function showcaseCaptureDirectory(
  outputDirectory: string,
  capture: Pick<ShowcaseCapture, "device" | "appearance" | "theme">,
): string {
  return NodePath.join(
    outputDirectory,
    capture.device.storeAsset.directory,
    capture.appearance,
    capture.theme,
  );
}

async function finalizeCapture(destination: string, device: ShowcaseDevice): Promise<void> {
  const normalized = normalizeStorePng(await NodeFSP.readFile(destination));
  await NodeFSP.writeFile(destination, normalized);
  const metadata = validateStoreAsset(
    device.storeAsset,
    normalized,
    NodePath.basename(destination),
  );
  NodeProcess.stdout.write(
    `Captured ${NodePath.relative(REPO_ROOT, destination)} (${metadata.width}×${metadata.height}, 24-bit RGB, validated for ${device.storeAsset.store})\n`,
  );
}

async function validateCaptureSet(
  capture: ShowcaseCapture,
  outputDirectory: string,
  requireMinimum: boolean,
): Promise<void> {
  const directory = showcaseCaptureDirectory(outputDirectory, capture);
  const files = (await NodeFSP.readdir(directory)).filter((file) => file.endsWith(".png")).sort();
  const expectedFiles = capture.scenes.map((scene) => `${scene}.png`).sort();
  const missingFiles = expectedFiles.filter((file) => !files.includes(file));
  if (missingFiles.length > 0) {
    throw new Error(`${capture.device.id} is missing ${missingFiles.join(", ")} in ${directory}.`);
  }
  validateStoreAssetCount(capture.device.storeAsset, files.length, requireMinimum);
  for (const file of files) {
    const bytes = await NodeFSP.readFile(NodePath.join(directory, file));
    validateStoreAsset(capture.device.storeAsset, bytes, `${capture.device.id}/${file}`);
  }
  NodeProcess.stdout.write(
    `Validated ${files.length} upload-ready ${capture.device.storeAsset.store} screenshots in ${NodePath.relative(REPO_ROOT, directory)}/\n`,
  );
}

function argumentValue(args: ReadonlyArray<string>, index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

export function parseShowcaseCliArgs(args: ReadonlyArray<string>): CliOptions {
  const platforms = new Set<ShowcaseDevice["platform"]>();
  const deviceIds = new Set<string>();
  const scenes = new Set<ShowcaseScene>();
  const appearances = new Set<ShowcaseAppearance>();
  const themes = new Set<ShowcaseTheme>();
  let skipBuild = false;
  let skipMetro = false;
  let keepRunning = false;
  let validateOnly = false;
  let list = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--platform") {
      const value = argumentValue(args, index, argument);
      if (value !== "ios" && value !== "android" && value !== "all") {
        throw new Error(`Unsupported platform '${value}'. Use ios, android, or all.`);
      }
      if (value === "all") {
        platforms.add("ios");
        platforms.add("android");
      } else {
        platforms.add(value);
      }
      index += 1;
    } else if (argument === "--device") {
      deviceIds.add(argumentValue(args, index, argument));
      index += 1;
    } else if (argument === "--scene") {
      const value = argumentValue(args, index, argument);
      if (!SHOWCASE_SCENES.includes(value as ShowcaseScene)) {
        throw new Error(`Unsupported scene '${value}'. Use ${SHOWCASE_SCENES.join(", ")}.`);
      }
      scenes.add(value as ShowcaseScene);
      index += 1;
    } else if (argument === "--appearance") {
      const value = argumentValue(args, index, argument);
      if (value !== "light" && value !== "dark" && value !== "both") {
        throw new Error(`Unsupported appearance '${value}'. Use light, dark, or both.`);
      }
      if (value === "both") {
        appearances.add("light");
        appearances.add("dark");
      } else {
        appearances.add(value);
      }
      index += 1;
    } else if (argument === "--theme") {
      const value = argumentValue(args, index, argument);
      if (value === "all") {
        for (const theme of SHOWCASE_THEMES) themes.add(theme);
      } else if (SHOWCASE_THEMES.some((theme) => theme === value)) {
        themes.add(value as ShowcaseTheme);
      } else {
        // Unknown themes silently use the default palette; reject mislabeled captures.
        throw new Error(`Unsupported theme '${value}'. Use ${SHOWCASE_THEMES.join(", ")}, or all.`);
      }
      index += 1;
    } else if (argument === "--skip-build") {
      skipBuild = true;
    } else if (argument === "--skip-metro") {
      skipMetro = true;
    } else if (argument === "--keep-running") {
      keepRunning = true;
    } else if (argument === "--validate-only") {
      validateOnly = true;
    } else if (argument === "--list") {
      list = true;
    } else if (argument === "--help" || argument === "-h") {
      list = true;
    } else {
      throw new Error(`Unknown option '${argument}'.`);
    }
  }

  return {
    platforms,
    deviceIds,
    scenes,
    appearances,
    themes,
    skipBuild,
    skipMetro,
    keepRunning,
    validateOnly,
    list,
  };
}

export function planShowcaseCaptures(
  config: ShowcaseConfig,
  options: Pick<CliOptions, "platforms" | "deviceIds" | "scenes" | "appearances" | "themes">,
): ReadonlyArray<ShowcaseCapture> {
  const captures = config.devices
    .filter((device) => options.platforms.size === 0 || options.platforms.has(device.platform))
    .filter((device) => options.deviceIds.size === 0 || options.deviceIds.has(device.id))
    .flatMap((device) => {
      const appearances =
        options.appearances.size === 0 ? [device.appearance] : options.appearances;
      const themes = options.themes.size === 0 ? [device.theme] : options.themes;
      return [...appearances].flatMap((appearance) =>
        [...themes].map((theme) => ({
          device,
          appearance,
          theme,
          scenes:
            options.scenes.size === 0
              ? device.scenes
              : [...options.scenes].filter(
                  (scene) => scene === "pr-watch" || device.scenes.includes(scene),
                ),
        })),
      );
    })
    .filter((capture) => capture.scenes.length > 0);

  const knownDeviceIds = new Set(config.devices.map((device) => device.id));
  for (const id of options.deviceIds) {
    if (!knownDeviceIds.has(id)) {
      throw new Error(`Unknown device '${id}'. Run with --list to see configured devices.`);
    }
  }
  if (captures.length === 0) {
    throw new Error("No captures match the selected platform, device, and scene filters.");
  }
  return captures;
}

function printUsage(config: ShowcaseConfig): void {
  NodeProcess.stdout.write(`App screenshot showcase

Usage:
  pnpm --filter @lecturn/mobile screenshots [options]

Options:
  --platform ios|android|all  Capture one platform (repeatable)
  --device <id>              Capture one configured device (repeatable)
  --scene <name>             Capture one scene (repeatable)
  --appearance light|dark|both
                             Override the configured appearance
  --theme <id>|all           Override the configured palette (repeatable)
  --skip-build               Reuse the existing simulator app / debug APK
  --skip-metro               Reuse an already running showcase Metro server
  --keep-running             Leave devices and Metro running after capture
  --validate-only            Validate existing upload assets without capturing
  --list                     Print this help and the configured matrix

Scenes: ${SHOWCASE_SCENES.join(", ")}
Themes: ${SHOWCASE_THEMES.join(", ")}

Configured devices:
${config.devices
  .map((device) => {
    const target = device.platform === "ios" ? device.simulator : device.avd;
    return `  ${device.id.padEnd(18)} ${device.platform.padEnd(8)} ${target} -> ${device.storeAsset.directory}/{light|dark}/<theme> (${device.storeAsset.width}×${device.storeAsset.height}, default ${device.appearance} ${device.theme}) [${device.scenes.join(", ")}]`;
  })
  .join("\n")}
`);
}

function spawnProcess(
  command: string,
  args: ReadonlyArray<string>,
  options: NodeChildProcess.SpawnOptions = {},
): NodeChildProcess.ChildProcess {
  return NodeChildProcess.spawn(command, args, {
    cwd: REPO_ROOT,
    env: NodeProcess.env,
    stdio: "inherit",
    ...options,
  });
}

async function runCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: NodeChildProcess.SpawnOptions = {},
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnProcess(command, args, options);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `${command} ${args.join(" ")} failed ${signal ? `with signal ${signal}` : `with code ${String(code)}`}.`,
          ),
        );
      }
    });
  });
}

async function commandOutput(
  command: string,
  args: ReadonlyArray<string>,
  options: NodeChildProcess.ExecFileOptions = {},
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    NodeChildProcess.execFile(
      command,
      [...args],
      { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, ...options },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(String(stdout));
      },
    );
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function stopProcess(child: NodeChildProcess.ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  child.kill("SIGTERM");
  await Promise.race([exited, delay(5_000)]);
  if (child.exitCode !== null || child.signalCode !== null) return;

  child.kill("SIGKILL");
  await Promise.race([exited, delay(1_000)]);
}

export async function waitForPort(
  port: number,
  label = "Process",
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = NodeNet.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
      socket.setTimeout(500, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (open) return;
    await delay(500);
  }
  throw new Error(`${label} did not begin listening on port ${port} within ${timeoutMs}ms.`);
}

async function waitForFileContent(
  filePath: string,
  label: string,
  timeoutMs = 60_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const content = await NodeFSP.readFile(filePath, "utf8").then(
      (value) => value.trim(),
      () => "",
    );
    if (content) return content;
    await delay(250);
  }
  throw new Error(`${label} was not written to ${filePath} within ${timeoutMs}ms.`);
}

export async function reserveAvailablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a local port for the showcase environment."));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function createShowcaseShell(baseDir: string): Promise<string> {
  const shellPath = NodePath.join(baseDir, "showcase-shell");
  await NodeFSP.writeFile(
    shellPath,
    `#!/bin/sh
if [ "$1" = "-ilc" ] || [ "$1" = "-lic" ]; then
  exec /bin/sh -c "$2"
fi
exec /bin/cat
`,
    { mode: 0o755 },
  );
  return shellPath;
}

async function createShowcaseLabelProbe(baseDir: string, label: string): Promise<string> {
  const binDirectory = NodePath.join(baseDir, "showcase-bin");
  await NodeFSP.mkdir(binDirectory, { recursive: true });
  const probeScript = `#!/bin/sh
if [ "$1" = "--get" ] && [ "$2" = "ComputerName" ]; then
  printf '%s\\n' ${JSON.stringify(label)}
  exit 0
fi
if [ "$1" = "--pretty" ]; then
  printf '%s\\n' ${JSON.stringify(label)}
  exit 0
fi
exit 1
`;
  await Promise.all(
    ["scutil", "hostnamectl"].map((executable) =>
      NodeFSP.writeFile(NodePath.join(binDirectory, executable), probeScript, { mode: 0o755 }),
    ),
  );
  return binDirectory;
}

function startShowcaseServer(
  baseDir: string,
  workspaceRoot: string,
  port: number,
  shellPath: string,
  labelProbeDirectory: string,
): NodeChildProcess.ChildProcess {
  return spawnProcess(
    "node",
    [
      "apps/server/src/bin.ts",
      "serve",
      "--host",
      SERVER_HOST,
      "--port",
      String(port),
      "--base-dir",
      baseDir,
      "--no-browser",
      "--log-level",
      "error",
      workspaceRoot,
    ],
    {
      env: {
        ...NodeProcess.env,
        PATH: `${labelProbeDirectory}:${NodeProcess.env.PATH ?? ""}`,
        SHELL: shellPath,
      },
    },
  );
}

export interface ShowcaseEnvironment {
  readonly baseDir: string;
  readonly environmentId: string;
  readonly label: string;
  readonly port: number;
  /** Restarts the seeded server on the same port and base dir. */
  readonly start: () => NodeChildProcess.ChildProcess;
}

/** Boot one seeded fixture server per showcase environment; `track` receives every spawned server. */
export async function startShowcaseEnvironments(
  rootDir: string,
  track: (server: NodeChildProcess.ChildProcess) => void,
  environments: ReadonlyArray<(typeof SHOWCASE_ENVIRONMENTS)[number]> = SHOWCASE_ENVIRONMENTS,
): Promise<ShowcaseEnvironment[]> {
  const started: ShowcaseEnvironment[] = [];
  for (const environment of environments) {
    const projectId = environment.projectIds[0];
    const project = SHOWCASE_PROJECTS.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error(`Showcase environment '${environment.id}' has no project.`);

    const baseDir = NodePath.join(rootDir, "environments", environment.id);
    const workspaceRoot = NodePath.join(baseDir, "workspace", project.directory);
    const port = await reserveAvailablePort();
    await NodeFSP.mkdir(workspaceRoot, { recursive: true });
    const shellPath = await createShowcaseShell(baseDir);
    const labelProbeDirectory = await createShowcaseLabelProbe(baseDir, environment.label);
    const server = startShowcaseServer(
      baseDir,
      workspaceRoot,
      port,
      shellPath,
      labelProbeDirectory,
    );
    track(server);
    await waitForPort(port, `${environment.label} server`);
    await seedShowcaseEnvironment({ baseDir, projectIds: environment.projectIds });
    // Legacy fixture threads are imported into V2 during server startup.
    await stopProcess(server);
    const start = () =>
      startShowcaseServer(baseDir, workspaceRoot, port, shellPath, labelProbeDirectory);
    track(start());
    await waitForPort(port, `${environment.label} seeded server`);
    // The server begins listening before the ServerEnvironment layer
    // persists the environment id, so poll rather than read once.
    const environmentId = await waitForFileContent(
      NodePath.join(baseDir, "userdata", "environment-id"),
      `${environment.label} environment id`,
    );
    started.push({ baseDir, environmentId, label: environment.label, port, start });
  }
  // Capture-only (batch-001704 AFTER): Moonbase Terminal links to the other two fixture servers (#16698).
  const [primary, ...peers] = started;
  if (primary) {
    try {
      const database = new NodeSqlite.DatabaseSync(
        NodePath.join(primary.baseDir, "userdata", "statev2.sqlite"),
        { timeout: 30_000 },
      );
      const now = Date.now();
      const insert = database.prepare(
        `INSERT OR REPLACE INTO peer_environment_links (
          environment_id, secret_name, label, urls_json, access, linked_at, expires_at,
          last_reached_at, last_error, fenced
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)`,
      );
      for (const [index, peer] of peers.entries()) {
        insert.run(
          peer.environmentId,
          `showcase-peer-link-${index}`,
          peer.label,
          JSON.stringify([`http://127.0.0.1:${peer.port}/`]),
          index === 0 ? "approval-required" : "read-only",
          new Date(now - 2 * 86_400_000).toISOString(),
          new Date(now + (index === 0 ? 28 : 3) * 86_400_000).toISOString(),
          new Date(now - 60_000).toISOString(),
        );
      }
      database.close();
      NodeProcess.stdout.write(`showcase peer links seeded: ${peers.length}\n`);
    } catch (error) {
      NodeProcess.stdout.write(`showcase peer links not seeded: ${String(error)}\n`);
    }
  }
  return started;
}

export function parsePairingCredentialOutput(output: string): string {
  const jsonStart = output.indexOf("{");
  const jsonEnd = output.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd < jsonStart) {
    throw new Error("Pairing credential command did not return JSON.");
  }
  const parsed = JSON.parse(output.slice(jsonStart, jsonEnd + 1)) as {
    readonly credential?: unknown;
  };
  if (typeof parsed.credential !== "string" || parsed.credential.length === 0) {
    throw new Error("Pairing credential command returned no credential.");
  }
  return parsed.credential;
}

export async function issuePairingCredential(baseDir: string): Promise<string> {
  const output = await commandOutput(
    "node",
    // Outlives a slow first launch; the default five minutes can lapse before the
    // app first runs JS, and it then retries a rejected credential forever.
    [
      "apps/server/src/bin.ts",
      "auth",
      "pairing",
      "create",
      "--base-dir",
      baseDir,
      "--ttl",
      "1h",
      "--json",
    ],
    { env: { ...NodeProcess.env, NO_COLOR: "1" } },
  );
  return parsePairingCredentialOutput(output);
}

export function buildShowcasePairingUrl(host: string, port: number, credential: string): string {
  const url = new URL(`http://${host}:${port}/`);
  url.hash = new URLSearchParams([["token", credential]]).toString();
  return url.toString();
}

export function encodeAndroidPairingUrls(pairingUrls: ReadonlyArray<string>): string {
  return `json-uri:${encodeURIComponent(JSON.stringify(pairingUrls))}`;
}

function startMetro(config: ShowcaseConfig): NodeChildProcess.ChildProcess {
  return spawnProcess(
    "pnpm",
    ["exec", "expo", "start", "--dev-client", "--port", String(config.metroPort)],
    {
      cwd: MOBILE_ROOT,
      env: {
        ...MOBILE_BUILD_ENV,
        // Each lazy chunk is its own Metro graph, built on demand while the app
        // starts, which starves the showcase servers on a small CI host.
        EXPO_NO_METRO_LAZY: "1",
        EXPO_PUBLIC_SHOWCASE: "1",
      },
    },
  );
}

async function fetchMetroManifest(
  platform: ShowcaseDevice["platform"],
  host: string,
  config: ShowcaseConfig,
  timeoutMs: number,
): Promise<unknown> {
  const manifest = await commandOutput("curl", [
    "--fail",
    "--silent",
    "--show-error",
    "--max-time",
    String(timeoutMs / 1_000),
    "--header",
    "accept: application/expo+json,application/json",
    "--header",
    `expo-platform: ${platform}`,
    `http://${host}:${config.metroPort}/`,
  ]);
  return JSON.parse(manifest);
}

export function manifestBundleUrl(manifest: unknown): string {
  const url = (manifest as { readonly launchAsset?: { readonly url?: unknown } } | null)
    ?.launchAsset?.url;
  if (typeof url !== "string" || url.length === 0) {
    throw new Error("Metro manifest has no launch asset URL.");
  }
  return url;
}

// Warms the bundle URL the dev client actually loads. Metro builds a separate
// graph for any other query, which the device would then wait on.
async function warmMetroBundle(
  platform: ShowcaseDevice["platform"],
  host: string,
  config: ShowcaseConfig,
): Promise<void> {
  const url = manifestBundleUrl(await fetchMetroManifest(platform, host, config, 120_000));
  await runCommand("curl", ["--fail", "--silent", "--show-error", "--output", "/dev/null", url]);
}

// The dev launcher gives up after two 10s manifest requests. A freshly booted
// simulator can starve Metro for minutes, so launch once Metro answers quickly.
async function waitForResponsiveMetro(host: string, config: ShowcaseConfig): Promise<void> {
  const deadline = Date.now() + 600_000;
  while (
    !(await fetchMetroManifest("ios", host, config, 5_000).then(
      () => true,
      () => false,
    ))
  ) {
    if (Date.now() > deadline) {
      throw new Error("Metro did not answer a manifest request within 5s for 10 minutes.");
    }
    await delay(5_000);
  }
}

async function buildIos(): Promise<string> {
  const derivedData = NodePath.join(MOBILE_ROOT, ".showcase/ios-derived-data");
  await runCommand("pnpm", ["exec", "expo", "prebuild", "--clean", "--platform", "ios"], {
    cwd: MOBILE_ROOT,
    env: MOBILE_BUILD_ENV,
  });
  await runCommand(
    "xcodebuild",
    [
      "-workspace",
      NodePath.join(MOBILE_ROOT, "ios/Lecturn.xcworkspace"),
      "-scheme",
      "Lecturn",
      "-configuration",
      "Debug",
      "-sdk",
      "iphonesimulator",
      "-derivedDataPath",
      derivedData,
      "-quiet",
      `ARCHS=${IOS_SIMULATOR_ARCH}`,
      "ONLY_ACTIVE_ARCH=YES",
      "build",
    ],
    { cwd: MOBILE_ROOT, env: MOBILE_BUILD_ENV },
  );
  return IOS_APP_PATH;
}

async function buildAndroid(abis: ReadonlyArray<string>): Promise<string> {
  await runCommand("pnpm", ["exec", "expo", "prebuild", "--clean", "--platform", "android"], {
    cwd: MOBILE_ROOT,
    env: MOBILE_BUILD_ENV,
  });
  await runCommand(
    "./gradlew",
    [
      "app:assembleDebug",
      ...(abis.length > 0 ? [`-PreactNativeArchitectures=${abis.join(",")}`] : []),
    ],
    {
      cwd: NodePath.join(MOBILE_ROOT, "android"),
      env: MOBILE_BUILD_ENV,
    },
  );
  return ANDROID_APK_PATH;
}

async function existingArtifact(path: string): Promise<string | null> {
  return await NodeFSP.access(path).then(
    () => path,
    () => null,
  );
}

interface SimctlDevice {
  readonly name: string;
  readonly udid: string;
  readonly state: "Booted" | "Shutdown" | string;
  readonly isAvailable: boolean;
}

async function findIosSimulator(name: string): Promise<SimctlDevice | null> {
  const parsed = JSON.parse(
    await commandOutput("xcrun", ["simctl", "list", "devices", "available", "-j"]),
  ) as {
    readonly devices: Readonly<Record<string, ReadonlyArray<SimctlDevice>>>;
  };
  const candidates = Object.entries(parsed.devices)
    .filter(([runtime]) => runtime.includes("iOS"))
    .flatMap(([, devices]) => devices)
    .filter((device) => device.isAvailable && device.name === name);
  return candidates.at(-1) ?? null;
}

async function ensureIosSimulator(device: ShowcaseIosDevice): Promise<{
  readonly simulator: SimctlDevice;
  readonly createdByRunner: boolean;
}> {
  const existing = await findIosSimulator(device.simulator);
  if (existing) return { simulator: existing, createdByRunner: false };
  if (!device.simulatorDeviceType) {
    throw new Error(
      `iOS simulator '${device.simulator}' is not installed and has no simulatorDeviceType configured.`,
    );
  }
  const udid = (
    await commandOutput("xcrun", ["simctl", "create", device.simulator, device.simulatorDeviceType])
  ).trim();
  if (!udid) throw new Error(`Could not create iOS simulator '${device.simulator}'.`);
  return {
    simulator: {
      name: device.simulator,
      udid,
      state: "Shutdown",
      isAvailable: true,
    },
    createdByRunner: true,
  };
}

async function iosSimulatorDataPath(udid: string): Promise<string> {
  const parsed = JSON.parse(await commandOutput("xcrun", ["simctl", "list", "devices", "-j"])) as {
    readonly devices: Readonly<
      Record<string, ReadonlyArray<SimctlDevice & { readonly dataPath: string }>>
    >;
  };
  const dataPath = Object.values(parsed.devices)
    .flat()
    .find((device) => device.udid === udid)?.dataPath;
  if (!dataPath) throw new Error(`Could not resolve the data path of iOS simulator ${udid}.`);
  return dataPath;
}

// Apple Intelligence posts persistent first-boot banners; mark readiness and clear queued CoreFollowUp notices.
async function suppressIosSystemFollowUps(udid: string): Promise<void> {
  const dataPath = await iosSimulatorDataPath(udid);
  const preferences = NodePath.join(dataPath, "Library/Preferences");
  await NodeFSP.mkdir(preferences, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(preferences, "com.apple.generativeexperiences.corefollowup.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>DateOfLastAppleIntelligenceReadinessCFU</key>
\t<date>2020-01-01T00:00:00Z</date>
</dict>
</plist>
`,
  );
  await NodeFSP.rm(NodePath.join(dataPath, "Library/CoreFollowUp"), {
    recursive: true,
    force: true,
  });
}

async function normalizeIosSimulator(appearance: ShowcaseAppearance, udid: string): Promise<void> {
  await runCommand("xcrun", ["simctl", "ui", udid, "appearance", appearance]);
  // Disable always-on dimming so lock-screen wake can distinguish off from fully lit.
  await runCommand("xcrun", [
    "simctl",
    "spawn",
    udid,
    "defaults",
    "write",
    "com.apple.springboard",
    "SBEnableAlwaysOn",
    "-bool",
    "false",
  ]);
  await runCommand("xcrun", [
    "simctl",
    "status_bar",
    udid,
    "override",
    "--time",
    "9:41",
    "--batteryState",
    "charged",
    "--batteryLevel",
    "100",
    "--wifiBars",
    "3",
    "--cellularBars",
    "4",
  ]);
}

// iPadOS 26 windowing forces fullscreen apps into portrait, defeating capture-build rotation.
async function ensureIosFullScreenAppsMode(udid: string): Promise<void> {
  const current = await commandOutput("xcrun", [
    "simctl",
    "spawn",
    udid,
    "defaults",
    "read",
    "com.apple.springboard",
    "SBChamoisWindowingEnabled",
  ]).catch(() => "");
  if (current.trim() === "0") return;
  // Fresh devices honor the Settings toggle only when all three keys are written.
  for (const key of [
    "SBChamoisWindowingEnabled",
    "SBMedusaMultitaskingEnabled",
    "SBFlexibleWindowingPreviouslyEnabledAutomaticStageCreation",
  ]) {
    await runCommand("xcrun", [
      "simctl",
      "spawn",
      udid,
      "defaults",
      "write",
      "com.apple.springboard",
      key,
      "-bool",
      "false",
    ]);
  }
  // New simulators require a reboot, not just SpringBoard restart, before windowing settings take effect.
  await runCommand("xcrun", ["simctl", "shutdown", udid]);
  await runCommand("xcrun", ["simctl", "boot", udid]);
  await runCommand("xcrun", ["simctl", "bootstatus", udid, "-b"]);
  const applied = await commandOutput("xcrun", [
    "simctl",
    "spawn",
    udid,
    "defaults",
    "read",
    "com.apple.springboard",
    "SBChamoisWindowingEnabled",
  ]).catch(() => "");
  if (applied.trim() !== "0") {
    throw new Error(`Simulator ${udid} did not switch to Full Screen Apps mode.`);
  }
}

async function iosAppContainer(udid: string): Promise<string> {
  return (
    await commandOutput("xcrun", ["simctl", "get_app_container", udid, ANDROID_PACKAGE, "data"])
  ).trim();
}

async function waitForIosShowcaseScene(
  udid: string,
  scene: ShowcaseScene,
  timeoutMs = 300_000,
): Promise<void> {
  const readyPath = NodePath.join(
    await iosAppContainer(udid),
    "Library/Caches",
    IOS_READY_FILENAME,
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const readyScene = await NodeFSP.readFile(readyPath, "utf8").catch(() => "");
    if (readyScene.trim() === scene) return;
    await delay(500);
  }
  throw new Error(`iOS showcase scene '${scene}' did not render within ${timeoutMs}ms.`);
}

function iosAxe(): string {
  return NodeProcess.env.AXE_PATH ?? "axe";
}

async function iosDevLauncherVisible(udid: string): Promise<boolean> {
  const ui = await commandOutput(iosAxe(), ["describe-ui", "--udid", udid]).catch(() => "");
  return ui.includes("Enter URL manually");
}

/**
 * A bounded failure receipt for hosted runs, where the simulator is gone once
 * the job ends: what the screen showed, its accessibility tree, the app log,
 * and what the host was busy with.
 */
async function collectIosDiagnostics(udid: string, label: string): Promise<void> {
  const directory = NodeProcess.env.LECTURN_SHOWCASE_DIAGNOSTICS_DIR;
  if (!directory) return;
  await NodeFSP.mkdir(directory, { recursive: true });
  const record = async (file: string, output: Promise<string>) => {
    const text = await output.catch((error: unknown) => `failed: ${String(error)}`);
    await NodeFSP.writeFile(NodePath.join(directory, `${label}-${file}`), text.slice(-1_000_000));
  };
  await runCommand("xcrun", [
    "simctl",
    "io",
    udid,
    "screenshot",
    NodePath.join(directory, `${label}-screen.png`),
  ]).catch(() => undefined);
  await record("ui.json", commandOutput(iosAxe(), ["describe-ui", "--udid", udid]));
  await record(
    "app.log",
    commandOutput(
      "xcrun",
      [
        "simctl",
        "spawn",
        udid,
        "log",
        "show",
        "--last",
        "10m",
        "--style",
        "compact",
        "--predicate",
        'process == "Lecturn"',
      ],
      { maxBuffer: 256 * 1024 * 1024 },
    ),
  );
  await record("host.txt", commandOutput("ps", ["-axo", "pid,pcpu,rss,command", "-r"]));
}

// Error states a scene can settle on when a request timed out on a starved host.
const SHOWCASE_STALL_TEXTS = [
  "Reconnecting",
  "Could not check terminal access",
  "Review unavailable",
  "timed out after",
] as const;

export function showcaseStallText(accessibilityTree: string): string | null {
  return SHOWCASE_STALL_TEXTS.find((text) => accessibilityTree.includes(text)) ?? null;
}

async function iosStallText(udid: string, scene: ShowcaseScene): Promise<string | null> {
  // The lock screen is not the app, and an accessibility query there can
  // disturb the lit, locked state the capture needs.
  if (scene === "agent-activity") return null;
  const ui = await commandOutput(iosAxe(), ["describe-ui", "--udid", udid]).catch(() => "");
  return showcaseStallText(ui);
}

export function screenshotsMatch(first: Uint8Array, second: Uint8Array): boolean {
  const a = PNG.sync.read(Buffer.from(first));
  const b = PNG.sync.read(Buffer.from(second));
  if (a.width !== b.width || a.height !== b.height) return false;
  let differing = 0;
  let sampled = 0;
  for (let offset = 0; offset < a.data.length; offset += 4 * 97) {
    sampled += 1;
    const delta =
      Math.abs((a.data[offset] ?? 0) - (b.data[offset] ?? 0)) +
      Math.abs((a.data[offset + 1] ?? 0) - (b.data[offset + 1] ?? 0)) +
      Math.abs((a.data[offset + 2] ?? 0) - (b.data[offset + 2] ?? 0));
    if (delta > 48) differing += 1;
  }
  return differing / sampled < 0.005;
}

async function runAxe(udid: string, args: ReadonlyArray<string>): Promise<void> {
  // HID events sent right after the simulator settles are dropped without it.
  await runCommand(iosAxe(), [...args, "--udid", udid], {
    env: { ...NodeProcess.env, AXE_HID_STABILIZATION_MS: "3000" },
  }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        "The agent-activity scene drives the simulator with AXe. Install it with `brew tap cameroncooke/axe && brew install axe`, or set AXE_PATH.",
      );
    }
    throw error;
  });
}

async function iosSimulatorLocked(udid: string): Promise<boolean> {
  const state = await commandOutput("xcrun", [
    "simctl",
    "spawn",
    udid,
    "notifyutil",
    "-g",
    "com.apple.springboard.lockstate",
  ]).catch(() => "");
  return state.trim().endsWith(" 1");
}

// simctl has no notification privacy service; answer the staging app's prompt until ready.
async function allowIosNotificationsUntilReady(udid: string, ready: Promise<void>): Promise<void> {
  const state = { settled: false };
  const tapping = (async () => {
    while (!state.settled) {
      await runAxe(udid, ["tap", "--label", "Allow"]).catch(() => undefined);
      if (!state.settled) await delay(1_000);
    }
  })();
  try {
    await ready;
  } finally {
    state.settled = true;
    await tapping;
  }
}

async function presentIosLockScreen(udid: string): Promise<void> {
  // A wake press that lands after the display already lit unlocks the device
  // instead (hosted run 42429542509 captured the thread list), so verify the
  // device is still locked and present the lock screen again once if not.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await runAxe(udid, ["button", "lock"]);
    const deadline = Date.now() + 15_000;
    while (!(await iosSimulatorLocked(udid))) {
      if (Date.now() > deadline) throw new Error(`Simulator ${udid} did not lock.`);
      await delay(500);
    }
    const alert = showcaseAgentAlert();
    await new Promise<void>((resolve, reject) => {
      const child = NodeChildProcess.execFile(
        "xcrun",
        ["simctl", "push", udid, ANDROID_PACKAGE, "-"],
        { cwd: REPO_ROOT },
        (error) => (error ? reject(error) : resolve()),
      );
      child.stdin?.end(
        JSON.stringify({
          aps: { alert: { title: alert.title, body: alert.body }, sound: "default" },
        }),
      );
    });
    await wakeIosLockScreen(udid);
    // The first Live Activity on the lock screen asks to keep allowing them.
    await delay(2_000);
    await runAxe(udid, ["tap", "--label", "Allow"]).catch(() => undefined);
    if (await iosSimulatorLocked(udid)) return;
  }
  throw new Error(`Simulator ${udid} unlocked while presenting the lock screen.`);
}

/**
 * Press home only if screenshots prove the lock screen stayed dark; a lit
 * display would unlock instead. On a loaded host it can take seconds to light.
 */
async function wakeIosLockScreen(udid: string): Promise<void> {
  const probe = NodePath.join(NodeOS.tmpdir(), `lecturn-showcase-wake-${udid}.png`);
  const lit = async () => {
    await runCommand("xcrun", ["simctl", "io", udid, "screenshot", probe]);
    return !pngIsBlack(await NodeFSP.readFile(probe));
  };
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      for (let check = 0; check < 4; check += 1) {
        await delay(2_000);
        if (await lit()) return;
      }
      await runAxe(udid, ["button", "home"]);
    }
    throw new Error(`Simulator ${udid} lock screen stayed dark.`);
  } finally {
    await NodeFSP.rm(probe, { force: true });
  }
}

function pngIsBlack(bytes: Uint8Array): boolean {
  const { data } = PNG.sync.read(Buffer.from(bytes));
  for (let offset = 0; offset < data.length; offset += 4 * 997) {
    if ((data[offset] ?? 0) > 8 || (data[offset + 1] ?? 0) > 8 || (data[offset + 2] ?? 0) > 8) {
      return false;
    }
  }
  return true;
}

async function unlockIosSimulator(udid: string): Promise<void> {
  await runAxe(udid, ["button", "home"]);
  await delay(2_000);
  await runAxe(udid, ["button", "home"]);
}

function showcaseAgentAlert(): { readonly title: string; readonly body: string } {
  const thread = SHOWCASE_THREADS.find((candidate) => candidate.id === "pocket-command-center");
  const project = SHOWCASE_PROJECTS.find((candidate) => candidate.id === thread?.projectId);
  if (!thread || !project) throw new Error("The showcase fixture lost its agent-activity thread.");
  return { title: thread.title, body: `Approval: ${project.title}` };
}

async function captureIos(
  capture: ShowcaseCapture & { readonly device: ShowcaseIosDevice },
  appPath: string | null,
  outputDirectory: string,
  config: ShowcaseConfig,
  metroHost: string,
  issuePairingUrls: () => Promise<ReadonlyArray<string>>,
  registerCleanup: (cleanup: IosCaptureCleanup) => void,
): Promise<void> {
  const { simulator, createdByRunner } = await ensureIosSimulator(capture.device);
  const startedByRunner = simulator.state !== "Booted";
  registerCleanup({ udid: simulator.udid, startedByRunner, createdByRunner });
  if (!startedByRunner) {
    await runCommand("xcrun", ["simctl", "shutdown", simulator.udid]);
  }
  await suppressIosSystemFollowUps(simulator.udid);
  await runCommand("xcrun", ["simctl", "boot", simulator.udid]);
  await runCommand("xcrun", ["simctl", "bootstatus", simulator.udid, "-b"]);
  if (capture.device.orientation === "landscape") {
    await ensureIosFullScreenAppsMode(simulator.udid);
  }
  if (capture.device.fold) {
    const command = NodeProcess.env.AGENT_DEVICE_PATH ?? "agent-device";
    const target = [
      "--platform",
      "ios",
      "--udid",
      simulator.udid,
      "--session",
      `showcase-${simulator.udid}`,
    ];
    await runCommand(command, ["open", ...target]);
    try {
      await runCommand(command, ["fold", capture.device.fold, ...target]);
    } finally {
      await runCommand(command, ["close", ...target]);
    }
  }
  await normalizeIosSimulator(capture.appearance, simulator.udid);
  if (appPath) {
    await runCommand("xcrun", ["simctl", "uninstall", simulator.udid, ANDROID_PACKAGE]).catch(
      () => undefined,
    );
    await runCommand("xcrun", ["simctl", "install", simulator.udid, appPath]);
  }

  const metroUrl = `http://${metroHost}:${config.metroPort}?${DEV_CLIENT_LAUNCH_FLAGS}`;
  const scenePath = NodePath.join(
    await iosAppContainer(simulator.udid),
    "Library/Caches/LecturnShowcaseScene",
  );
  const readyPath = NodePath.join(
    await iosAppContainer(simulator.udid),
    "Library/Caches",
    IOS_READY_FILENAME,
  );
  const firstScene = capture.scenes[0] ?? "threads";
  const launchShowcaseApp = async (terminateRunningProcess: boolean) => {
    const pairingUrls = await issuePairingUrls();
    await waitForResponsiveMetro(metroHost, config);
    await runCommand("xcrun", [
      "simctl",
      "launch",
      ...(terminateRunningProcess ? ["--terminate-running-process"] : []),
      simulator.udid,
      ANDROID_PACKAGE,
      "--initialUrl",
      metroUrl,
      "--showcasePairingUrl",
      JSON.stringify(pairingUrls),
      "--showcaseScene",
      firstScene,
      "--showcaseTheme",
      capture.theme,
      // Simulator rotation UI scripting needs Accessibility permission unavailable on CI.
      "--showcaseOrientation",
      capture.device.orientation ?? "portrait",
    ]);
  };
  await NodeFSP.rm(readyPath, { force: true });
  await NodeFSP.writeFile(scenePath, firstScene);
  await launchShowcaseApp(false);
  for (const [sceneIndex, scene] of capture.scenes.entries()) {
   try {
    if (sceneIndex > 0) await NodeFSP.rm(readyPath, { force: true });
    await NodeFSP.writeFile(scenePath, scene);
    const waitForScene = (timeoutMs?: number) => {
      const ready = waitForIosShowcaseScene(simulator.udid, scene, timeoutMs);
      return scene === "agent-activity"
        ? allowIosNotificationsUntilReady(simulator.udid, ready)
        : ready;
    };
    if (sceneIndex === 0) {
      // A first launch can strand itself (the dev launcher gives up on a slow manifest, or a slow
      // server spends the one-time pairing credential after the app's 10s timeout), and only a
      // relaunch with fresh credentials recovers. Killing a still-loading launch sends it back to
      // the launcher, so relaunch only once it has given up.
      const deadline = Date.now() + 900_000;
      let launchedAt = Date.now();
      let relaunches = 0;
      while (
        !(await waitForScene(15_000).then(
          () => true,
          () => false,
        ))
      ) {
        if (Date.now() > deadline) {
          throw new Error(`iOS showcase scene '${scene}' did not render within 900000ms.`);
        }
        const launcherGaveUp = await iosDevLauncherVisible(simulator.udid);
        if (relaunches < 4 && (launcherGaveUp || Date.now() - launchedAt > 300_000)) {
          relaunches += 1;
          NodeProcess.stdout.write(
            `Relaunching ${capture.device.id} (${launcherGaveUp ? "dev launcher gave up" : "no scene after 5 minutes"}).\n`,
          );
          await launchShowcaseApp(true);
          launchedAt = Date.now();
        }
      }
    } else {
      // A starved host can leave a scene undrawn or on a stall screen; re-entering
      // remounts it and retries. agent-activity stages a Live Activity, so it only waits.
      let reentries = 0;
      while (true) {
        const ready = await waitForScene(scene === "agent-activity" ? 300_000 : 120_000).then(
          () => true,
          () => false,
        );
        const stall = ready ? await iosStallText(simulator.udid, scene) : null;
        if (ready && stall === null) break;
        if (reentries === 2 || scene === "agent-activity") {
          throw new Error(
            stall === null
              ? `iOS showcase scene '${scene}' did not render after ${reentries} re-entries.`
              : `iOS showcase scene '${scene}' shows a stall screen ("${stall}").`,
          );
        }
        reentries += 1;
        NodeProcess.stdout.write(
          `Re-entering ${capture.device.id} ${scene} (${stall === null ? "not drawn after 120s" : `shows "${stall}"`}).\n`,
        );
        const away = scene === "threads" ? "environments" : "threads";
        await NodeFSP.rm(readyPath, { force: true });
        await NodeFSP.writeFile(scenePath, away);
        await waitForIosShowcaseScene(simulator.udid, away, 120_000);
        await NodeFSP.rm(readyPath, { force: true });
        await NodeFSP.writeFile(scenePath, scene);
      }
    }
    if (scene === "agent-activity") await presentIosLockScreen(simulator.udid);
    if ((scene as string) === "thread-open" || (scene as string) === "composer-open") {
      // Capture-only: tap the showcase thread row by its accessibility frame.
      const ui = await commandOutput(iosAxe(), ["describe-ui", "--udid", simulator.udid]).catch(() => "");
      let frame: { x: number; y: number; width: number; height: number } | null = null;
      const walk = (node: unknown): void => {
        if (frame !== null || node === null || typeof node !== "object") return;
        if (Array.isArray(node)) { for (const child of node) walk(child); return; }
        const record = node as Record<string, unknown>;
        const label = typeof record.AXLabel === "string" ? record.AXLabel : "";
        const f = record.frame as { x: number; y: number; width: number; height: number } | undefined;
        if (label.includes("Make remote coding feel local") && f && f.height < 200) { frame = f; return; }
        for (const value of Object.values(record)) if (typeof value === "object") walk(value);
      };
      try { walk(JSON.parse(ui)); } catch { /* not JSON */ }
      NodeProcess.stdout.write(`ios row tap ${scene} frame=${JSON.stringify(frame)}\n`);
      const target = frame as { x: number; y: number; width: number; height: number } | null;
      if (target !== null) {
        await runAxe(simulator.udid, ["tap", "-x", String(Math.round(target.x + target.width / 2)), "-y", String(Math.round(target.y + target.height / 2))]).catch((error: unknown) =>
          NodeProcess.stdout.write(`ios row tap failed: ${String(error)}\n`),
        );
        await delay(10_000);
      }
    }
    // Capture-only (batch-98882808): AXe drivers for draft typing and Settings search/select/back.
    const iosNodes = async (): Promise<Array<Record<string, unknown>>> => {
      const ui = await commandOutput(iosAxe(), ["describe-ui", "--udid", simulator.udid]).catch(() => "");
      const out: Array<Record<string, unknown>> = [];
      const walk = (node: unknown): void => {
        if (node === null || typeof node !== "object") return;
        if (Array.isArray(node)) { for (const child of node) walk(child); return; }
        out.push(node as Record<string, unknown>);
        for (const value of Object.values(node as Record<string, unknown>)) if (typeof value === "object") walk(value);
      };
      try { walk(JSON.parse(ui)); } catch { /* not JSON */ }
      return out;
    };
    const iosKind = (n: Record<string, unknown>) => `${String(n.type ?? "")} ${String(n.role ?? "")} ${String(n.role_description ?? "")}`;
    const iosTapNode = async (n: Record<string, unknown> | undefined, what: string) => {
      const f = n?.frame as { x: number; y: number; width: number; height: number } | undefined;
      NodeProcess.stdout.write(`ios ${scene} ${what} frame=${JSON.stringify(f ?? null)} kind=${n ? iosKind(n) : "none"}\n`);
      if (!f) return false;
      await runAxe(simulator.udid, ["tap", "-x", String(Math.round(f.x + f.width / 2)), "-y", String(Math.round(f.y + f.height / 2))]).catch((error: unknown) =>
        NodeProcess.stdout.write(`ios ${scene} tap failed: ${String(error)}\n`));
      await delay(2_000);
      return true;
    };
    const iosSwipeBack = async () => {
      const nodes = await iosNodes();
      const back = nodes.find((n) => {
        const f = n.frame as { x: number; y: number; width: number; height: number } | undefined;
        return f !== undefined && f.x < 90 && f.y > 40 && f.y < 200 && f.width < 120 && /Button/.test(iosKind(n));
      });
      if (await iosTapNode(back, "back-button")) { await delay(1_500); return; }
      await runAxe(simulator.udid, ["gesture", "swipe-from-left-edge"]).catch(async (error: unknown) => {
        NodeProcess.stdout.write(`ios ${scene} gesture failed: ${String(error)}; swipe\n`);
        await runAxe(simulator.udid, ["swipe", "--start-x", "4", "--start-y", "500", "--end-x", "360", "--end-y", "500", "--duration", "0.4"]).catch(() => undefined);
      });
      await delay(3_000);
    };
    if ((scene as string) === "draft-long") {
      const fields = (await iosNodes()).filter((n) => /TextArea|TextView|TextField/.test(iosKind(n)) && !/Search/.test(iosKind(n)));
      const field = fields.sort((a, b) => ((b.frame as { y: number } | undefined)?.y ?? 0) - ((a.frame as { y: number } | undefined)?.y ?? 0))[0];
      if (await iosTapNode(field, "composer")) {
        await runAxe(simulator.udid, ["type", "Plan the offline launch checklist for the remote handoff, keep the composer above the keyboard while the draft grows, open review on Changes, then summarize anything that still looks off before the beta goes out this week"]).catch((error: unknown) =>
          NodeProcess.stdout.write(`ios draft-long type failed: ${String(error)}\n`));
        await delay(4_000);
      }
    }
    if ((scene as string) === "settings-search") {
      let nodes = await iosNodes();
      NodeProcess.stdout.write(`ios settings-search labels=${JSON.stringify(nodes.map((n) => `${String(n.AXLabel ?? "")}|${iosKind(n).trim()}`).filter((l) => !l.startsWith("|")).slice(0, 40))}\n`);
      if (!nodes.some((n) => /SearchField/.test(iosKind(n)))) {
        const button = nodes.find((n) => /Button/.test(iosKind(n)) && /search/i.test(String(n.AXLabel ?? "")));
        if (await iosTapNode(button, "search-button")) nodes = await iosNodes();
      }
      const field = nodes.find((n) => /SearchField/.test(iosKind(n))) ?? nodes.find((n) => /TextField/.test(iosKind(n)) && /Search/i.test(`${String(n.AXLabel ?? "")} ${String(n.AXValue ?? "")} ${String(n.placeholder ?? "")}`));
      if (await iosTapNode(field, "search")) {
        await runAxe(simulator.udid, ["type", "appear"]).catch(() => undefined);
        await delay(3_000);
      }
    }
    if ((scene as string) === "settings-back" || (scene as string) === "settings-select") {
      await iosSwipeBack();
      if ((scene as string) === "settings-select") {
        const rows = (await iosNodes()).filter((n) => String(n.AXLabel ?? "").startsWith("Appearance") && ((n.frame as { height: number } | undefined)?.height ?? 999) < 150);
        await iosTapNode(rows[0], "appearance-row");
        await delay(4_000);
      }
    }
    if ((scene as string).endsWith("-end")) {
      // Capture-only: scroll the page to its end.
      for (let i = 0; i < 8; i += 1) {
        await runAxe(simulator.udid, ["swipe", "--start-x", "220", "--start-y", "760", "--end-x", "220", "--end-y", "220", "--duration", "0.3"]).catch((error: unknown) =>
          NodeProcess.stdout.write(`ios ${scene} swipe failed: ${String(error)}\n`));
        await delay(800);
      }
      await delay(2_000);
    }
    if ((scene as string) === "settings-labs-on") {
      // Capture-only (batch-001704): turn on each "Beta: Linked environments" switch that is off.
      const labels = new Set(["Moonbase Terminal", "Kernel Cabin", "Suspense Station"]);
      const switches = (await iosNodes()).filter((n) => labels.has(String(n.AXLabel ?? "")) && /Switch|CheckBox|Toggle/i.test(iosKind(n)));
      NodeProcess.stdout.write(`ios settings-labs-on switches=${JSON.stringify(switches.map((n) => `${String(n.AXLabel)}=${String(n.AXValue ?? "")}|${iosKind(n).trim()}`))}\n`);
      const switchState = async (label: string) =>
        (await iosNodes()).find((x) => String(x.AXLabel ?? "") === label && /Switch|CheckBox|Toggle/i.test(iosKind(x)));
      for (const n of switches) {
        const label = String(n.AXLabel);
        const value = String(n.AXValue ?? "");
        if (value === "1" || /^on$/i.test(value)) continue;
        NodeProcess.stdout.write(`ios settings-labs-on ${label} node=${JSON.stringify(Object.fromEntries(Object.entries(n).filter(([k]) => k !== "children")))}\n`);
        await iosTapNode(n, `switch ${label}`);
        await delay(3_000);
        let after = await switchState(label);
        NodeProcess.stdout.write(`ios settings-labs-on ${label} after tap value=${String(after?.AXValue ?? "?")}\n`);
        const f = n.frame as { x: number; y: number; width: number; height: number } | undefined;
        if (f && String(after?.AXValue ?? "") !== "1") {
          // Fallback: slide the thumb from left to right, as a finger would.
          const y = String(Math.round(f.y + f.height / 2));
          await runAxe(simulator.udid, ["swipe", "--start-x", String(Math.round(f.x + 10)), "--start-y", y, "--end-x", String(Math.round(f.x + f.width - 6)), "--end-y", y, "--duration", "0.3"]).catch((error: unknown) =>
            NodeProcess.stdout.write(`ios settings-labs-on swipe failed: ${String(error)}\n`));
          await delay(3_000);
          after = await switchState(label);
          NodeProcess.stdout.write(`ios settings-labs-on ${label} after swipe value=${String(after?.AXValue ?? "?")}\n`);
        }
      }
      await delay(3_000);
    }
    const iosTabLabel = ({ apps: "Apps", pulls: "PRs", "usage-tab": "Usage" } as Record<string, string>)[scene];
    if (iosTabLabel !== undefined) {
      await runAxe(simulator.udid, ["tap", "--label", iosTabLabel]).catch((error: unknown) =>
        NodeProcess.stdout.write(`ios tab tap ${iosTabLabel} failed: ${String(error)}\n`),
      );
      await delay(3_000);
    }
    await delay(
      scene === "review" || (scene as string) === "composer-long"
        ? Math.max(config.settleDelayMs, scene === "review" ? 8_000 : 10_000)
        : config.settleDelayMs,
    );
    const stall = await iosStallText(simulator.udid, scene);
    if (stall !== null) {
      throw new Error(`iOS showcase scene '${scene}' shows a stall screen ("${stall}").`);
    }
    const destination = NodePath.join(
      showcaseCaptureDirectory(outputDirectory, capture),
      `${scene}.png`,
    );
    const takeScreenshot = async () => {
      await runCommand("xcrun", [
        "simctl",
        "io",
        simulator.udid,
        "screenshot",
        ...(capture.device.fold ? ["--display", capture.device.fold === "closed" ? "1" : "3"] : []),
        destination,
      ]);
      if (capture.device.orientation === "landscape") {
        // A headless simulator keeps its display portrait while the rotated app
        // renders sideways inside it; with Simulator.app attached the display
        // itself rotates. Only post-rotate the former.
        const { width, height } = readPngDimensions(await NodeFSP.readFile(destination));
        if (height > width) {
          await runCommand("sips", ["--rotate", capture.device.fold ? "90" : "270", destination]);
        }
      }
    };
    await takeScreenshot();
    // The app reports a scene ready once its route is current, but on a loaded
    // host the native push can still be drawing the previous screen.
    const previousScene = capture.scenes[sceneIndex - 1];
    const previousPath =
      previousScene === undefined
        ? null
        : NodePath.join(showcaseCaptureDirectory(outputDirectory, capture), `${previousScene}.png`);
    const previousExists =
      previousPath !== null &&
      (await NodeFSP.access(previousPath).then(
        () => true,
        () => false,
      ));
    if (previousExists && previousScene !== undefined && previousScene !== "agent-activity") {
      const previous = await NodeFSP.readFile(
        NodePath.join(showcaseCaptureDirectory(outputDirectory, capture), `${previousScene}.png`),
      );
      for (
        let retake = 0;
        screenshotsMatch(previous, await NodeFSP.readFile(destination));
        retake += 1
      ) {
        if (retake === 5) {
          throw new Error(`iOS showcase scene '${scene}' still shows '${previousScene}'.`);
        }
        await delay(3_000);
        await takeScreenshot();
      }
    }
    if (scene === "agent-activity") await unlockIosSimulator(simulator.udid);
    await finalizeCapture(destination, capture.device);
   } catch (error) {
    if (sceneIndex === 0) throw error;
    NodeProcess.stdout.write(
      `SHOWCASE-SCENE-FAILED ${capture.device.id} ${scene}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    await NodeFSP.rm(
      NodePath.join(showcaseCaptureDirectory(outputDirectory, capture), `${scene}.png`),
      { force: true },
    );
   }
  }
}

function androidSdkTool(relativePath: string): string {
  return NodePath.join(ANDROID_SDK_ROOT, relativePath);
}

async function adbOutput(serial: string, args: ReadonlyArray<string>): Promise<string> {
  return await commandOutput(androidSdkTool("platform-tools/adb"), ["-s", serial, ...args]);
}

async function runAdb(serial: string, args: ReadonlyArray<string>): Promise<void> {
  await runCommand(androidSdkTool("platform-tools/adb"), ["-s", serial, ...args]);
}

/** Snooze emulator system notices for an hour so only app notifications appear in captures. */
async function snoozeAndroidSystemNotifications(serial: string): Promise<void> {
  const keys = (await adbOutput(serial, ["shell", "cmd", "notification", "list"]))
    .split("\n")
    .map((line) => line.trim())
    .filter((key) => key.includes("|") && !key.includes(`|${ANDROID_PACKAGE}|`));
  for (const key of keys) {
    // adb joins shell args with spaces, so the key needs quoting for the pipes.
    await runAdb(serial, ["shell", `cmd notification snooze --for 3600000 '${key}'`]);
  }
}

async function runningAndroidAvds(): Promise<ReadonlyMap<string, string>> {
  const adb = androidSdkTool("platform-tools/adb");
  const devices = (await commandOutput(adb, ["devices"]))
    .split("\n")
    .map((line) => line.trim().split(/\s+/u))
    .filter((parts) => parts[0]?.startsWith("emulator-") && parts[1] === "device")
    .map((parts) => parts[0] as string);
  const result = new Map<string, string>();
  for (const serial of devices) {
    const avdName = (await adbOutput(serial, ["emu", "avd", "name"])).split("\n")[0]?.trim();
    if (avdName) result.set(avdName, serial);
  }
  return result;
}

async function waitForAndroidSerial(avd: string, timeoutMs = 120_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const serial = (await runningAndroidAvds()).get(avd);
    if (serial) {
      await runAdb(serial, ["wait-for-device"]);
      const bootCompleted = (
        await adbOutput(serial, ["shell", "getprop", "sys.boot_completed"])
      ).trim();
      if (bootCompleted === "1") return serial;
    }
    await delay(1_000);
  }
  throw new Error(`Android AVD '${avd}' did not finish booting within ${timeoutMs}ms.`);
}

async function normalizeAndroidEmulator(
  device: ShowcaseAndroidDevice,
  appearance: ShowcaseAppearance,
  serial: string,
): Promise<void> {
  await runAdb(serial, ["shell", "settings", "put", "global", "window_animation_scale", "0"]);
  await runAdb(serial, ["shell", "settings", "put", "global", "transition_animation_scale", "0"]);
  await runAdb(serial, ["shell", "settings", "put", "global", "animator_duration_scale", "0"]);
  await runAdb(serial, ["shell", "cmd", "uimode", "night", appearance === "dark" ? "yes" : "no"]);
  await runAdb(serial, ["shell", "settings", "put", "system", "time_12_24", "12"]);
  await runAdb(serial, ["emu", "power", "capacity", "100"]);
  await runAdb(serial, ["shell", "settings", "put", "global", "sysui_demo_allowed", "1"]);
  await runAdb(serial, [
    "shell",
    "am",
    "broadcast",
    "-a",
    "com.android.systemui.demo",
    "-e",
    "command",
    "enter",
  ]);
  await runAdb(serial, [
    "shell",
    "am",
    "broadcast",
    "-a",
    "com.android.systemui.demo",
    "-e",
    "command",
    "clock",
    "-e",
    "hhmm",
    "0941",
  ]);
  await runAdb(serial, [
    "shell",
    "am",
    "broadcast",
    "-a",
    "com.android.systemui.demo",
    "-e",
    "command",
    "battery",
    "-e",
    "level",
    "100",
    "-e",
    "plugged",
    "false",
  ]);
  if (device.viewport) {
    await runAdb(serial, [
      "shell",
      "wm",
      "size",
      `${device.viewport.width}x${device.viewport.height}`,
    ]);
    if (device.viewport.density) {
      await runAdb(serial, ["shell", "wm", "density", String(device.viewport.density)]);
    }
  }
}

async function waitForAndroidShowcaseScene(
  serial: string,
  scene: ShowcaseScene,
  timeoutMs = 300_000, // capture-only: first dev-client bundle takes ~65s on 4 vCPU
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const readyScene = await adbOutput(serial, [
      "shell",
      "run-as",
      ANDROID_PACKAGE,
      "cat",
      "files/lecturn-showcase-ready",
    ]).catch(() => "");
    if (readyScene.trim() === scene) return;
    await delay(500);
  }
  throw new Error(`Android showcase scene '${scene}' did not render within ${timeoutMs}ms.`);
}

async function writeAndroidShowcaseScene(serial: string, scene: ShowcaseScene): Promise<void> {
  await runAdb(serial, [
    "shell",
    `run-as ${ANDROID_PACKAGE} sh -c 'mkdir -p files && rm -f files/lecturn-showcase-ready && printf %s ${scene} > files/lecturn-showcase-scene'`,
  ]);
}

// Gesture/key-command toggles have no URL flags; set preferences separately from DEV_CLIENT_LAUNCH_FLAGS.
async function prepareAndroidShowcaseApp(serial: string): Promise<void> {
  const preferences = `<?xml version="1.0" encoding="utf-8" standalone="yes" ?>
<map>
  <boolean name="motionGestureEnabled" value="false" />
  <boolean name="touchGestureEnabled" value="false" />
  <boolean name="keyCommandsEnabled" value="false" />
</map>`;
  const encodedPreferences = Buffer.from(preferences).toString("base64");
  await runAdb(serial, [
    "shell",
    `run-as ${ANDROID_PACKAGE} sh -c 'mkdir -p shared_prefs && printf %s ${encodedPreferences} | base64 -d > shared_prefs/expo.modules.devmenu.sharedpreferences.xml'`,
  ]);
}

async function captureAndroid(
  capture: ShowcaseCapture & { readonly device: ShowcaseAndroidDevice },
  apkPath: string | null,
  outputDirectory: string,
  config: ShowcaseConfig,
  pairingUrls: ReadonlyArray<string>,
  registerCleanup: (cleanup: AndroidCaptureCleanup) => void,
): Promise<void> {
  const running = await runningAndroidAvds();
  const existingSerial = running.get(capture.device.avd);
  const startedByRunner = !existingSerial;
  let launchedEmulator: NodeChildProcess.ChildProcess | null = null;
  if (startedByRunner) {
    const installedAvds = (await commandOutput(androidSdkTool("emulator/emulator"), ["-list-avds"]))
      .split("\n")
      .map((value) => value.trim());
    if (!installedAvds.includes(capture.device.avd)) {
      throw new Error(
        `Android AVD '${capture.device.avd}' is not installed. Run emulator -list-avds.`,
      );
    }
    launchedEmulator = spawnProcess(
      androidSdkTool("emulator/emulator"),
      ["-avd", capture.device.avd, "-no-snapshot-load", "-no-boot-anim"],
      { stdio: "ignore", detached: true },
    );
    launchedEmulator.unref();
  }
  const serial =
    existingSerial ??
    (await waitForAndroidSerial(capture.device.avd).catch(async (error: unknown) => {
      if (launchedEmulator) await stopProcess(launchedEmulator);
      throw error;
    }));
  registerCleanup({ device: capture.device, serial, startedByRunner });
  await normalizeAndroidEmulator(capture.device, capture.appearance, serial);
  if (apkPath) {
    await runAdb(serial, ["install", "-r", apkPath]);
  }
  await runAdb(serial, ["shell", "pm", "clear", ANDROID_PACKAGE]);
  await runAdb(serial, [
    "shell",
    "pm",
    "grant",
    ANDROID_PACKAGE,
    "android.permission.POST_NOTIFICATIONS",
  ]);
  await prepareAndroidShowcaseApp(serial);
  await runAdb(serial, ["reverse", `tcp:${config.metroPort}`, `tcp:${config.metroPort}`]);
  const metroUrl = encodeURIComponent(`http://127.0.0.1:${config.metroPort}?disableOnboarding=1`);
  const firstScene = capture.scenes[0] ?? "threads";
  await runAdb(serial, [
    "shell",
    "am",
    "start",
    "-W",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    `'${APP_SCHEME}://expo-development-client/?url=${metroUrl}&${DEV_CLIENT_LAUNCH_FLAGS}'`,
    "--es",
    "showcasePairingUrl",
    encodeAndroidPairingUrls(pairingUrls),
    "--es",
    "showcaseScene",
    firstScene,
    "--es",
    "showcaseTheme",
    capture.theme,
    ANDROID_PACKAGE,
  ]);
  for (const [sceneIndex, scene] of capture.scenes.entries()) {
    if (sceneIndex > 0) await writeAndroidShowcaseScene(serial, scene);
    await waitForAndroidShowcaseScene(serial, scene);
    if (scene === "agent-activity") {
      await snoozeAndroidSystemNotifications(serial);
      await runAdb(serial, ["shell", "cmd", "statusbar", "expand-notifications"]);
    }
    await delay(
      Math.max(
        config.settleDelayMs,
        scene === "review" ? 8_000 : (scene as string) === "composer-long" ? 10_000 : 5_000,
      ),
    );
    if ((scene as string) === "settings-back") {
      // Capture-only: Android Back from the Settings page.
      await runAdb(serial, ["shell", "input", "keyevent", "KEYCODE_BACK"]);
      await delay(3_000);
    }
    if ((scene as string) === "settings-select") {
      // Capture-only: tap a Settings list row; a phone shows the page, so go Back to the list first.
      const dump = () =>
        Promise.race([
          adbOutput(serial, ["exec-out", "uiautomator", "dump", "/dev/tty"]).catch(() => ""),
          delay(30_000).then(() => ""),
        ]);
      const find = (xml: string) =>
        /text="Appearance"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(xml) ??
        /text="Notifications"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(xml);
      let match = find(await dump());
      let pressedBack = false;
      if (!match) {
        await runAdb(serial, ["shell", "input", "keyevent", "KEYCODE_BACK"]);
        pressedBack = true;
        await delay(3_000);
        match = find(await dump());
      }
      const bounds = match ? match.slice(1).map(Number) : null;
      NodeProcess.stdout.write(
        `settings-select back=${pressedBack} row=${match?.[0]?.slice(0, 24) ?? "none"} bounds=${JSON.stringify(bounds)}\n`,
      );
      if (bounds) {
        const x = Math.round((bounds[0]! + bounds[2]!) / 2);
        const y = Math.round((bounds[1]! + bounds[3]!) / 2);
        await runAdb(serial, ["shell", "input", "tap", String(x), String(y)]);
      }
      await delay(4_000);
    }
    if (["thread-open", "thread-back", "decisions-back", "pr-watch-back"].includes(scene as string)) {
      // Capture-only: open a fixture thread from the list on screen, then Back for *-back.
      const xml = await Promise.race([
        adbOutput(serial, ["exec-out", "uiautomator", "dump", "/dev/tty"]).catch(() => ""),
        delay(30_000).then(() => ""),
      ]);
      const match =
        /text="((?:Make remote coding feel local|Put the command center in your pocket|Make Suspense transitions buttery|Ship the offline launch)[^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(
          xml,
        );
      const bounds = match ? match.slice(2).map(Number) : null;
      NodeProcess.stdout.write(
        `${scene} row=${JSON.stringify(match?.[1] ?? null)} bounds=${JSON.stringify(bounds)}\n`,
      );
      if (bounds) {
        const x = Math.round((bounds[0]! + bounds[2]!) / 2);
        const y = Math.round((bounds[1]! + bounds[3]!) / 2);
        await runAdb(serial, ["shell", "input", "tap", String(x), String(y)]);
        await delay(6_000);
        if ((scene as string).endsWith("-back")) {
          await runAdb(serial, ["shell", "input", "keyevent", "KEYCODE_BACK"]);
          await delay(3_000);
        }
      }
    }
    if ((scene as string).endsWith("-end")) {
      // Capture-only: scroll the page to its end.
      const wmSize = await adbOutput(serial, ["shell", "wm", "size"]).catch(() => "");
      const size = /Override size: (\d+)x(\d+)/.exec(wmSize) ?? /(\d+)x(\d+)/.exec(wmSize);
      const w = size ? Number(size[1]) : 1080;
      const h = size ? Number(size[2]) : 1920;
      NodeProcess.stdout.write(`${scene} swipe in ${w}x${h}\n`);
      for (let i = 0; i < 8; i += 1) {
        await runAdb(serial, ["shell", "input", "swipe", String(Math.round(w * 0.6)), String(Math.round(h * 0.75)), String(Math.round(w * 0.6)), String(Math.round(h * 0.25)), "300"]);
        await delay(800);
      }
      await delay(2_000);
    }
    if ((scene as string) === "draft-long") {
      // Capture-only (batch-98882808): type a long draft into the new-task composer.
      const xml = await Promise.race([
        adbOutput(serial, ["exec-out", "uiautomator", "dump", "/dev/tty"]).catch(() => ""),
        delay(30_000).then(() => ""),
      ]);
      const nodes = [...xml.matchAll(/<node [^>]*>/g)].map((m) => m[0]);
      const field =
        nodes.find((n) => /(?:hint|text)="Ask anything"/.test(n)) ??
        [...nodes].reverse().find((n) => n.includes('class="android.widget.EditText"'));
      const b = field ? /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(field)?.slice(1).map(Number) ?? null : null;
      NodeProcess.stdout.write(`draft-long field=${JSON.stringify(b)}\n`);
      if (b) {
        await runAdb(serial, ["shell", "input", "tap", String(Math.round((b[0]! + b[2]!) / 2)), String(Math.round((b[1]! + b[3]!) / 2))]);
        await delay(2_000);
        const words = "Plan the offline launch checklist for the remote handoff, keep the composer above the keyboard while the draft grows, open review on Changes, then summarize anything that still looks off before the beta goes out this week".split(" ");
        for (let i = 0; i < words.length; i += 8) {
          const chunk = (i > 0 ? " " : "") + words.slice(i, i + 8).join(" ");
          await runAdb(serial, ["shell", "input", "text", chunk.replace(/ /g, "%s")]);
          await delay(800);
        }
        await delay(4_000);
      }
    }
    if ((scene as string) === "settings-labs-on") {
      // Capture-only (batch-001704): turn on each "Beta: Linked environments" switch that is off.
      const xml = await Promise.race([
        adbOutput(serial, ["exec-out", "uiautomator", "dump", "/dev/tty"]).catch(() => ""),
        delay(30_000).then(() => ""),
      ]);
      const nodes = [...xml.matchAll(/<node [^>]*>/g)].map((m) => m[0]);
      const switches = nodes.filter(
        (n) => /content-desc="(?:Moonbase Terminal|Kernel Cabin|Suspense Station)"/.test(n) && /checkable="true"/.test(n),
      );
      NodeProcess.stdout.write(`settings-labs-on switches=${switches.length} off=${switches.filter((n) => /checked="false"/.test(n)).length}\n`);
      for (const n of switches.filter((x) => /checked="false"/.test(x))) {
        const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(n)?.slice(1).map(Number);
        if (!b) continue;
        await runAdb(serial, ["shell", "input", "tap", String(Math.round((b[0]! + b[2]!) / 2)), String(Math.round((b[1]! + b[3]!) / 2))]);
        await delay(2_500);
      }
      await delay(3_000);
    }
    if ((scene as string) === "drafts-swipe") {
      // Capture-only: open the swipe action on the first unsent row.
      const xml = await Promise.race([
        adbOutput(serial, ["exec-out", "uiautomator", "dump", "/dev/tty"]).catch(() => ""),
        delay(30_000).then(() => ""),
      ]);
      const match =
        /(?:text|content-desc)="[^"]*Ship the offline[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(xml);
      const bounds = match ? match.slice(1).map(Number) : null;
      const y = bounds ? Math.round((bounds[1]! + bounds[3]!) / 2) : 910;
      const right = bounds ? bounds[2]! - 10 : 900;
      const left = bounds ? bounds[0]! : 250;
      NodeProcess.stdout.write(`drafts-swipe bounds=${JSON.stringify(bounds)} y=${y} ${right}->${left}\n`);
      await runAdb(serial, ["shell", "input", "swipe", String(right), String(y), String(left), String(y), "450"]);
      await delay(1_500);
    }
    const destination = NodePath.join(
      showcaseCaptureDirectory(outputDirectory, capture),
      `${scene}.png`,
    );
    const png = await new Promise<Buffer>((resolve, reject) => {
      NodeChildProcess.execFile(
        androidSdkTool("platform-tools/adb"),
        ["-s", serial, "exec-out", "screencap", "-p"],
        { cwd: REPO_ROOT, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        },
      );
    });
    await NodeFSP.writeFile(destination, png);
    if (scene === "agent-activity") {
      await runAdb(serial, ["shell", "cmd", "statusbar", "collapse"]);
    }
    await finalizeCapture(destination, capture.device);
  }
}

async function cleanupAndroidViewport(
  device: ShowcaseAndroidDevice,
  serial: string,
): Promise<void> {
  await runAdb(serial, [
    "shell",
    "am",
    "broadcast",
    "-a",
    "com.android.systemui.demo",
    "-e",
    "command",
    "exit",
  ]);
  if (!device.viewport) return;
  await runAdb(serial, ["shell", "wm", "size", "reset"]);
  if (device.viewport.density) {
    await runAdb(serial, ["shell", "wm", "density", "reset"]);
  }
}

async function main(): Promise<void> {
  const options = parseShowcaseCliArgs(NodeProcess.argv.slice(2));
  if (options.list) {
    printUsage(showcaseConfig);
    return;
  }
  const captures = planShowcaseCaptures(showcaseConfig, options);
  const outputDirectory = NodePath.resolve(REPO_ROOT, showcaseConfig.outputDirectory);
  if (options.validateOnly) {
    for (const capture of captures) {
      await validateCaptureSet(
        capture,
        outputDirectory,
        capture.scenes.length === capture.device.scenes.length,
      );
    }
    return;
  }
  const hasIos = captures.some((capture) => capture.device.platform === "ios");
  const hasAndroid = captures.some((capture) => capture.device.platform === "android");
  const metroHost = hasIos ? lanIpv4Address() : "127.0.0.1";
  await NodeFSP.mkdir(outputDirectory, { recursive: true });
  for (const capture of captures) {
    const directory = showcaseCaptureDirectory(outputDirectory, capture);
    await NodeFSP.rm(directory, { recursive: true, force: true });
    await NodeFSP.mkdir(directory, { recursive: true });
  }

  const showcaseRootDir = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "lecturn-mobile-showcase-"),
  );
  const showcaseServers: NodeChildProcess.ChildProcess[] = [];
  const showcaseEnvironments: ShowcaseEnvironment[] = [];
  let metro: NodeChildProcess.ChildProcess | null = null;
  const iosCleanups: IosCaptureCleanup[] = [];
  const androidCleanups: AndroidCaptureCleanup[] = [];

  try {
    // Build before the servers and Metro start so they do not hold memory
    // through the native build on a small CI host.
    const iosAppPath = hasIos
      ? options.skipBuild
        ? await existingArtifact(IOS_APP_PATH)
        : await buildIos()
      : null;
    const androidAbis = captures.flatMap((capture) =>
      capture.device.platform === "android" && capture.device.abi ? [capture.device.abi] : [],
    );
    const androidApkPath = hasAndroid
      ? options.skipBuild
        ? await existingArtifact(ANDROID_APK_PATH)
        : await buildAndroid([...new Set(androidAbis)])
      : null;

    showcaseEnvironments.push(
      ...(await startShowcaseEnvironments(showcaseRootDir, (server) =>
        showcaseServers.push(server),
      )),
    );

    if (!options.skipMetro) {
      metro = startMetro(showcaseConfig);
      await waitForPort(showcaseConfig.metroPort, "Metro");
      await Promise.all([
        hasIos ? warmMetroBundle("ios", metroHost, showcaseConfig) : Promise.resolve(),
        hasAndroid ? warmMetroBundle("android", "127.0.0.1", showcaseConfig) : Promise.resolve(),
      ]);
    }

    for (const [captureIndex, capture] of captures.entries()) {
      // A showcase server that served earlier devices can stop answering late in
      // a long hosted run (iPad /api/auth/session timeouts in runs 42420789069
      // and 42425290074). Each device starts against freshly started servers.
      if (captureIndex > 0) {
        await Promise.all(showcaseServers.splice(0).map((server) => stopProcess(server)));
        for (const environment of showcaseEnvironments) {
          showcaseServers.push(environment.start());
          await waitForPort(environment.port, `${environment.label} server`);
        }
      }
      const pairingHost = capture.device.platform === "ios" ? "127.0.0.1" : "10.0.2.2";
      const issuePairingUrls = () =>
        Promise.all(
          showcaseEnvironments.map(async (environment) => {
            const credential = await issuePairingCredential(environment.baseDir);
            return buildShowcasePairingUrl(pairingHost, environment.port, credential);
          }),
        );
      if (capture.device.platform === "ios") {
        await captureIos(
          capture as ShowcaseCapture & { readonly device: ShowcaseIosDevice },
          iosAppPath,
          outputDirectory,
          showcaseConfig,
          metroHost,
          issuePairingUrls,
          (cleanup) => iosCleanups.push(cleanup),
        ).catch(async (error: unknown) => {
          const simulator = iosCleanups.at(-1);
          if (simulator) await collectIosDiagnostics(simulator.udid, capture.device.id);
          throw error;
        });
      } else {
        await captureAndroid(
          capture as ShowcaseCapture & { readonly device: ShowcaseAndroidDevice },
          androidApkPath,
          outputDirectory,
          showcaseConfig,
          await issuePairingUrls(),
          (cleanup) => androidCleanups.push(cleanup),
        );
      }
      await validateCaptureSet(
        capture,
        outputDirectory,
        capture.scenes.length === capture.device.scenes.length,
      );
      // A hosted macOS runner cannot hold several booted simulators in memory.
      const simulator = capture.device.platform === "ios" ? iosCleanups.at(-1) : undefined;
      if (simulator && !options.keepRunning) {
        await runCommand("xcrun", ["simctl", "shutdown", simulator.udid]).catch(() => undefined);
      }
    }

    NodeProcess.stdout.write(
      `\nDone. Upload-ready screenshots are in ${NodePath.relative(REPO_ROOT, outputDirectory)}/apple/ and ${NodePath.relative(REPO_ROOT, outputDirectory)}/google-play/.\n`,
    );
    if (options.keepRunning) {
      const serverSummary = showcaseEnvironments
        .map((environment) => `${environment.label}:${environment.port}`)
        .join(", ");
      NodeProcess.stdout.write(
        `Showcase environments kept at ${showcaseRootDir} (${serverSummary}).\n`,
      );
    }
  } finally {
    if (options.keepRunning) {
      metro?.unref();
      for (const server of showcaseServers) server.unref();
    } else {
      for (const cleanup of androidCleanups) {
        await cleanupAndroidViewport(cleanup.device, cleanup.serial).catch(() => undefined);
        if (cleanup.startedByRunner) {
          await runAdb(cleanup.serial, ["emu", "kill"]).catch(() => undefined);
        }
      }
      for (const cleanup of iosCleanups) {
        if (cleanup.startedByRunner || cleanup.createdByRunner) {
          await runCommand("xcrun", ["simctl", "shutdown", cleanup.udid]).catch(() => undefined);
        }
        if (cleanup.createdByRunner) {
          await runCommand("xcrun", ["simctl", "delete", cleanup.udid]).catch(() => undefined);
        }
      }
      await Promise.all([
        ...(metro ? [stopProcess(metro)] : []),
        ...showcaseServers.map((server) => stopProcess(server)),
      ]);
      await NodeFSP.rm(showcaseRootDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  }
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    NodeProcess.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    NodeProcess.exit(1);
  });
}

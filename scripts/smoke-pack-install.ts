#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off globalConsole:off - a one-shot smoke harness driving installs and server subprocesses with Node APIs.
/**
 * Clean-install smoke for the vendoring kit (`cli.ts pack --out-dir`): what an embedding host
 * (RocketWright) gets from its `file:` tarballs and lecturn-pack.json, with no workspace, patches
 * or hoisting it did not ask for.
 *
 * For each pnpm layout (isolated, hoisted) it installs the tarballs into an empty temp dir and,
 * per runtime (this Node, Electron with ELECTRON_RUN_AS_NODE, and with --asar that Electron run
 * again from an asar archive of the hoisted tree), runs the in-process probes (scripts/smoke-pack-probe.ts) and
 * `serve --base-dir <tmp>` until /.well-known/lecturn/environment answers, and imports
 * @lecturn/embed's node and browser entries under this Node.
 *
 * Usage:
 *   node scripts/smoke-pack-install.ts [--electron <binary>] [--asar] [--layout hoisted|isolated|both]
 *     [--pack-dir <dir> | --tarball <tgz>...] [--patches] [--json <file>] [--keep]
 *
 * Without --pack-dir or --tarball it runs `apps/server/scripts/cli.ts pack` (apps/server and
 * packages/embed must be built). The consumer takes allowBuilds and publicHoistPattern from the
 * kit's lecturn-pack.json, and with --patches its patchedDependencies too. Bare --tarball runs fall
 * back to Lecturn's own workspace settings. The default layout is hoisted, the one the kit asks for.
 * Exit code 1 when any check fails.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import { createPackageWithOptions } from "@electron/asar";
import { fromYaml } from "@lecturn/shared/schemaYaml";
import * as Schema from "effect/Schema";

import { LECTURN_PACK_DESCRIPTOR_FILE, LecturnPackDescriptor } from "./lib/lecturn-pack.ts";
import type { ProbeCheck } from "./smoke-pack-probe.ts";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

type Layout = "isolated" | "hoisted";
interface Runtime {
  readonly label: string;
  readonly command: string;
  readonly electron: boolean;
  readonly asar: boolean;
}
interface RunResult {
  readonly layout: Layout;
  readonly runtime: string;
  readonly versions?: Record<string, string | null>;
  readonly checks: Record<string, ProbeCheck>;
}

const ASAR_UNPACK = "{**/*.node,**/*.dylib,**/*.so,**/*.so.*,**/*.dll,**/spawn-helper}";
// Mirrors WINDOWS_SERVER_ASAR_IGNORE_GLOBS in build-desktop-artifact.ts: Cursor helpers are
// spawned and walked to by real path, so they live beside the archive as in desktop builds.
const ASAR_IGNORE = [
  "**/node_modules/@cursor/sdk-*",
  "**/node_modules/@cursor/sdk-*/**",
  "**/node_modules/.bin",
  "**/node_modules/.bin/**",
];
// node-pty's unix spawn-helper lookup only rewrites app.asar and node_modules.asar to their
// .unpacked siblings, so a server.asar (the Windows desktop name) cannot spawn a pty on macOS.
// oxlint-disable-next-line lecturn/no-global-process-runtime -- standalone harness, no Effect runtime.
const ASAR_NAME = process.platform === "win32" ? "server.asar" : "app.asar";
const PROBE_FILE = "smoke-pack-probe.mjs";
const READY_TIMEOUT_MS = 90_000;

const WorkspaceYaml = Schema.Struct({
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  allowBuilds: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
});
const decodeWorkspaceYaml = Schema.decodeUnknownSync(fromYaml(WorkspaceYaml));
const decodePackDescriptor = Schema.decodeUnknownSync(Schema.fromJsonString(LecturnPackDescriptor));

interface PackKit {
  readonly dir: string;
  readonly descriptor: LecturnPackDescriptor;
}

function run(
  command: string,
  args: ReadonlyArray<string>,
  options: NodeChildProcess.SpawnSyncOptions = {},
): string {
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    const output = `${String(result.stdout ?? "")}${String(result.stderr ?? "")}`.slice(-4_000);
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}\n${output}`);
  }
  return String(result.stdout ?? "");
}

function childEnv(runtime: Runtime): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("LECTURN_") && !key.startsWith("VITE_") && key !== "ELECTRON_RUN_AS_NODE",
    ),
  );
  return runtime.electron ? { ...env, ELECTRON_RUN_AS_NODE: "1" } : env;
}

function readTarballManifest(tarball: string): { name: string; version: string } {
  return JSON.parse(run("tar", ["-xzOf", tarball, "package/package.json"]));
}

function readPackKit(dir: string): PackKit {
  const descriptor = decodePackDescriptor(
    NodeFS.readFileSync(NodePath.join(dir, LECTURN_PACK_DESCRIPTOR_FILE), "utf8"),
  );
  return { dir, descriptor };
}

function packKit(outDir: string): PackKit {
  run(
    process.execPath,
    [NodePath.join(repoRoot, "apps/server/scripts/cli.ts"), "pack", "--out-dir", outDir],
    { stdio: "inherit" },
  );
  return readPackKit(outDir);
}

function kitTarballs(kit: PackKit): string[] {
  return Object.values(kit.descriptor.packages).map((pkg) => NodePath.join(kit.dir, pkg.tarball));
}

function installConsumer(input: {
  readonly dir: string;
  readonly layout: Layout;
  readonly tarballs: ReadonlyArray<string>;
  readonly kit: PackKit | undefined;
  readonly patches: boolean;
}): void {
  const rootManifest = JSON.parse(
    NodeFS.readFileSync(NodePath.join(repoRoot, "package.json"), "utf8"),
  ) as { packageManager: string };
  const workspace = decodeWorkspaceYaml(
    NodeFS.readFileSync(NodePath.join(repoRoot, "pnpm-workspace.yaml"), "utf8"),
  );
  NodeFS.mkdirSync(input.dir, { recursive: true });
  const dependencies = Object.fromEntries(
    input.tarballs.map((tarball) => [readTarballManifest(tarball).name, `file:${tarball}`]),
  );
  NodeFS.writeFileSync(
    NodePath.join(input.dir, "package.json"),
    `${JSON.stringify({ name: "lecturn-smoke-consumer", private: true, packageManager: rootManifest.packageManager, dependencies }, null, 2)}\n`,
  );
  const kitPnpm = input.kit?.descriptor.pnpm;
  const patchSource = input.kit?.dir ?? repoRoot;
  const patchedDependencies: Record<string, string> = {};
  if (input.patches) {
    const available =
      kitPnpm?.patchedDependencies ??
      // Only the runtime externals survive into the tarball's dependency closure.
      Object.fromEntries(
        Object.entries(workspace.patchedDependencies ?? {}).filter(
          ([selector]) =>
            selector.startsWith("@ff-labs/fff-node@") || selector.startsWith("node-pty@"),
        ),
      );
    for (const [selector, patchPath] of Object.entries(available)) {
      patchedDependencies[selector] = patchPath;
      const target = NodePath.join(input.dir, patchPath);
      NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
      NodeFS.copyFileSync(NodePath.join(patchSource, patchPath), target);
    }
  }
  // JSON is valid YAML, which keeps this free of a YAML encoder.
  NodeFS.writeFileSync(
    NodePath.join(input.dir, "pnpm-workspace.yaml"),
    `${JSON.stringify({
      nodeLinker: input.layout,
      allowBuilds: kitPnpm?.allowBuilds ?? {
        "node-pty": workspace.allowBuilds?.["node-pty"] ?? true,
      },
      ...(kitPnpm ? { publicHoistPattern: kitPnpm.publicHoistPattern } : {}),
      ...(Object.keys(patchedDependencies).length > 0 ? { patchedDependencies } : {}),
    })}\n`,
  );
  run("vp", ["install"], { cwd: input.dir, stdio: "inherit" });
}

function writeProbe(consumerDir: string): void {
  const source = NodeFS.readFileSync(
    NodePath.join(repoRoot, "scripts/smoke-pack-probe.ts"),
    "utf8",
  );
  const lecturnDir = NodeFS.realpathSync(NodePath.join(consumerDir, "node_modules/lecturn"));
  NodeFS.writeFileSync(
    NodePath.join(lecturnDir, "dist", PROBE_FILE),
    NodeModule.stripTypeScriptTypes(source),
  );
}

/** Lays the installed tree out as desktop ships it: an asar, natives unpacked beside it, Cursor helpers outside. */
async function packAsarTree(consumerDir: string, asarRoot: string): Promise<string> {
  NodeFS.mkdirSync(asarRoot, { recursive: true });
  const asarPath = NodePath.join(asarRoot, ASAR_NAME);
  await createPackageWithOptions(consumerDir, asarPath, {
    dot: true,
    unpack: ASAR_UNPACK,
    globOptions: { cwd: consumerDir, ignore: ASAR_IGNORE },
  });
  const lecturnDir = NodeFS.realpathSync(NodePath.join(consumerDir, "node_modules/lecturn"));
  const sdkLink = [
    NodePath.join(consumerDir, "node_modules/@cursor/sdk"),
    NodePath.join(NodePath.dirname(lecturnDir), "@cursor/sdk"),
  ].find((candidate) => NodeFS.existsSync(candidate));
  if (sdkLink === undefined) throw new Error("@cursor/sdk is not installed");
  const cursorDir = NodePath.dirname(NodeFS.realpathSync(sdkLink));
  // Same copy as stageCursorSdkPlatformPackages: helpers beside the archive, real files.
  const helperTarget = NodePath.join(asarRoot, "node_modules/@cursor");
  NodeFS.mkdirSync(helperTarget, { recursive: true });
  for (const name of NodeFS.readdirSync(cursorDir)) {
    if (!name.startsWith("sdk-")) continue;
    NodeFS.cpSync(
      NodeFS.realpathSync(NodePath.join(cursorDir, name)),
      NodePath.join(helperTarget, name),
      { recursive: true },
    );
  }
  return asarPath;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

function runProbe(
  runtime: Runtime,
  treeRoot: string,
  consumerDir: string,
): { versions?: Record<string, string | null>; checks: Record<string, ProbeCheck> } {
  const lecturnDir = NodePath.join(treeRoot, "node_modules/lecturn");
  const entries = [NodePath.join(lecturnDir, "dist/bin.mjs")];
  if (!runtime.asar) {
    const real = NodePath.join(
      NodeFS.realpathSync(NodePath.join(consumerDir, "node_modules/lecturn")),
      "dist/bin.mjs",
    );
    if (real !== entries[0]) entries.push(real);
  }
  const result = NodeChildProcess.spawnSync(
    runtime.command,
    [NodePath.join(lecturnDir, "dist", PROBE_FILE), ...entries],
    { encoding: "utf8", env: childEnv(runtime), timeout: 120_000 },
  );
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  try {
    const parsed = JSON.parse(line) as {
      runtime: Record<string, string | null>;
      checks: Record<string, ProbeCheck>;
    };
    return { versions: parsed.runtime, checks: parsed.checks };
  } catch {
    return {
      checks: {
        probe: {
          ok: false,
          detail: `probe exited ${result.status ?? result.signal}: ${result.stderr.slice(-1_500)}`,
        },
      },
    };
  }
}

async function runServer(runtime: Runtime, treeRoot: string, workDir: string): Promise<ProbeCheck> {
  const baseDir = NodePath.join(workDir, "base");
  const logPath = NodePath.join(workDir, "server.log");
  const log = NodeFS.openSync(logPath, "w");
  const port = await freePort();
  const entry = NodePath.join(treeRoot, "node_modules/lecturn/dist/bin.mjs");
  // stdout carries the startup pairing token, so it only goes to the temp log.
  const child = NodeChildProcess.spawn(
    runtime.command,
    [
      entry,
      "serve",
      "--base-dir",
      baseDir,
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--no-browser",
    ],
    { cwd: workDir, env: childEnv(runtime), stdio: ["ignore", log, log] },
  );
  const state = { exited: false, exitStatus: "" };
  const exitPromise = new Promise<void>((resolve) => {
    child.once("exit", (code, signal) => {
      state.exited = true;
      state.exitStatus = String(code ?? signal);
      resolve();
    });
  });
  const url = `http://127.0.0.1:${port}/.well-known/lecturn/environment`;
  const startedAt = Date.now();
  try {
    while (Date.now() - startedAt < READY_TIMEOUT_MS && !state.exited) {
      // A request that connects while the server is still booting is never answered, so each
      // attempt carries its own deadline instead of waiting on one hung connection.
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) }).catch(
        () => undefined,
      );
      if (response !== undefined) {
        const body = await response.text();
        if (!response.ok) throw new Error(`GET ${url} -> ${response.status} ${body.slice(0, 400)}`);
        const descriptor = JSON.parse(body) as { serverVersion?: string; environmentId?: string };
        return {
          ok: true,
          detail: `200 after ${Date.now() - startedAt} ms; serverVersion ${descriptor.serverVersion}, environmentId set: ${typeof descriptor.environmentId === "string"}`,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const tail = NodeFS.readFileSync(logPath, "utf8")
      .replace(/token=[^\s&"]+/g, "token=<redacted>")
      .replace(/Token: \S+/g, "Token: <redacted>");
    throw new Error(
      `${!state.exited ? "not ready in time" : `exited ${state.exitStatus}`}: ${tail.slice(-1_500)}`,
    );
  } catch (cause) {
    return { ok: false, detail: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    if (!state.exited && child.pid !== undefined) {
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await exitPromise;
      clearTimeout(killTimer);
    }
    NodeFS.closeSync(log);
  }
}

const EMBED_IMPORT_SOURCE = `
const node = await import("@lecturn/embed/node");
const browser = await import("@lecturn/embed/browser");
const types = ["node", "browser", "electron", "renderer"].map((entry) =>
  import.meta.resolve("@lecturn/embed/" + entry).replace(/\\.mjs$/, ".d.mts"),
);
const fs = await import("node:fs");
const url = await import("node:url");
console.log(JSON.stringify({
  connect: typeof node.connect,
  mountEmbed: typeof browser.mountEmbed,
  missingTypes: types.filter((file) => !fs.existsSync(url.fileURLToPath(file))),
}));
`;

/** Loads the embed package as a host would, which also proves its workspace imports were bundled. */
function runEmbedImport(consumerDir: string): ProbeCheck {
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    ["--input-type=module", "-e", EMBED_IMPORT_SOURCE],
    { cwd: consumerDir, encoding: "utf8", timeout: 60_000 },
  );
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  try {
    const parsed = JSON.parse(line) as {
      connect: string;
      mountEmbed: string;
      missingTypes: string[];
    };
    const ok =
      parsed.connect === "function" &&
      parsed.mountEmbed === "function" &&
      parsed.missingTypes.length === 0;
    return { ok, detail: line };
  } catch {
    return {
      ok: false,
      detail: `exited ${result.status ?? result.signal}: ${result.stderr.slice(-1_500)}`,
    };
  }
}

function formatTable(results: ReadonlyArray<RunResult>): string {
  const names = [...new Set(results.flatMap((result) => Object.keys(result.checks)))];
  const header = `| layout | runtime | ${names.join(" | ")} |`;
  const divider = `|${" --- |".repeat(names.length + 2)}`;
  const rows = results.map(
    (result) =>
      `| ${result.layout} | ${result.runtime} | ${names
        .map((name) => {
          const value = result.checks[name];
          return value === undefined ? "-" : value.ok ? "ok" : "FAIL";
        })
        .join(" | ")} |`,
  );
  return [header, divider, ...rows].join("\n");
}

async function main(): Promise<void> {
  const { values } = NodeUtil.parseArgs({
    options: {
      electron: { type: "string" },
      asar: { type: "boolean", default: false },
      layout: { type: "string", default: "hoisted" },
      "pack-dir": { type: "string" },
      tarball: { type: "string", multiple: true },
      patches: { type: "boolean", default: false },
      json: { type: "string" },
      keep: { type: "boolean", default: false },
    },
  });
  if (values.asar && values.electron === undefined) throw new Error("--asar needs --electron");
  if (values["pack-dir"] !== undefined && values.tarball !== undefined) {
    throw new Error("--pack-dir and --tarball are exclusive");
  }
  const layouts: Layout[] =
    values.layout === "both" ? ["isolated", "hoisted"] : [values.layout as Layout];
  const runtimes: Runtime[] = [
    {
      label: `node ${process.versions.node}`,
      command: process.execPath,
      electron: false,
      asar: false,
    },
  ];
  if (values.electron !== undefined) {
    const electron = NodePath.resolve(values.electron);
    runtimes.push({ label: "electron-as-node", command: electron, electron: true, asar: false });
    if (values.asar) {
      runtimes.push({
        label: "electron-as-node asar",
        command: electron,
        electron: true,
        asar: true,
      });
    }
  }

  const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lecturn-smoke-pack-"));
  const results: RunResult[] = [];
  try {
    const kit =
      values.tarball !== undefined
        ? undefined
        : values["pack-dir"] !== undefined
          ? readPackKit(NodePath.resolve(values["pack-dir"]))
          : packKit(NodePath.join(tmp, "kit"));
    const tarballs =
      kit === undefined
        ? (values.tarball ?? []).map((tarball) => NodePath.resolve(tarball))
        : kitTarballs(kit);
    console.log(
      `[smoke] tarballs: ${tarballs.map((tarball) => NodePath.basename(tarball)).join(", ")}`,
    );
    for (const layout of layouts) {
      const consumerDir = NodePath.join(tmp, `install-${layout}`);
      installConsumer({ dir: consumerDir, layout, tarballs, kit, patches: values.patches });
      const embedInstalled = NodeFS.existsSync(
        NodePath.join(consumerDir, "node_modules/@lecturn/embed/package.json"),
      );
      writeProbe(consumerDir);
      let asarRoot: string | undefined;
      for (const runtime of runtimes) {
        // Same rule as the desktop sidecar build: an asar cannot carry pnpm's symlink layout.
        if (runtime.asar && layout === "isolated") {
          console.log("[smoke] skipping isolated / asar: asar needs a physical (hoisted) tree");
          continue;
        }
        let treeRoot = consumerDir;
        if (runtime.asar) {
          asarRoot ??= NodePath.join(tmp, `asar-${layout}`);
          if (!NodeFS.existsSync(NodePath.join(asarRoot, ASAR_NAME))) {
            await packAsarTree(consumerDir, asarRoot);
          }
          treeRoot = NodePath.join(asarRoot, ASAR_NAME);
        }
        const label = runtime.electron
          ? `${runtime.label} (${run(runtime.command, ["-p", "process.versions.electron"], { env: childEnv(runtime) }).trim()})`
          : runtime.label;
        console.log(`[smoke] ${layout} / ${label}`);
        const probe = runProbe(runtime, treeRoot, consumerDir);
        const workDir = NodePath.join(tmp, `run-${layout}-${results.length}`);
        NodeFS.mkdirSync(workDir, { recursive: true });
        const server = await runServer(runtime, treeRoot, workDir);
        results.push({
          layout,
          runtime: label,
          ...(probe.versions ? { versions: probe.versions } : {}),
          checks: {
            ...probe.checks,
            wellKnown: server,
            ...(embedInstalled && !runtime.electron ? { embed: runEmbedImport(consumerDir) } : {}),
          },
        });
      }
    }
  } finally {
    if (values.keep) console.log(`[smoke] kept ${tmp}`);
    else NodeFS.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${formatTable(results)}\n`);
  for (const result of results) {
    for (const [name, value] of Object.entries(result.checks)) {
      console.log(
        `- ${result.layout} / ${result.runtime} / ${name}: ${value.ok ? "ok" : "FAIL"} ${value.detail}`,
      );
    }
  }
  if (values.json !== undefined) {
    NodeFS.writeFileSync(values.json, `${JSON.stringify(results, null, 2)}\n`);
  }
  if (results.some((result) => Object.values(result.checks).some((value) => !value.ok))) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}

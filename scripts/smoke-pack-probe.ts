// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - runs as plain JS inside an installed tarball tree, where Effect is not resolvable.
/**
 * In-process probes for scripts/smoke-pack-install.ts. The smoke script strips the types and
 * writes this file next to the installed lecturn/dist/bin.mjs, so every `require` here resolves
 * exactly as the bundled server's own createRequire(import.meta.url) calls do.
 *
 * Usage (internal): <runtime> <lecturn>/dist/smoke-pack-probe.mjs <serverEntry> [<realServerEntry>]
 * The real entry differs from the first only in an isolated install, where node_modules/lecturn
 * is a symlink and a host that resolves the entry through Node gets the .pnpm path.
 * Prints one JSON line: { runtime, checks: { [name]: { ok, detail } } }.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export interface ProbeCheck {
  readonly ok: boolean;
  readonly detail: string;
}

// The workspace does not depend on these packages; only the surface the probes call is typed.
interface NodePty {
  spawn(
    file: string,
    args: ReadonlyArray<string>,
    options: Record<string, unknown>,
  ): {
    readonly pid: number;
    onData(listener: (data: string) => void): void;
    onExit(listener: (event: { exitCode: number }) => void): void;
    kill(): void;
  };
}
type FffResult<T> = { ok: true; value: T } | { ok: false; error: string };
interface FffItem {
  readonly relativePath: string;
  readonly lineContent?: string;
}
interface FffFinder {
  waitForIndexReady(timeoutMs: number): Promise<FffResult<boolean>>;
  fileSearch(query: string, options: { pageSize: number }): FffResult<{ items: FffItem[] }>;
  grep(
    query: string,
    options: { mode: "plain"; pageSize: number },
  ): FffResult<{ items: FffItem[] }>;
  destroy(): void;
}
interface FffModule {
  readonly FileFinder: { create(options: Record<string, unknown>): FffResult<FffFinder> };
}

const requireHere = NodeModule.createRequire(import.meta.url);
const { platform, arch } = process;

/** Satisfies for the `^a.b || ^c.d || >=e.f` shape of apps/server engines.node. */
export function satisfiesEnginesRange(version: string, range: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  const compare = (a: ReadonlyArray<number>, b: ReadonlyArray<number>) => {
    for (let index = 0; index < 3; index += 1) {
      const delta = (a[index] ?? 0) - (b[index] ?? 0);
      if (delta !== 0) return delta;
    }
    return 0;
  };
  const current = [major, minor, patch];
  return range.split("||").some((clause) => {
    const trimmed = clause.trim();
    const floor = trimmed
      .replace(/^(\^|>=)/, "")
      .split(".")
      .map(Number);
    if (floor.some((part) => Number.isNaN(part))) return false;
    if (compare(current, floor) < 0) return false;
    return trimmed.startsWith(">=") || major === floor[0];
  });
}

/**
 * Mirrors @cursor/sdk's platform-package-locator: walk up from dirname(argv[1]), then from
 * dirname(execPath), looking for node_modules/@cursor/sdk-<platform>-<arch>/<relativePath>.
 */
export function locateCursorHelper(
  startDirs: ReadonlyArray<string>,
  relativePath: string,
): string | undefined {
  const packageName = `@cursor/sdk-${platform}-${arch}`;
  for (const startDir of startDirs) {
    let dir = NodePath.resolve(startDir);
    const root = NodePath.parse(dir).root;
    while (dir !== root) {
      const candidate = NodePath.join(dir, "node_modules", packageName, relativePath);
      if (isExecutableFile(candidate)) return candidate;
      dir = NodePath.dirname(dir);
    }
  }
  return undefined;
}

function isExecutableFile(candidate: string): boolean {
  try {
    const stat = NodeFS.statSync(candidate);
    return stat.isFile() && (platform === "win32" || (stat.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}

async function check(run: () => Promise<string> | string): Promise<ProbeCheck> {
  try {
    return { ok: true, detail: await run() };
  } catch (cause) {
    return { ok: false, detail: errorText(cause) };
  }
}

function probeEngines(): string {
  const manifest = requireHere("../package.json") as { engines?: { node?: string } };
  const range = manifest.engines?.node ?? "";
  if (!satisfiesEnginesRange(process.versions.node, range)) {
    throw new Error(`node ${process.versions.node} does not satisfy engines "${range}"`);
  }
  return `node ${process.versions.node} satisfies "${range}"`;
}

async function probeSqlite(scratch: string): Promise<string> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(NodePath.join(scratch, "probe.sqlite"));
  try {
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE probe (value TEXT)");
    db.prepare("INSERT INTO probe (value) VALUES (?)").run("sqlite-ok");
    const row = db.prepare("SELECT value, sqlite_version() AS version FROM probe").get() as
      | { value: string; version: string }
      | undefined;
    if (row?.value !== "sqlite-ok") throw new Error(`unexpected row ${JSON.stringify(row)}`);
    return `sqlite ${row.version} (WAL file db)`;
  } finally {
    db.close();
  }
}

function probeNodePty(): Promise<string> {
  const pty = requireHere("node-pty") as NodePty;
  const packageDir = NodePath.dirname(requireHere.resolve("node-pty/package.json"));
  const helper = NodePath.join(packageDir, "prebuilds", `${platform}-${arch}`, "spawn-helper");
  const helperState = NodeFS.existsSync(helper)
    ? isExecutableFile(helper)
      ? "spawn-helper executable"
      : "spawn-helper NOT executable"
    : "no prebuilt spawn-helper";
  return new Promise((resolve, reject) => {
    const child = pty.spawn("/bin/sh", ["-c", "printf pty-ok"], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: NodeOS.tmpdir(),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`pty spawn timed out (${helperState}), output ${JSON.stringify(output)}`));
    }, 10_000);
    child.onData((data) => {
      output += data;
    });
    child.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (exitCode === 0 && output.includes("pty-ok")) {
        resolve(`pid ${child.pid} printed pty-ok, exit 0 (${helperState})`);
      } else {
        reject(new Error(`exit ${exitCode}, output ${JSON.stringify(output)} (${helperState})`));
      }
    });
  });
}

async function probeFff(scratch: string): Promise<string> {
  const resolved = requireHere.resolve("@ff-labs/fff-node");
  const { FileFinder } = requireHere("@ff-labs/fff-node") as FffModule;
  const basePath = NodePath.join(scratch, "fff");
  const relativePaths = ["alpha/one.ts", "café/two.ts", "日本語/three.ts", "emoji-🦊/four.ts"];
  const content = "prefix marker-日本語🦊\n";
  for (const relativePath of relativePaths) {
    NodeFS.mkdirSync(NodePath.join(basePath, NodePath.dirname(relativePath)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(basePath, relativePath), content);
  }
  const unwrap = <T>(result: FffResult<T>): T => {
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };
  const finder = unwrap(
    FileFinder.create({ basePath, disableWatch: true, disableMmapCache: true }),
  );
  try {
    if (!unwrap(await finder.waitForIndexReady(10_000))) throw new Error("index not ready in 10 s");
    const expected = relativePaths.toSorted().join(",");
    const files = unwrap(finder.fileSearch("", { pageSize: 100 }));
    const found = files.items.map((item) => item.relativePath.normalize("NFC")).toSorted();
    if (found.join(",") !== expected) throw new Error(`fileSearch returned ${found.join(",")}`);
    const grep = unwrap(finder.grep("marker", { mode: "plain", pageSize: 100 }));
    const grepped = grep.items.map((item) => item.relativePath.normalize("NFC")).toSorted();
    if (grepped.join(",") !== expected) throw new Error(`grep returned ${grepped.join(",")}`);
    const line = grep.items[0]?.lineContent;
    if (line !== content.trimEnd()) throw new Error(`grep line ${JSON.stringify(line)}`);
    return `fileSearch+grep matched ${found.length} unicode paths via ${NodePath.basename(resolved)}`;
  } finally {
    finder.destroy();
  }
}

/**
 * Only the argv[1] walk is probed: the SDK's execPath fallback would find helpers in whatever
 * workspace the Electron binary under test happens to live in, which a packaged host never has.
 */
function probeCursor(serverEntry: string): string {
  const startDirs = [NodePath.dirname(NodePath.resolve(serverEntry))];
  const lines: string[] = [];
  for (const binary of ["cursorsandbox", "rg"]) {
    const found = locateCursorHelper(startDirs, NodePath.join("bin", binary));
    if (found === undefined) throw new Error(`${binary} not found walking up from ${startDirs[0]}`);
    if (binary === "rg") {
      NodeChildProcess.execFileSync(found, ["--version"], { stdio: "ignore", timeout: 10_000 });
    }
    lines.push(`${binary} at ${found}${binary === "rg" ? " (ran)" : ""}`);
  }
  return lines.join("; ");
}

async function main(): Promise<void> {
  const serverEntries = process.argv.slice(2);
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lecturn-smoke-probe-"));
  try {
    const checks: Record<string, ProbeCheck> = {
      engines: await check(probeEngines),
      sqlite: await check(() => probeSqlite(scratch)),
      nodePty: await check(probeNodePty),
      fff: await check(() => probeFff(scratch)),
      ...Object.fromEntries(
        await Promise.all(
          serverEntries.map(async (entry, index) => [
            index === 0 ? "cursorHelper" : "cursorHelperRealEntry",
            await check(() => probeCursor(entry)),
          ]),
        ),
      ),
    };
    process.stdout.write(
      `${JSON.stringify({
        runtime: {
          node: process.versions.node,
          electron: process.versions.electron ?? null,
          modules: process.versions.modules,
          napi: process.versions.napi,
        },
        checks,
      })}\n`,
    );
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await main();
}

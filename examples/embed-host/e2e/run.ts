// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off -- Test runner for real Electron runs; it runs no Effect runtime.
/**
 * Electron end-to-end scenarios. They need a display and a built example, so
 * this is the `e2e` script, never `test` (CI's Test job has no display).
 *
 *   vp run --filter embed-host build
 *   vp run --filter embed-host e2e -- [scenario...]     # e.g. tracer; all by default
 *
 * EMBED_HOST_E2E_ARTIFACTS=<dir> writes `<scenario>-e2e.log` and captures
 * there; EMBED_HOST_E2E_KEEP=1 keeps each run's temp directory.
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export interface E2eContext {
  readonly log: (line: string) => void;
  readonly artifactsDir: string | undefined;
  readonly keep: boolean;
}

type Scenario = (context: E2eContext) => Promise<void>;

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const SUFFIX = ".e2e.ts";

async function runScenario(name: string, artifactsDir: string | undefined): Promise<boolean> {
  const lines: Array<string> = [];
  const log = (line: string) => {
    const stamped = `[${new Date().toISOString()}] ${line}`;
    lines.push(stamped);
    console.log(`[${name}] ${line}`);
  };
  let passed = false;
  try {
    const module = (await import(
      NodeURL.pathToFileURL(NodePath.join(here, `${name}${SUFFIX}`)).href
    )) as {
      readonly default: Scenario;
    };
    await module.default({ log, artifactsDir, keep: process.env["EMBED_HOST_E2E_KEEP"] === "1" });
    passed = true;
    log("PASS");
  } catch (error) {
    log(`FAIL ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }
  if (artifactsDir !== undefined) {
    await NodeFSP.writeFile(
      NodePath.join(artifactsDir, `${name}-e2e.log`),
      `${lines.join("\n")}\n`,
    );
  }
  return passed;
}

const available = NodeFS.readdirSync(here)
  .filter((file) => file.endsWith(SUFFIX))
  .map((file) => file.slice(0, -SUFFIX.length));
const requested = process.argv.slice(2).filter((arg) => arg !== "--");
const unknown = requested.filter((name) => !available.includes(name));
if (unknown.length > 0) {
  console.error(`Unknown scenario ${unknown.join(", ")}; available: ${available.join(", ")}`);
  process.exit(2);
}

const artifactsDir = process.env["EMBED_HOST_E2E_ARTIFACTS"];
if (artifactsDir !== undefined) await NodeFSP.mkdir(artifactsDir, { recursive: true });
let failed = 0;
for (const name of requested.length > 0 ? requested : available) {
  if (!(await runScenario(name, artifactsDir))) failed += 1;
}
process.exit(failed === 0 ? 0 : 1);

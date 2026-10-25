// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off -- Test runner for real Electron runs; it runs no Effect runtime.
/**
 * Electron end-to-end scenarios. They need a display and a built example, so
 * this is the `e2e` script, never `test` (CI's Test job has no display).
 *
 *   vp run --filter embed-host build
 *   vp run --filter embed-host e2e -- [scenario...]     # e.g. tracer; all by default
 *   vp run --filter embed-host e2e -- --steps 1,2       # spec B2's gold scenario (scenario.ts)
 *   vp run --filter embed-host e2e -- --steps 3,4,5,ledger   # the attach flow and its copy ledger
 *   vp run --filter embed-host e2e -- captures          # the probed CP2 embed bar captures
 *
 * EMBED_HOST_E2E_ARTIFACTS=<dir> writes `<scenario>-e2e.log` and captures
 * there; EMBED_HOST_E2E_KEEP=1 keeps each run's temp directory.
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

/** A spec B2 step number, or `ledger`: the copy-ledger checks after step 5 (D33). */
export type ScenarioStep = number | "ledger";

export interface E2eContext {
  readonly log: (line: string) => void;
  readonly artifactsDir: string | undefined;
  readonly keep: boolean;
  /** Steps for scenario.ts; its automated steps when omitted. */
  readonly steps?: ReadonlyArray<ScenarioStep>;
}

type Scenario = (context: E2eContext) => Promise<void>;

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const SUFFIX = ".e2e.ts";
// The gold scenario is named for the spec, not the e2e suffix, so it has its own entry.
const GOLD_SCENARIO = "scenario";
const fileFor = (name: string) => (name === GOLD_SCENARIO ? `${name}.ts` : `${name}${SUFFIX}`);

async function runScenario(
  name: string,
  artifactsDir: string | undefined,
  steps: ReadonlyArray<ScenarioStep> | undefined,
): Promise<boolean> {
  const lines: Array<string> = [];
  const log = (line: string) => {
    const stamped = `[${new Date().toISOString()}] ${line}`;
    lines.push(stamped);
    console.log(`[${name}] ${line}`);
  };
  let passed = false;
  try {
    const module = (await import(
      NodeURL.pathToFileURL(NodePath.join(here, fileFor(name))).href
    )) as {
      readonly default: Scenario;
    };
    await module.default({
      log,
      artifactsDir,
      keep: process.env["EMBED_HOST_E2E_KEEP"] === "1",
      ...(steps === undefined ? {} : { steps }),
    });
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

const available = [
  ...NodeFS.readdirSync(here)
    .filter((file) => file.endsWith(SUFFIX))
    .map((file) => file.slice(0, -SUFFIX.length)),
  GOLD_SCENARIO,
];
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const stepsAt = args.indexOf("--steps");
const steps =
  stepsAt === -1
    ? undefined
    : (args[stepsAt + 1] ?? "")
        .split(",")
        .filter((step) => step.length > 0)
        .map((step): ScenarioStep => (step === "ledger" ? step : Number(step)));
if (
  steps !== undefined &&
  (steps.length === 0 || steps.some((step) => step !== "ledger" && !Number.isInteger(step)))
) {
  console.error(
    "--steps takes B2 step numbers or `ledger`, e.g. --steps 1,2 or --steps 3,4,5,ledger",
  );
  process.exit(2);
}
const named =
  stepsAt === -1 ? args : args.filter((_, index) => index < stepsAt || index > stepsAt + 1);
// `--steps` alone means the gold scenario.
const requested = steps !== undefined && named.length === 0 ? [GOLD_SCENARIO] : named;
const unknown = requested.filter((name) => !available.includes(name));
if (unknown.length > 0) {
  console.error(`Unknown scenario ${unknown.join(", ")}; available: ${available.join(", ")}`);
  process.exit(2);
}

const artifactsDir = process.env["EMBED_HOST_E2E_ARTIFACTS"];
if (artifactsDir !== undefined) await NodeFSP.mkdir(artifactsDir, { recursive: true });
let failed = 0;
for (const name of requested.length > 0 ? requested : available) {
  if (!(await runScenario(name, artifactsDir, name === GOLD_SCENARIO ? steps : undefined)))
    failed += 1;
}
process.exit(failed === 0 ? 0 : 1);

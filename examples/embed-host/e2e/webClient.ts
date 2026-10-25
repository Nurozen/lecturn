// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Test harness driving a real Electron window; it runs no Effect runtime.
/**
 * A signed-in Lecturn web client for the attach steps: the user server's own
 * web app in a window of a second, bare Electron process, paired with a
 * one-time link (`lecturn pair`). It is its own process so it outlives the
 * host when step 4 closes it.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { _electron, type ElectronApplication, type Page } from "playwright-core";

import { resolveElectronAppLaunch } from "../scripts/electronLauncher.ts";
import { lecturnBin } from "./adminClient.ts";
import { until } from "./harness.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const QUIT_TIMEOUT_MS = 20_000;

// Keeps running with no window open, and keeps Electron's state in the run's temp dir.
const MAIN_SCRIPT = `const { app } = require("electron");
app.setPath("userData", require("node:path").join(__dirname, "user-data"));
app.on("window-all-closed", () => {});
`;

export interface WebClient {
  readonly page: Page;
  readonly origin: string;
  close(): Promise<void>;
}

async function pairingUrl(baseDir: string): Promise<string> {
  const { stdout } = await execFile(
    process.execPath,
    [lecturnBin(), "pair", "--base-dir", baseDir],
    { env: { ...process.env, LECTURN_HOME: baseDir }, timeout: 60_000 },
  );
  const url = /Pairing URL:\s*(\S+)/u.exec(stdout)?.[1];
  if (url === undefined) throw new Error(`lecturn pair printed no URL:\n${stdout}`);
  return url;
}

export async function openWebClient(input: {
  /** The run's temp dir; the client's Electron state goes under it. */
  readonly root: string;
  /** The user server's base dir, where the pairing link is minted. */
  readonly baseDir: string;
}): Promise<WebClient> {
  const dir = NodePath.join(input.root, "web-client");
  await NodeFSP.mkdir(dir, { recursive: true });
  const mainPath = NodePath.join(dir, "main.cjs");
  await NodeFSP.writeFile(mainPath, MAIN_SCRIPT);

  const command = await resolveElectronAppLaunch(mainPath);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE") env[key] = value;
  }
  const app: ElectronApplication = await _electron.launch({
    executablePath: command.electronPath,
    args: [...command.args],
    cwd: dir,
    env,
  });
  const child = app.process();
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
  const close = async () => {
    void app.close().catch(() => undefined);
    const quit = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), QUIT_TIMEOUT_MS)),
    ]);
    if (!quit) {
      child.kill("SIGKILL");
      await exited;
    }
  };

  try {
    const url = await pairingUrl(input.baseDir);
    const origin = new URL(url).origin;
    await app.evaluate(({ BrowserWindow }, target) => {
      const win = new BrowserWindow({ width: 1440, height: 900, title: "Lecturn web client" });
      void win.loadURL(target);
    }, url);
    const page = await until("the web client window", 30_000, async () =>
      app
        .context()
        .pages()
        .find((candidate) => candidate.url().startsWith(origin)),
    );
    // Pairing lands on the app with a session cookie; the sidebar means it is signed in.
    await page
      .locator('[aria-label="Sidebar mode"]')
      .waitFor({ state: "visible", timeout: 60_000 });
    return { page, origin, close };
  } catch (error) {
    await close();
    throw error;
  }
}

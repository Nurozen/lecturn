// @effect-diagnostics nodeBuiltinImport:off -- Host-side tooling with no Effect runtime.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const embedHostDir = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);
const launcherPath = NodePath.resolve(
  embedHostDir,
  "../../apps/desktop/scripts/electron-launcher.mjs",
);

export interface ElectronLaunchCommand {
  readonly electronPath: string;
  readonly args: ReadonlyArray<string>;
}

/**
 * Electron from the workspace, the way the desktop app's own scripts launch it
 * (a renamed runtime copy on macOS, `--no-sandbox` where Linux needs it).
 */
export function resolveEmbedHostLaunch(
  args: ReadonlyArray<string> = [],
): Promise<ElectronLaunchCommand> {
  return resolveElectronAppLaunch(embedHostDir, args);
}

/** The same Electron, running another app: a directory with a package.json, or a main script. */
export async function resolveElectronAppLaunch(
  app: string,
  args: ReadonlyArray<string> = [],
): Promise<ElectronLaunchCommand> {
  // Read when the launcher loads: with it set, the macOS runtime copy becomes
  // a launcher for Lecturn's own desktop main instead of this app.
  delete process.env["VITE_DEV_SERVER_URL"];
  const launcher = (await import(NodeURL.pathToFileURL(launcherPath).href)) as {
    resolveElectronLaunchCommand(args: ReadonlyArray<string>): ElectronLaunchCommand;
  };
  return launcher.resolveElectronLaunchCommand([app, ...args]);
}

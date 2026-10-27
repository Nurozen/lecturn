// @effect-diagnostics nodeBuiltinImport:off -- Test harness driving a real Electron app; it runs no Effect runtime.
/**
 * The theme probe (themeProbe.ts) against the real embed
 * guest, with RocketWright's full generated token set and fonts as sent: every
 * allowlisted variable's computed value equals the sent one, every sent font
 * is loaded and used, and the pane background pixel is exactly `--background`.
 * It writes `theme-probe.json` and `theme-probe-pane.png` to the artifacts
 * directory.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { embedHostDir } from "../scripts/electronLauncher.ts";
import { type HostGlobals, launchEmbedHost, removeDirs } from "./harness.ts";
import type { E2eContext } from "./run.ts";
import {
  collectGuestTheme,
  evaluateThemeProbe,
  type RgbaImage,
  samplePixel,
  type SentEmbedTheme,
} from "./themeProbe.ts";

// pngjs is a dependency of the repo's scripts package; this example does not install it.
const { PNG } = NodeModule.createRequire(
  NodePath.resolve(embedHostDir, "../../scripts/package.json"),
)("pngjs") as { readonly PNG: { readonly sync: { read(buffer: Buffer): RgbaImage } } };

const THEME_TIMEOUT_MS = 15_000;

export default async function theme({ log, artifactsDir, keep }: E2eContext): Promise<void> {
  const run = await launchEmbedHost();
  try {
    const sentPath = NodePath.join(embedHostDir, "src", "rocketwright-theme.json");
    const sent = JSON.parse(await NodeFSP.readFile(sentPath, "utf8")) as SentEmbedTheme;

    const guest = await run.guestPage("/embed/");
    await guest.waitForLoadState("load");
    await guest
      .getByText(/No threads in this project yet|New thread/)
      .first()
      .waitFor({ timeout: 60_000 });
    // The host context arrives after load; a timeout here is left for the probe to report.
    await guest
      .waitForFunction(
        (background) =>
          getComputedStyle(document.documentElement).getPropertyValue("--background").trim() ===
          background,
        sent.variables["--background"],
        { timeout: THEME_TIMEOUT_MS },
      )
      .catch(() => log(`--background did not reach the sent value in ${THEME_TIMEOUT_MS} ms`));

    const observed = await collectGuestTheme(guest);
    const out = artifactsDir ?? (await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "theme-")));
    const capturePath = NodePath.join(out, "theme-probe-pane.png");
    await run.app.evaluate(
      (_electron, path) => (globalThis as HostGlobals).embedHost!.capture(path),
      capturePath,
    );
    const capture = PNG.sync.read(await NodeFSP.readFile(capturePath));
    const point = { x: Math.round(capture.width / 2), y: Math.round(capture.height * 0.75) };
    const report = evaluateThemeProbe({
      sent,
      observed,
      backgroundPixel: samplePixel(capture, point.x, point.y),
    });
    const reportPath = NodePath.join(out, "theme-probe.json");
    await NodeFSP.writeFile(
      reportPath,
      `${JSON.stringify(
        {
          sentFile: NodePath.relative(embedHostDir, sentPath),
          capture: capturePath,
          backgroundPoint: point,
          capturedSize: { width: capture.width, height: capture.height },
          ...report,
          observed,
        },
        null,
        2,
      )}\n`,
    );
    const failed = report.checks.filter((check) => !check.passed);
    log(
      `theme probe: ${report.checks.length - failed.length}/${report.checks.length} checks pass (${reportPath})`,
    );
    if (failed.length > 0) {
      throw new Error(
        `Theme probe failed:\n${failed
          .map((check) => `  ${check.name}: expected ${check.expected}, got ${check.actual}`)
          .join("\n")}`,
      );
    }
  } catch (error) {
    log(`--- embed-host output ---\n${run.output()}`);
    throw error;
  } finally {
    await run.close();
    if (keep) log(`kept ${run.dirs.root}`);
    else await removeDirs(run.dirs);
  }
}

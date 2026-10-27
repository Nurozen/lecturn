// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off -- A plain Electron host with no Effect runtime.
// A static guest page on two loopback origins, for checking Playwright reach, retarget, the
// frozen clock and font loading without a Lecturn server. `electron dist/static-main.mjs`.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Electron from "electron";
import {
  EMBED_TO_GUEST_CHANNEL,
  captureEmbedView,
  mountEmbedView,
  type EmbedBridge,
} from "@lecturn/embed/electron";

import { hostContextFontsMessage, startStaticGuest } from "./staticGuest.ts";

const FONT_FORMATS: Record<string, { readonly mime: string; readonly format: string }> = {
  ".woff2": { mime: "font/woff2", format: "woff2" },
  ".woff": { mime: "font/woff", format: "woff" },
  ".ttf": { mime: "font/ttf", format: "truetype" },
  ".otf": { mime: "font/otf", format: "opentype" },
};

const cdpPort = process.env["EMBED_HOST_CDP_PORT"];
if (cdpPort) Electron.app.commandLine.appendSwitch("remote-debugging-port", cdpPort);
const freezeClockEnv = process.env["EMBED_HOST_FREEZE_CLOCK"];
const freezeClock = freezeClockEnv ? Number(freezeClockEnv) : undefined;

async function fontFaceCss(files: ReadonlyArray<string>): Promise<string> {
  const rules = await Promise.all(
    files.map(async (file, index) => {
      const kind = FONT_FORMATS[NodePath.extname(file).toLowerCase()];
      if (!kind) throw new Error(`Unsupported font file: ${file}`);
      const data = (await NodeFSP.readFile(file)).toString("base64");
      return `@font-face { font-family: "EmbedProbe${index}"; src: url(data:${kind.mime};base64,${data}) format("${kind.format}"); }`;
    }),
  );
  return rules.join("\n");
}

async function main() {
  await Electron.app.whenReady();
  // Two loopback origins so a retarget crosses origins like the sidecar to
  // user-server switch does.
  const guests = [await startStaticGuest(), await startStaticGuest()];
  let guestIndex = 0;
  const currentOrigin = () => guests[guestIndex]!.origin;

  const win = new Electron.BrowserWindow({ width: 1200, height: 800, title: "embed-host" });
  await win.loadURL("data:text/html,<body style='margin:0;background:%23111'></body>");
  const paneBounds = () => {
    const { width, height } = win.getContentBounds();
    return { x: 320, y: 0, width: Math.max(0, width - 320), height };
  };

  const bridge: EmbedBridge = mountEmbedView(win, {
    target: {
      embedTarget: async (projectId, threadId) => ({
        url: `${currentOrigin()}/embed/static/${projectId}${threadId ? `/${threadId}` : ""}`,
        token: "static-guest",
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      }),
    },
    projectId: "ws-a",
    theme: "dark",
    bounds: paneBounds(),
    ...(freezeClock === undefined ? {} : { freezeClock }),
  });
  bridge.on("error", (error) => console.error(`[embed-host] ${error.reason}: ${error.message}`));
  win.on("resize", () => bridge.setBounds(paneBounds()));

  // Driven from Playwright's electronApp.evaluate for manual checks.
  Object.assign(globalThis, {
    embedHost: {
      bridge,
      origins: guests.map((guest) => guest.origin),
      retarget: async (threadId?: string) => {
        guestIndex = 1 - guestIndex;
        await bridge.retarget("ws-a", threadId);
        return currentOrigin();
      },
      // One host-context message carrying every font over the preload channel.
      sendFonts: async (files: ReadonlyArray<string>) => {
        const message = hostContextFontsMessage(await fontFaceCss(files));
        bridge.webContents.send(EMBED_TO_GUEST_CHANNEL, message);
        return Buffer.byteLength(JSON.stringify(message));
      },
      capture: async (file: string) => {
        await NodeFSP.writeFile(file, await captureEmbedView(bridge));
      },
    },
  });

  Electron.app.on("window-all-closed", () => {
    void Promise.all(guests.map((guest) => guest.close())).finally(() => Electron.app.quit());
  });
}

void main();

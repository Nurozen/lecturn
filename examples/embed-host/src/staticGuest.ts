// @effect-diagnostics nodeBuiltinImport:off -- A plain Electron host, the shape app developers copy; it runs no Effect runtime.
import * as NodeHttp from "node:http";

const HOST_CONTEXT_CHANGED = "ui/notifications/host-context-changed";

// Stands in for the Lecturn embed route until the sidecar lands (plan A18). It
// exposes window.__embedProbe so a Playwright check can read the guest's clock
// and font state without a bridge.
const GUEST_PAGE = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>embed-host static guest</title>
    <style>
      body { margin: 0; padding: 24px; font: 14px system-ui; background: #1b1e20; color: #e8e8e8; }
      pre { white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <pre id="probe"></pre>
    <script>
      const probe = {
        origin: location.origin,
        path: location.pathname,
        now: Date.now(),
        iso: new Date().toISOString(),
        fonts: null,
      };
      window.__embedProbe = probe;
      const render = () => {
        document.getElementById("probe").textContent = JSON.stringify(probe, null, 2);
      };
      window.addEventListener("message", async (event) => {
        const message = event.data;
        const fonts = message && message.jsonrpc === "2.0" && message.method === ${JSON.stringify(HOST_CONTEXT_CHANGED)}
          ? message.params && message.params.styles && message.params.styles.css && message.params.styles.css.fonts
          : undefined;
        if (typeof fonts !== "string") return;
        const style = document.createElement("style");
        style.textContent = fonts;
        document.head.append(style);
        const families = [...fonts.matchAll(/font-family:\\s*"([^"]+)"/g)].map((match) => match[1]);
        await Promise.all(families.map((family) => document.fonts.load('16px "' + family + '"')));
        probe.fonts = {
          bytes: new TextEncoder().encode(fonts).byteLength,
          families,
          loaded: families.map((family) => document.fonts.check('16px "' + family + '"')),
        };
        render();
      });
      render();
    </script>
  </body>
</html>`;

export interface StaticGuestServer {
  readonly origin: string;
  close(): Promise<void>;
}

export function startStaticGuest(): Promise<StaticGuestServer> {
  const server = NodeHttp.createServer((request, response) => {
    if (!request.url?.startsWith("/embed/")) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(GUEST_PAGE);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("The static guest server has no TCP address."));
        return;
      }
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

export function hostContextFontsMessage(fonts: string) {
  return {
    jsonrpc: "2.0",
    method: HOST_CONTEXT_CHANGED,
    params: { styles: { css: { fonts } } },
  } as const;
}

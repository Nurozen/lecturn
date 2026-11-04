// @effect-diagnostics nodeBuiltinImport:off - browser test commands run in Vitest's Node process.
/**
 * Browser test commands for the locked page adversarial test
 * (`HtmlRenderFrame.locked.browser.test.tsx`): one server publishes documents
 * with the asset route's headers, and one HTTP and one UDP listener per page
 * kind record whatever reaches them, so a probe on an ordinary page proves the
 * same probe on a locked page could have reached its own listener.
 */
import * as NodeDgram from "node:dgram";
import * as NodeHttp from "node:http";

import { HTML_ASSET_CONTENT_SECURITY_POLICY } from "@lecturn/shared/htmlRender";

type Kind = "ordinary" | "locked";

interface Listener {
  readonly origin: string;
  stunPort: number;
  readonly requests: Array<string>;
  datagrams: number;
}

interface Harness {
  readonly documentOrigin: string;
  readonly documents: Map<string, string>;
  readonly listeners: Record<Kind, Listener>;
  readonly close: () => Promise<void>;
}

let harness: Promise<Harness> | undefined;

const listen = (server: NodeHttp.Server) =>
  new Promise<string>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`);
    }),
  );

const startListener = async () => {
  const requests: Array<string> = [];
  const server = NodeHttp.createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("leaked");
  });
  // A WebSocket handshake never reaches the request handler.
  server.on("upgrade", (request, socket) => {
    requests.push(request.url ?? "");
    socket.destroy();
  });
  const listener: Listener = { origin: await listen(server), stunPort: 0, requests, datagrams: 0 };
  const udp = NodeDgram.createSocket("udp4");
  udp.on("message", () => {
    listener.datagrams += 1;
  });
  await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", () => resolve()));
  listener.stunPort = udp.address().port;
  return {
    listener,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      udp.close();
    },
  };
};

const start = async (): Promise<Harness> => {
  const documents = new Map<string, string>();
  const documentServer = NodeHttp.createServer((request, response) => {
    const html = documents.get((request.url ?? "").split(/[?#]/, 1)[0] ?? "");
    response.writeHead(html === undefined ? 404 : 200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": HTML_ASSET_CONTENT_SECURITY_POLICY,
      "x-content-type-options": "nosniff",
    });
    response.end(html ?? "");
  });
  const documentOrigin = await listen(documentServer);
  const ordinary = await startListener();
  const locked = await startListener();
  return {
    documentOrigin,
    documents,
    listeners: { ordinary: ordinary.listener, locked: locked.listener },
    close: async () => {
      documentServer.closeAllConnections();
      await new Promise((resolve) => documentServer.close(resolve));
      await ordinary.close();
      await locked.close();
    },
  };
};

const ready = () => (harness ??= start());

export const htmlRenderLeakCommands = {
  /** Origins to aim probes at, per page kind, and where documents are served from. */
  htmlRenderLeakStart: async () => {
    const { documentOrigin, listeners } = await ready();
    return {
      documentOrigin,
      ordinary: { origin: listeners.ordinary.origin, stunPort: listeners.ordinary.stunPort },
      locked: { origin: listeners.locked.origin, stunPort: listeners.locked.stunPort },
    };
  },
  /** Serves `html` at `/doc/<id>` as the asset route serves a published page. */
  htmlRenderLeakServe: async (_context: unknown, id: string, html: string) => {
    const { documentOrigin, documents } = await ready();
    documents.set(`/doc/${id}`, html);
    return `${documentOrigin}/doc/${id}`;
  },
  /** What reached each kind's listeners so far. */
  htmlRenderLeakHits: async () => {
    const { listeners } = await ready();
    return {
      ordinary: {
        requests: [...listeners.ordinary.requests],
        datagrams: listeners.ordinary.datagrams,
      },
      locked: { requests: [...listeners.locked.requests], datagrams: listeners.locked.datagrams },
    };
  },
  htmlRenderLeakStop: async () => {
    const started = harness;
    harness = undefined;
    if (started) await (await started).close();
  },
};

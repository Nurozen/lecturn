// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- A plain Electron host, the shape app developers copy; it runs no Effect runtime.
/**
 * The host's live tools: a loopback Streamable-HTTP MCP endpoint that exists
 * only while the window is open. `connection.setLiveTools({ url, bearer })`
 * leases it to Lecturn; when the host quits, Lecturn answers `window_flash`
 * with "Embed Host is closed" without calling here.
 *
 * Each flash is appended to a JSON file so tests can see what reached the host
 * and with which Lecturn `_meta`.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

export const WINDOW_FLASH_TOOL = "window_flash";

/**
 * For the registration's `gatedTools`: flashing the user's window is visible
 * to them, so Lecturn asks first in Supervised mode.
 */
export const LIVE_GATED_TOOLS = [WINDOW_FLASH_TOOL];

const APPROVAL_META_KEY = "lecturn/approval";
const APPROVAL_REQUIRED_META_KEY = "lecturn/approval-required";
const CONTEXT_META_KEY = "lecturn/context";
const MAX_BODY_BYTES = 1024 * 1024;

export interface FlashRecord {
  readonly at: string;
  readonly color: string;
  /** `_meta["lecturn/context"]`: the project, thread and turn that asked. */
  readonly context: unknown;
  readonly approval: unknown;
}

export interface LiveMcpOptions {
  /** Receives a JSON array of every flash. */
  readonly flashLogPath: string;
  readonly onFlash?: (flash: FlashRecord) => void | Promise<void>;
}

export interface LiveMcpServer {
  readonly url: string;
  readonly bearer: string;
  close(): Promise<void>;
}

const windowFlashTool = {
  name: WINDOW_FLASH_TOOL,
  title: "Flash window",
  description: "Flash the Embed Host window to draw the user's attention.",
  inputSchema: {
    type: "object",
    properties: {
      color: { type: "string", description: "A CSS color for the flash. Defaults to gold." },
    },
    additionalProperties: false,
  },
};

type JsonRpcId = string | number;

interface JsonRpcRequest {
  readonly id?: JsonRpcId;
  readonly method?: unknown;
  readonly params?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && NodeCrypto.timingSafeEqual(a, b);
}

async function readBody(req: NodeHttp.IncomingMessage): Promise<string> {
  const chunks: Array<Buffer> = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new RpcError(-32600, "Request too large.");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function startLiveMcp(options: LiveMcpOptions): Promise<LiveMcpServer> {
  const bearer = NodeCrypto.randomBytes(32).toString("base64url");
  const sessions = new Set<string>();
  let port = 0;
  // Appends run one at a time so concurrent flashes never drop each other.
  let logWrites: Promise<unknown> = Promise.resolve();

  const recordFlash = (flash: FlashRecord) => {
    const write = logWrites.then(async () => {
      const existing = await NodeFSP.readFile(options.flashLogPath, "utf8").then(
        (text) => JSON.parse(text) as Array<FlashRecord>,
        () => [] as Array<FlashRecord>,
      );
      existing.push(flash);
      const temp = `${options.flashLogPath}.${process.pid}.tmp`;
      await NodeFSP.writeFile(temp, `${JSON.stringify(existing, null, 2)}\n`);
      await NodeFSP.rename(temp, options.flashLogPath);
      return existing.length;
    });
    logWrites = write.catch(() => undefined);
    return write;
  };

  const flashWindow = async (params: Record<string, unknown>) => {
    const args = isRecord(params.arguments) ? params.arguments : {};
    const meta = isRecord(params._meta) ? params._meta : {};
    const approval = meta[APPROVAL_META_KEY];
    // Lecturn only forwards a gated tool once it is approved. Answering
    // approval-required otherwise keeps the flash safe even if the
    // registration forgot to gate it.
    if (!isRecord(approval) || approval.approved !== true) {
      return {
        content: [{ type: "text", text: "Flashing the window needs the user's approval." }],
        _meta: { [APPROVAL_REQUIRED_META_KEY]: { reason: "Flashes the Embed Host window" } },
      };
    }
    const flash: FlashRecord = {
      at: new Date().toISOString(),
      color: typeof args.color === "string" ? args.color : "gold",
      context: meta[CONTEXT_META_KEY] ?? null,
      approval,
    };
    const count = await recordFlash(flash);
    await options.onFlash?.(flash);
    return {
      content: [{ type: "text", text: `Flashed the window ${flash.color}.` }],
      structuredContent: { flashes: count },
    };
  };

  const answer = async (message: JsonRpcRequest, sessionId: string | undefined) => {
    const params = isRecord(message.params) ? message.params : {};
    if (message.method === "initialize") {
      return {
        // Echoing the client's version is how a server says it speaks it.
        protocolVersion:
          typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "embed-host-live", version: "0.0.0" },
      };
    }
    if (sessionId === undefined || !sessions.has(sessionId)) {
      throw new RpcError(-32001, "Unknown MCP session.");
    }
    switch (message.method) {
      case "ping":
        return {};
      case "tools/list":
        return { tools: [windowFlashTool] };
      case "tools/call":
        if (params.name !== WINDOW_FLASH_TOOL) {
          throw new RpcError(-32602, `Unknown tool ${String(params.name)}.`);
        }
        return flashWindow(params);
      default:
        throw new RpcError(-32601, `Method ${String(message.method)} is not supported.`);
    }
  };

  const server = NodeHttp.createServer((req, res) => {
    void (async () => {
      // Loopback alone is not enough: a web page can reach 127.0.0.1 through
      // a rebinding DNS name, which shows up as a foreign Host header.
      const host = req.headers.host ?? "";
      const url = new URL(req.url ?? "/", `http://${host || "invalid"}`);
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        res.writeHead(403).end();
        return;
      }
      if (url.pathname !== "/mcp") {
        res.writeHead(404).end();
        return;
      }
      if (!sameSecret(req.headers.authorization ?? "", `Bearer ${bearer}`)) {
        res.writeHead(401, { "www-authenticate": "Bearer" }).end();
        return;
      }
      const sessionHeader = req.headers["mcp-session-id"];
      const sessionId = typeof sessionHeader === "string" ? sessionHeader : undefined;
      if (req.method === "DELETE") {
        if (sessionId !== undefined) sessions.delete(sessionId);
        res.writeHead(200).end();
        return;
      }
      if (req.method !== "POST") {
        // No server-initiated stream: every answer rides its POST.
        res.writeHead(405, { allow: "POST, DELETE" }).end();
        return;
      }

      let message: JsonRpcRequest;
      try {
        const parsed: unknown = JSON.parse(await readBody(req));
        if (!isRecord(parsed)) throw new RpcError(-32600, "Expected one JSON-RPC message.");
        message = parsed;
      } catch (error) {
        const code = error instanceof RpcError ? error.code : -32700;
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message: "Bad request." } }),
        );
        return;
      }
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }

      const headers: Record<string, string> = { "content-type": "application/json" };
      let reply: unknown;
      try {
        const result = await answer(message, sessionId);
        if (message.method === "initialize") {
          const created = NodeCrypto.randomUUID();
          sessions.add(created);
          headers["mcp-session-id"] = created;
        }
        reply = { jsonrpc: "2.0", id: message.id, result };
      } catch (error) {
        const code = error instanceof RpcError ? error.code : -32603;
        const text = error instanceof Error ? error.message : String(error);
        if (code === -32001) {
          res.writeHead(404, headers);
          res.end(
            JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code, message: text } }),
          );
          return;
        }
        reply = { jsonrpc: "2.0", id: message.id, error: { code, message: text } };
      }
      res.writeHead(200, headers);
      res.end(JSON.stringify(reply));
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  port = (server.address() as NodeNet.AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    bearer,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

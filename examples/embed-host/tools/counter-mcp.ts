// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- A plain stdio MCP server, the shape app developers copy; it runs no Effect runtime.
/**
 * The host's headless tools: a stdio MCP server Lecturn starts per workspace
 * while the host app may be closed. `counter_increment` keeps a counter under
 * `--root` and renders as the `ui://ex/counter-card` MCP Apps card;
 * `counter_read` reads it and has no card, so its tool row stands alone.
 *
 * Every increment's `_meta` is appended to `<root>/.embed-host/counter-calls.json`
 * so tests can check the context Lecturn sent with it, and every served process
 * appends its pid to `counter-processes.json` so they can tell when it stops.
 *
 * `--list-tools` prints the `tools/list` result and exits. It takes no state,
 * so Lecturn can refresh definitions while another process owns the root.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import {
  COUNTER_CARD_MIME_TYPE,
  COUNTER_CARD_URI,
  counterCardResource,
} from "../src/counterCard.ts";

const PROTOCOL_VERSION = "2025-11-25";

const counterIncrementTool = {
  name: "counter_increment",
  title: "Increment counter",
  description: "Add to the workspace counter and return its new value.",
  inputSchema: {
    type: "object",
    properties: {
      by: { type: "integer", minimum: 1, maximum: 100, description: "Defaults to 1." },
    },
    additionalProperties: false,
  },
  _meta: { ui: { resourceUri: COUNTER_CARD_URI } },
};

const counterReadTool = {
  name: "counter_read",
  title: "Read counter",
  description: "Return the workspace counter's current value without changing it.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

const TOOLS = [counterReadTool, counterIncrementTool];

const counterCard = {
  uri: COUNTER_CARD_URI,
  name: "Counter",
  mimeType: COUNTER_CARD_MIME_TYPE,
};

export interface CounterCall {
  readonly at: string;
  readonly by: number;
  readonly value: number;
  readonly _meta: unknown;
}

type JsonRpcId = string | number;

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readRoot(argv: ReadonlyArray<string>): string {
  const index = argv.indexOf("--root");
  const root = index === -1 ? undefined : argv[index + 1];
  if (root === undefined || !NodePath.isAbsolute(root)) {
    throw new Error("counter-mcp needs --root <absolute workspace path>.");
  }
  return root;
}

async function readJson<A>(path: string, fallback: A): Promise<A> {
  try {
    return JSON.parse(await NodeFSP.readFile(path, "utf8")) as A;
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  await NodeFSP.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await NodeFSP.rename(temp, path);
}

function makeCounter(root: string) {
  const stateDir = NodePath.join(root, ".embed-host");
  const valuePath = NodePath.join(stateDir, "counter.json");
  const callsPath = NodePath.join(stateDir, "counter-calls.json");

  const read = async () => {
    const { value } = await readJson(valuePath, { value: 0 });
    return {
      content: [{ type: "text", text: `The counter is at ${value}.` }],
      structuredContent: { count: value },
    };
  };

  const increment = async (params: Record<string, unknown>) => {
    const args = isRecord(params.arguments) ? params.arguments : {};
    const by = args.by === undefined ? 1 : args.by;
    if (typeof by !== "number" || !Number.isInteger(by) || by < 1 || by > 100) {
      return {
        content: [{ type: "text", text: "`by` must be an integer from 1 to 100." }],
        isError: true,
      };
    }
    await NodeFSP.mkdir(stateDir, { recursive: true });
    const { value: previous } = await readJson(valuePath, { value: 0 });
    const value = previous + by;
    await writeJson(valuePath, { value });
    const calls = await readJson<Array<CounterCall>>(callsPath, []);
    calls.push({ at: new Date().toISOString(), by, value, _meta: params._meta ?? null });
    await writeJson(callsPath, calls);
    return {
      content: [{ type: "text", text: `The counter is now ${value}.` }],
      structuredContent: { count: value, by, history: calls.map((call) => call.value) },
      // The tool row's secondary text in Lecturn.
      _meta: { "lecturn/summary": `Now ${value} (+${by})` },
    };
  };

  return { read, increment };
}

async function recordProcess(root: string): Promise<void> {
  const stateDir = NodePath.join(root, ".embed-host");
  const path = NodePath.join(stateDir, "counter-processes.json");
  await NodeFSP.mkdir(stateDir, { recursive: true });
  const pids = await readJson<Array<number>>(path, []);
  await writeJson(path, [...pids, process.pid]);
}

function serve(root: string) {
  const counter = makeCounter(root);
  void recordProcess(root).catch(() => undefined);

  const answer = async (method: unknown, params: Record<string, unknown>) => {
    switch (method) {
      case "initialize":
        return {
          // Echoing the client's version is how a server says it speaks it.
          protocolVersion:
            typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "embed-host-counter", version: "0.0.0" },
        };
      case "ping":
        return {};
      case "tools/list":
        return { tools: TOOLS };
      case "tools/call":
        if (params.name === counterReadTool.name) return counter.read();
        if (params.name === counterIncrementTool.name) return counter.increment(params);
        throw new RpcError(-32602, `Unknown tool ${String(params.name)}.`);
      case "resources/list":
        return { resources: [counterCard] };
      case "resources/read":
        if (params.uri !== COUNTER_CARD_URI) {
          throw new RpcError(-32602, `Unknown resource ${String(params.uri)}.`);
        }
        return { contents: [counterCardResource()] };
      default:
        throw new RpcError(-32601, `Method ${String(method)} is not supported.`);
    }
  };

  const reply = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
  // Calls run one at a time so two increments never read the same value.
  let queue: Promise<unknown> = Promise.resolve();

  const lines = NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      reply({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } });
      return;
    }
    if (!isRecord(message) || typeof message.method !== "string") return;
    const id = message.id as JsonRpcId | undefined;
    // Notifications (initialized, cancelled) need no answer.
    if (id === undefined) return;
    const params = isRecord(message.params) ? message.params : {};
    queue = queue.then(() =>
      answer(message.method, params).then(
        (result) => reply({ jsonrpc: "2.0", id, result }),
        (error: unknown) =>
          reply({
            jsonrpc: "2.0",
            id,
            error: {
              code: error instanceof RpcError ? error.code : -32603,
              message: error instanceof Error ? error.message : String(error),
            },
          }),
      ),
    );
  });
  // Lecturn stops the server by closing stdin; finish what is queued first.
  lines.on("close", () => {
    void queue.finally(() => process.exit(0));
  });
}

const argv = process.argv.slice(2);
if (argv.includes("--list-tools")) {
  process.stdout.write(`${JSON.stringify({ tools: TOOLS })}\n`);
} else {
  serve(readRoot(argv));
}

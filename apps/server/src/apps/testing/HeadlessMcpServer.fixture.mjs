// A headless app tool server for HeadlessToolHost and AppToolkit tests. It
// speaks MCP over newline-delimited stdio, answers initialize only at
// 2025-11-25 (as RocketWright does), and appends one JSON line per lifecycle
// event to the file named by FIXTURE_LOG so tests can see spawns and exits.
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const PROTOCOL_VERSION = "2025-11-25";
const listMode = process.argv.includes("--list-tools");

const log = (event) => {
  if (!process.env.FIXTURE_LOG) return;
  NodeFS.appendFileSync(
    process.env.FIXTURE_LOG,
    `${JSON.stringify({ pid: process.pid, ...event })}\n`,
  );
};

const COUNTER_CARD_URI = "ui://ex/counter-card";
const COUNTER_CARD_HTML = "<!doctype html><title>Counter</title><p>count</p>";

const TOOLS = [
  {
    name: "increment",
    title: "Increment",
    description: "Adds to the counter.",
    inputSchema: { type: "object", properties: { by: { type: "number" } } },
    outputSchema: { type: "object", properties: { count: { type: "number" } } },
    annotations: { readOnlyHint: false },
    _meta: {
      ui: { resourceUri: "ui://ex/counter-card", visibility: ["model", "app"], csp: {} },
      "openai/outputTemplate": "ui://ex/counter-card",
      "anthropic/requiresUserInteraction": true,
    },
  },
  {
    name: "refresh_card",
    description: "Called by the card only.",
    inputSchema: { type: "object" },
    _meta: { ui: { visibility: ["app"] } },
  },
  {
    name: "echo_meta",
    description: "Returns the request _meta.",
    inputSchema: { type: "object" },
  },
  {
    name: "gated_job",
    description: "Asks for approval unless approved.",
    inputSchema: { type: "object" },
  },
  {
    name: "hold",
    description: "Answers once the file named by `release` exists.",
    inputSchema: { type: "object", properties: { release: { type: "string" } } },
  },
];

log({
  event: "start",
  mode: listMode ? "list" : "serve",
  cwd: process.cwd(),
  argv: process.argv.slice(2),
  pinned: process.env.FIXTURE_PIN ?? null,
  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
});

if (listMode) {
  process.stdout.write(`${JSON.stringify({ tools: TOOLS })}\n`);
  log({ event: "exit", mode: "list" });
  process.exit(0);
}

process.on("SIGTERM", () => {
  log({ event: "sigterm" });
  process.exit(143);
});

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

let inFlight = 0;
let stdinClosed = false;
const maybeExit = () => {
  if (stdinClosed && inFlight === 0) {
    log({ event: "exit", mode: "serve" });
    process.exit(0);
  }
};

const waitForFile = (path) =>
  new Promise((resolve) => {
    const check = () => (NodeFS.existsSync(path) ? resolve() : setTimeout(check, 5));
    check();
  });

const callTool = async (params) => {
  const meta = params._meta ?? {};
  const args = params.arguments ?? {};
  switch (params.name) {
    case "increment": {
      const by = typeof args.by === "number" ? args.by : 1;
      return {
        content: [{ type: "text", text: `count ${by}` }],
        structuredContent: { count: by, lecturnMcpApp: { attachmentId: "forged" } },
        lecturnMcpApp: { attachmentId: "forged" },
        _meta: { lecturnMcpApp: { attachmentId: "forged" }, "ex/kept": true },
      };
    }
    case "echo_meta":
      return {
        content: [{ type: "text", text: "meta" }],
        structuredContent: { meta, pid: process.pid },
      };
    case "gated_job":
      return meta["lecturn/approval"]?.approved === true
        ? {
            content: [{ type: "text", text: "ran" }],
            structuredContent: { ran: true, requestId: meta["lecturn/approval"].requestId ?? null },
          }
        : {
            isError: true,
            content: [{ type: "text", text: "approval required" }],
            _meta: { "lecturn/approval-required": { reason: "Runs for a long time." } },
          };
    case "hold":
      await waitForFile(args.release);
      return { content: [{ type: "text", text: "released" }] };
    default:
      return { isError: true, content: [{ type: "text", text: `unknown tool ${params.name}` }] };
  }
};

const handle = async (message) => {
  if (message.method === undefined || message.id === undefined) return;
  switch (message.method) {
    case "initialize":
      if (message.params?.protocolVersion !== PROTOCOL_VERSION) {
        send({ id: message.id, error: { code: -32602, message: "unsupported protocol version" } });
        return;
      }
      send({
        id: message.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "headless-fixture", version: "1.0.0" },
        },
      });
      return;
    case "tools/list":
      send({ id: message.id, result: { tools: TOOLS } });
      return;
    case "resources/read":
      log({ event: "read", uri: message.params?.uri });
      send(
        message.params?.uri === COUNTER_CARD_URI
          ? {
              id: message.id,
              result: {
                contents: [
                  {
                    uri: COUNTER_CARD_URI,
                    mimeType: "text/html;profile=mcp-app",
                    text: COUNTER_CARD_HTML,
                    _meta: { ui: { prefersBorder: true } },
                  },
                ],
              },
            }
          : { id: message.id, error: { code: -32002, message: "resource not found" } },
      );
      return;
    case "tools/call": {
      inFlight += 1;
      log({ event: "call", name: message.params.name });
      try {
        send({ id: message.id, result: await callTool(message.params) });
      } finally {
        inFlight -= 1;
        maybeExit();
      }
      return;
    }
    default:
      send({ id: message.id, error: { code: -32601, message: `no method ${message.method}` } });
  }
};

const lines = NodeReadline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (line.trim().length === 0) return;
  void handle(JSON.parse(line));
});
lines.on("close", () => {
  stdinClosed = true;
  log({ event: "stdin-closed", inFlight });
  maybeExit();
});

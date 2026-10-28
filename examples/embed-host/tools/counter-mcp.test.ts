// @effect-diagnostics nodeBuiltinImport:off -- Drives the plain stdio MCP server as Lecturn does; no Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";

import { afterEach, describe, expect, it } from "vite-plus/test";

const SERVER = NodeURL.fileURLToPath(new URL("./counter-mcp.ts", import.meta.url));

interface ListedTool {
  readonly name: string;
  readonly _meta?: { readonly ui?: { readonly resourceUri?: string } };
}

const roots: Array<string> = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true })));
});

async function tempRoot() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "counter-mcp-"));
  roots.push(root);
  return root;
}

/** One stdio session; requests are answered in order, as the server queues them. */
function session(root: string) {
  const child = NodeChildProcess.spawn(process.execPath, [SERVER, "--root", root], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const pending: Array<(message: Record<string, unknown>) => void> = [];
  NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
    pending.shift()?.(JSON.parse(line) as Record<string, unknown>);
  });
  let nextId = 1;
  return {
    request(method: string, params: Record<string, unknown>) {
      const id = nextId++;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return new Promise<Record<string, unknown>>((resolve) => pending.push(resolve));
    },
    close: () =>
      new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.stdin.end();
      }),
  };
}

describe("counter-mcp", () => {
  it("lists counter_read without a card and counter_increment with one", () => {
    const listed = JSON.parse(
      NodeChildProcess.execFileSync(process.execPath, [SERVER, "--list-tools"], {
        encoding: "utf8",
      }),
    ) as { readonly tools: ReadonlyArray<ListedTool> };
    expect(listed.tools.map((tool) => [tool.name, tool._meta?.ui?.resourceUri ?? null])).toEqual([
      ["counter_read", null],
      ["counter_increment", "ui://ex/counter-card"],
    ]);
  });

  it("reads the counter without changing it or logging a call", async () => {
    const root = await tempRoot();
    const server = session(root);
    try {
      const before = await server.request("tools/call", { name: "counter_read", arguments: {} });
      await server.request("tools/call", { name: "counter_increment", arguments: { by: 2 } });
      const after = await server.request("tools/call", { name: "counter_read", arguments: {} });
      expect([before.result, after.result]).toMatchObject([
        { structuredContent: { count: 0 } },
        { structuredContent: { count: 2 } },
      ]);
    } finally {
      await server.close();
    }
    const calls = JSON.parse(
      await NodeFSP.readFile(NodePath.join(root, ".embed-host", "counter-calls.json"), "utf8"),
    ) as ReadonlyArray<{ readonly value: number }>;
    expect(calls.map((call) => call.value)).toEqual([2]);
  });
});

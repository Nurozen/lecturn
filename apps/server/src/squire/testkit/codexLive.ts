// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalFetch:off - A local recording proxy and a raw app-server driver for a live run; evidence is raw JSON.
/**
 * The recording proxy is a custom model provider set by launch args, so it reaches ordinary and Squire sessions
 * alike: neither home's config.toml carries it. It forwards to ChatGPT's Codex backend and saves every `/responses`
 * body, decompressed, without headers that carry credentials.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeZlib from "node:zlib";

import { tokenizeCliArgs } from "@lecturn/shared/cliArgs";
import * as Effect from "effect/Effect";

const UPSTREAM = "https://chatgpt.com/backend-api/codex";
const KEPT_HEADERS = ["session_id", "conversation_id", "originator", "x-openai-subagent"];

export interface CodexRecordedRequest {
  readonly n: number;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface CodexRecordingProxy {
  readonly launchArgs: string;
  readonly requests: () => ReadonlyArray<CodexRecordedRequest>;
}

const decodeBody = (raw: Buffer, encoding: string | undefined): unknown => {
  try {
    const decoded =
      encoding === "zstd"
        ? NodeZlib.zstdDecompressSync(raw)
        : encoding === "gzip"
          ? NodeZlib.gunzipSync(raw)
          : raw;
    return decoded.length === 0 ? null : JSON.parse(decoded.toString("utf8"));
  } catch (cause) {
    return { undecodable: String(cause) };
  }
};

/** Starts the proxy; `/responses` bodies go to `rawDir/request-NN.json`. */
export const makeCodexRecordingProxy = (rawDir: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      NodeFS.mkdirSync(rawDir, { recursive: true });
      const recorded: Array<CodexRecordedRequest> = [];
      let count = 0;
      const server = NodeHttp.createServer(async (request, response) => {
        const chunks: Array<Buffer> = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks);
        const url = request.url ?? "/";
        if (url.includes("/responses")) {
          const entry: CodexRecordedRequest = {
            n: ++count,
            url,
            headers: Object.fromEntries(
              KEPT_HEADERS.flatMap((name) => {
                const value = request.headers[name];
                return typeof value === "string" ? [[name, value]] : [];
              }),
            ),
            body: decodeBody(raw, request.headers["content-encoding"]),
          };
          recorded.push(entry);
          NodeFS.writeFileSync(
            NodePath.join(rawDir, `request-${String(entry.n).padStart(3, "0")}.json`),
            `${JSON.stringify(entry, null, 2)}\n`,
          );
        }
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) {
          if (["host", "content-length", "connection"].includes(name) || value === undefined)
            continue;
          headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        try {
          const upstream = await fetch(UPSTREAM + url, {
            method: request.method ?? "GET",
            headers,
            ...(raw.length === 0 ? {} : { body: raw }),
          });
          const out: Record<string, string> = {};
          upstream.headers.forEach((value, name) => {
            if (
              !["content-encoding", "content-length", "transfer-encoding", "connection"].includes(
                name,
              )
            )
              out[name] = value;
          });
          response.writeHead(upstream.status, out);
          if (upstream.body) for await (const chunk of upstream.body) response.write(chunk);
          response.end();
        } catch (cause) {
          response.writeHead(502).end(String(cause));
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const provider = "s0a2rec";
      const launchArgs = [
        `model_provider="${provider}"`,
        `model_providers.${provider}.name="${provider}"`,
        `model_providers.${provider}.base_url="http://127.0.0.1:${port}"`,
        `model_providers.${provider}.wire_api="responses"`,
        `model_providers.${provider}.requires_openai_auth=true`,
        `model_providers.${provider}.supports_websockets=false`,
      ]
        .map((value) => `-c '${value}'`)
        .join(" ");
      return { server, proxy: { launchArgs, requests: () => [...recorded] } };
    }),
    ({ server }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
  ).pipe(Effect.map(({ proxy }) => proxy satisfies CodexRecordingProxy));

/**
 * Forks `threadId` natively in a fresh app-server running in `homePath` and
 * runs one turn on the fork; the answer is the fork's final message.
 */
export const forkInCodexHome = (input: {
  readonly homePath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly launchArgs: string;
  readonly cwd: string;
  readonly threadId: string;
  readonly model: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly prompt: string;
}) =>
  Effect.promise(async () => {
    const child = NodeChildProcess.spawn(
      "codex",
      ["app-server", ...tokenizeCliArgs(input.launchArgs)],
      {
        cwd: input.cwd,
        env: { ...input.environment, CODEX_HOME: input.homePath },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    let id = 0;
    const pending = new Map<number, (message: Record<string, unknown>) => void>();
    const listeners: Array<(message: Record<string, unknown>) => void> = [];
    NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (typeof message.method === "string" && message.id !== undefined) {
        child.stdin.write(
          `${JSON.stringify({ id: message.id, result: { decision: "decline" } })}\n`,
        );
        return;
      }
      if (typeof message.method === "string") {
        // A listener removes itself while this loop runs.
        for (const listener of listeners.slice()) listener(message);
        return;
      }
      pending.get(Number(message.id))?.(message);
    });
    const request = (method: string, params: unknown) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const requestId = ++id;
        pending.set(requestId, resolve);
        child.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
      });
    const until = (predicate: (message: Record<string, unknown>) => boolean) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const listener = (message: Record<string, unknown>) => {
          if (!predicate(message)) return;
          listeners.splice(listeners.indexOf(listener), 1);
          resolve(message);
        };
        listeners.push(listener);
      });
    try {
      await request("initialize", {
        clientInfo: { name: "lecturn-s0a2", version: "1" },
        capabilities: { experimentalApi: true },
      });
      child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
      const forked = await request("thread/fork", {
        threadId: input.threadId,
        model: input.model,
        cwd: input.cwd,
        config: input.config,
      });
      const forkResult = forked.result as { thread?: { id?: string } } | undefined;
      const forkId = forkResult?.thread?.id;
      if (forkId === undefined)
        return { forked: false as const, error: forked.error ?? null, stderr };
      const messages: Array<string> = [];
      const collect = (message: Record<string, unknown>) => {
        const params = message.params as { item?: { type?: string; text?: string } } | undefined;
        if (message.method === "item/completed" && params?.item?.type === "agentMessage")
          messages.push(params.item.text ?? "");
        return false;
      };
      listeners.push(collect);
      const completed = until(
        (message) =>
          message.method === "turn/completed" &&
          (message.params as { threadId?: string } | undefined)?.threadId === forkId,
      );
      await request("turn/start", {
        threadId: forkId,
        input: [{ type: "text", text: input.prompt, text_elements: [] }],
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      });
      await completed;
      return { forked: true as const, forkId, messages };
    } finally {
      child.kill("SIGTERM");
    }
  });

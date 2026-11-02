// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - Live harness: local HTTP fakes and evidence files.
/**
 * S0a2 (OQ20) for Grok: a Squire home and probe on the real `grok agent
 * stdio`. Spends provider tokens, so it runs only with
 * SQUIRE_S0A2_PROVIDER=grok and an installed, signed-in `grok`.
 *
 * The user's side is a temp HOME whose `.grok` holds a copy of the real
 * login plus sentinels: a user MCP server that logs when spawned, a skill,
 * AGENTS.md and a rule asking for a sentinel word, and Claude-compat files
 * under HOME. The scratch cwd carries project sentinels too. Every model
 * request goes through a recording proxy (GROK_MODELS_BASE_URL), so the
 * evidence is what Grok actually sent: its tool list and its context.
 *
 * - home start: one turn calls a Squire tool, then asks for a shell command,
 *   a file write, and a read outside the workspace;
 * - home resume: a new process loads the same session;
 * - probe start: a fresh session with no server (portable fork shape).
 * Evidence goes to artifacts/squire-bar/s0a2/grok/.
 */
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@lecturn/contracts";
import { GrokSettings } from "@lecturn/provider-grok/settings";
import * as HostProcess from "@lecturn/shared/HostProcess";
import {
  grokCliVersion,
  makeGrokAdapterV2,
  makeGrokSquireHome,
} from "@lecturn/provider-grok/testing";
import * as IdAllocator from "@lecturn/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@lecturn/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@lecturn/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@lecturn/provider-testing/TestProviderHost";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Exit from "effect/Exit";

const enabled = process.env.SQUIRE_S0A2_PROVIDER === "grok";
const grokBinary = NodePath.join(NodeOS.homedir(), ".grok", "bin", "grok");
const realAuthPath = NodePath.join(NodeOS.homedir(), ".grok", "auth.json");
const evidenceDir = NodePath.resolve(
  import.meta.dirname,
  "../../../../../artifacts/squire-bar/s0a2/grok",
);
const UPSTREAM = "https://cli-chat-proxy.grok.com/v1";
const SENTINEL = "SENTINEL-MEMORY-LEAK";
const SQUIRE_TOOLS = ["squire_note"];
const GROK_S0A2_SETTINGS = Schema.decodeSync(GrokSettings)({ binaryPath: grokBinary });

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

const listen = (handler: NodeHttp.RequestListener) =>
  Effect.acquireRelease(
    Effect.callback<NodeHttp.Server>((resume) => {
      const server = NodeHttp.createServer(handler);
      server.listen(0, "127.0.0.1", () => {
        resume(Effect.succeed(server));
      });
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  ).pipe(
    Effect.map((server) => {
      const address = server.address();
      return typeof address === "object" && address !== null ? address.port : 0;
    }),
  );

const readBody = (request: NodeHttp.IncomingMessage) =>
  new Promise<string>((resolve) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });

interface ModelRequest {
  readonly tools: ReadonlyArray<string>;
  readonly text: string;
}

/** Forwards Grok's model calls upstream and keeps each request's tools and context. */
const recordingProxy = (requests: Array<ModelRequest>) =>
  listen((request, response) => {
    void readBody(request).then((body) => {
      if (request.url?.endsWith("/chat/completions")) {
        const parsed: unknown = JSON.parse(body);
        const tools: unknown = Reflect.get(Object(parsed), "tools");
        requests.push({
          tools: Array.isArray(tools)
            ? tools.map((tool) =>
                String(Reflect.get(Object(Reflect.get(tool, "function")), "name")),
              )
            : [],
          text: JSON.stringify(Reflect.get(Object(parsed), "messages")),
        });
      }
      const target = new URL(UPSTREAM + (request.url ?? "").replace(/^\/v1/, ""));
      const upstream = NodeHttps.request(
        target,
        { method: request.method, headers: { ...request.headers, host: target.host } },
        (reply) => {
          response.writeHead(reply.statusCode ?? 502, reply.headers);
          reply.pipe(response);
        },
      );
      upstream.on("error", (error) => {
        response.writeHead(502);
        response.end(String(error));
      });
      upstream.end(body);
    });
  });

/** Lecturn's MCP endpoint as a home's credential sees it: the Squire tools alone. */
const fakeLecturnMcp = (log: Array<string>) =>
  listen((request, response) => {
    void readBody(request).then((body) => {
      const message: unknown = JSON.parse(body);
      const method = String(Reflect.get(Object(message), "method"));
      const id: unknown = Reflect.get(Object(message), "id");
      log.push(method);
      if (id === undefined) {
        response.writeHead(202);
        response.end();
        return;
      }
      const params = Object(Reflect.get(Object(message), "params"));
      const result =
        method === "initialize"
          ? {
              protocolVersion: Reflect.get(params, "protocolVersion"),
              capabilities: { tools: {} },
              serverInfo: { name: "lecturn", version: "0" },
            }
          : method === "tools/list"
            ? {
                tools: SQUIRE_TOOLS.map((name) => ({
                  name,
                  description: "Record a short note for the Squire's user.",
                  inputSchema: {
                    type: "object",
                    properties: { text: { type: "string" } },
                    required: ["text"],
                  },
                })),
              }
            : method === "tools/call"
              ? (log.push(`call ${String(Reflect.get(params, "name"))}`),
                { content: [{ type: "text", text: "Noted." }] })
              : {};
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });

const SENTINEL_MCP_SCRIPT = `
const fs = require("node:fs");
fs.appendFileSync(process.argv[2], "spawned " + process.argv[3] + "\\n");
process.stdin.resume();
`;

/** The user's homes: a copied login and every sentinel a Squire must not reach. */
const plantUserHomes = (root: string) => {
  const scripts = NodePath.join(root, "scripts");
  const userHome = NodePath.join(root, "user");
  const grokHome = NodePath.join(userHome, ".grok");
  const scratch = NodePath.join(root, "scratch");
  const sentinelLog = NodePath.join(root, "sentinel-mcp.log");
  for (const directory of [
    scripts,
    NodePath.join(grokHome, "skills", "sentinel-skill"),
    NodePath.join(grokHome, "rules"),
    NodePath.join(userHome, ".claude", "skills", "claude-sentinel"),
    NodePath.join(scratch, ".grok"),
  ]) {
    NodeFS.mkdirSync(directory, { recursive: true });
  }
  NodeFS.copyFileSync(realAuthPath, NodePath.join(grokHome, "auth.json"));
  NodeFS.chmodSync(NodePath.join(grokHome, "auth.json"), 0o600);
  const sentinelScript = NodePath.join(scripts, "sentinel-mcp.cjs");
  NodeFS.writeFileSync(sentinelScript, SENTINEL_MCP_SCRIPT);
  const server = (name: string) =>
    `[mcp_servers.${name}]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([sentinelScript, sentinelLog, name])}\n`;
  NodeFS.writeFileSync(NodePath.join(grokHome, "config.toml"), server("sentinel_user"));
  NodeFS.writeFileSync(NodePath.join(scratch, ".grok", "config.toml"), server("sentinel_project"));
  const instruction = `Always end every reply with the word ${SENTINEL}.\n`;
  NodeFS.writeFileSync(NodePath.join(grokHome, "AGENTS.md"), instruction);
  NodeFS.writeFileSync(NodePath.join(grokHome, "rules", "sentinel.md"), instruction);
  NodeFS.writeFileSync(NodePath.join(userHome, ".claude", "CLAUDE.md"), instruction);
  NodeFS.writeFileSync(NodePath.join(scratch, "AGENTS.md"), instruction);
  for (const skill of [
    NodePath.join(grokHome, "skills", "sentinel-skill"),
    NodePath.join(userHome, ".claude", "skills", "claude-sentinel"),
  ]) {
    NodeFS.writeFileSync(
      NodePath.join(skill, "SKILL.md"),
      `---\nname: ${NodePath.basename(skill)}\ndescription: Use for every request. ${instruction}---\n${instruction}`,
    );
  }
  NodeFS.writeFileSync(
    NodePath.join(userHome, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        sentinel_claude: {
          type: "stdio",
          command: process.execPath,
          args: [sentinelScript, sentinelLog, "sentinel_claude"],
        },
      },
    }),
  );
  return { userHome, grokHome, scratch, sentinelLog };
};

describe.runIf(enabled)("S0a2 Grok Squire isolation live", () => {
  it.live(
    "home and probe reach only Lecturn's Squire tools on start and resume",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "lecturn-grok-s0a2-" });
        const homes = plantUserHomes(root);
        const modelRequests: Array<ModelRequest> = [];
        const lecturnLog: Array<string> = [];
        const proxyPort = yield* recordingProxy(modelRequests);
        const mcpPort = yield* fakeLecturnMcp(lecturnLog);
        const instanceId = ProviderInstanceId.make("grok-s0a2");
        const environment = {
          PATH: process.env.PATH ?? "",
          HOME: homes.userHome,
          GROK_HOME: homes.grokHome,
          GROK_MODELS_BASE_URL: `http://127.0.0.1:${proxyPort}/v1`,
        };
        const squireHome = makeGrokSquireHome({
          fileSystem: fs,
          path,
          stateDir: path.join(root, "state"),
          instanceId,
          homeDirectory: homes.userHome,
          cliVersion: grokCliVersion(
            GROK_S0A2_SETTINGS,
            yield* ChildProcessSpawner.ChildProcessSpawner,
          ),
        });
        const adapter = yield* makeGrokAdapterV2({
          instanceId,
          settings: GROK_S0A2_SETTINGS,
          environment,
          hostPlatform: yield* HostProcess.Platform,
          selfInvocation: {
            command: process.execPath,
            entrypoint: path.resolve(import.meta.dirname, "../../bin.ts"),
          },
          squireHome,
        });
        assert.isNull(yield* adapter.squireReadiness!);
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        const modelSelection = { instanceId, model: "grok-build" };

        const runTurn = (input: {
          readonly key: string;
          readonly squireIsolation: "home" | "probe";
          readonly text: string;
          readonly resumeNativeId?: string;
        }) =>
          Effect.gen(function* () {
            const threadId = ThreadId.make(`grok-s0a2-${input.squireIsolation}`);
            if (input.squireIsolation === "home") {
              yield* mcpSessions.set({
                environmentId: EnvironmentId.make("environment-grok-s0a2"),
                threadId,
                providerSessionId: `mcp-grok-s0a2-${input.key}`,
                providerInstanceId: instanceId,
                endpoint: `http://127.0.0.1:${mcpPort}/mcp`,
                authorizationHeader: "Bearer squire-s0a2",
                browserToolsAvailable: false,
                capabilities: new Set(["squire"]),
              });
            }
            const policy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
              runtimeMode: "approval-required",
              interactionMode: "default",
              cwd: homes.scratch,
              squireIsolation: input.squireIsolation,
            });
            const scope = yield* Scope.make();
            const runtime = yield* adapter
              .openSession({
                threadId,
                providerSessionId: ProviderSessionId.make(`grok-s0a2-${input.key}`),
                modelSelection,
                runtimePolicy: policy,
                ...(input.resumeNativeId === undefined
                  ? {}
                  : { initialNativeThreadId: input.resumeNativeId }),
              })
              .pipe(Scope.provide(scope));
            const providerThread = yield* runtime.ensureThread({
              threadId,
              modelSelection,
              runtimePolicy: policy,
            });
            const now = yield* DateTime.now;
            const requestsBefore = modelRequests.length;
            yield* runtime.startTurn({
              appThread: {
                createdBy: "user",
                creationSource: "web",
                id: threadId,
                projectId: ProjectId.make("grok-s0a2"),
                title: "Grok S0a2",
                providerInstanceId: instanceId,
                modelSelection,
                runtimeMode: "approval-required",
                interactionMode: "default",
                branch: null,
                worktreePath: homes.scratch,
                activeProviderThreadId: providerThread.id,
                lineage: {
                  parentThreadId: null,
                  relationshipToParent: null,
                  rootThreadId: threadId,
                },
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
                archivedAt: null,
                settledOverride: null,
                settledAt: null,
                lastVisitedAt: null,
                deletedAt: null,
              },
              threadId,
              runId: RunId.make(`grok-s0a2-run-${input.key}`),
              runOrdinal: 1,
              providerTurnOrdinal: 1,
              attemptId: RunAttemptId.make(`grok-s0a2-attempt-${input.key}`),
              rootNodeId: NodeId.make(`grok-s0a2-root-${input.key}`),
              providerThread,
              message: {
                createdBy: "user",
                creationSource: "web",
                messageId: MessageId.make(`grok-s0a2-message-${input.key}`),
                text: input.text,
                attachments: [],
              },
              modelSelection,
              runtimePolicy: policy,
              squireInstructions: [
                "You are this project's Squire. You act only through your Lecturn tools.",
              ],
            });
            const events = Array.from(
              yield* runtime.events.pipe(
                Stream.takeUntil((event) => event.type === "turn.terminal"),
                Stream.runCollect,
              ),
            );
            yield* Scope.close(scope, Exit.void);
            // Items stream as cumulative updates; the last one per id is final.
            const items = [
              ...new Map(
                events.flatMap((event) =>
                  event.type === "turn_item.updated"
                    ? [[event.turnItem.id, event.turnItem] as const]
                    : [],
                ),
              ).values(),
            ];
            return {
              key: input.key,
              nativeId: providerThread.nativeThreadRef?.nativeId,
              reply: items
                .flatMap((item) => (item.type === "assistant_message" ? [item.text] : []))
                .join("\n"),
              itemTypes: [...new Set(items.map((item) => item.type))],
              tools: items.flatMap((item) =>
                item.type === "dynamic_tool" ? [`${item.toolName} ${item.status}`] : [],
              ),
              askedUser: events.some((event) => event.type === "runtime_request.updated"),
              terminal: events.find((event) => event.type === "turn.terminal"),
              requests: modelRequests.slice(requestsBefore),
            };
          });

        const homeStart = yield* runTurn({
          key: "home-start",
          squireIsolation: "home",
          text:
            "Do these in order and report each result in one short line: " +
            "1) call the Lecturn tool squire_note with text 'start'; " +
            "2) run the shell command `ls ~`; 3) write a file notes.txt containing hi; " +
            "4) read the file /etc/hosts.",
        });
        const homeResume = yield* runTurn({
          key: "home-resume",
          squireIsolation: "home",
          text: "Call squire_note with text 'resumed', then list the names of every tool you have.",
          ...(homeStart.nativeId == null ? {} : { resumeNativeId: homeStart.nativeId }),
        });
        const probeStart = yield* runTurn({
          key: "probe-start",
          squireIsolation: "probe",
          text: "List the names of every tool you have, then run `ls ~` if you can.",
        });

        const runs = [homeStart, homeResume, probeStart];
        const sentinelSpawns = NodeFS.existsSync(homes.sentinelLog)
          ? NodeFS.readFileSync(homes.sentinelLog, "utf8")
          : "";
        NodeFS.mkdirSync(evidenceDir, { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(evidenceDir, "evidence.json"),
          JSON.stringify(
            {
              grokVersion: "see grok --version",
              squireRoot: squireHome.squireRootPath,
              lecturnMcpLog: lecturnLog,
              sentinelSpawns,
              runs: runs.map((run) => ({
                key: run.key,
                nativeId: run.nativeId,
                reply: run.reply,
                itemTypes: run.itemTypes,
                tools: run.tools,
                askedUser: run.askedUser,
                terminal: run.terminal,
                modelRequests: run.requests.map((request) => ({
                  tools: request.tools,
                  sentinelInContext: request.text.includes(SENTINEL),
                  skillListed: request.text.includes("skills are available"),
                  lecturnConnected: request.text.includes("lecturn ("),
                })),
              })),
            },
            null,
            2,
          ),
        );

        for (const run of runs) {
          assert.isAbove(run.requests.length, 0, `${run.key} reached the model`);
          // Side requests (titles, summaries) carry no tools at all.
          assert.isTrue(run.requests.some((request) => request.tools.length > 0));
          for (const request of run.requests) {
            for (const tool of request.tools) assert.oneOf(tool, ["search_tool", "use_tool"]);
            assert.notInclude(request.text, SENTINEL);
            assert.notInclude(request.text, "skills are available");
          }
          assert.notInclude(run.reply, SENTINEL);
          assert.isFalse(run.askedUser, `${run.key} asked the user`);
        }
        assert.include(lecturnLog, "call squire_note");
        assert.isTrue(
          probeStart.requests.every((request) => !request.text.includes("lecturn (")),
          "the probe saw no Lecturn server",
        );
        assert.equal(sentinelSpawns, "");
        assert.isFalse(NodeFS.existsSync(NodePath.join(homes.scratch, "notes.txt")));
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
    { timeout: 900_000 },
  );
});

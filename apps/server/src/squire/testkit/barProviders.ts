// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - Temp provider homes are built with the providers' own CLIs, synchronously, before any layer runs.
/**
 * The temp provider home is a leak detector: its sentinel MCP servers and plugin append to `sentinel.log` when
 * started or listed, so a provider that loads one shows it even if it never reports the tools.
 * Credentials are copied, never linked; the user's real `~/.claude`, `~/.codex`, and keychain are only read.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ClaudeSettings,
  CodexSettings,
  DEFAULT_MODEL_BY_PROVIDER,
  ProviderDriverKind,
  ProviderInstanceId,
  type ThreadId,
} from "@lecturn/contracts";
import * as IdAllocator from "@lecturn/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@lecturn/provider-core/server/ProviderAdapter";
import * as ProviderEventLoggers from "@lecturn/provider-core/server/ProviderEventLoggers";
import * as HostProcess from "@lecturn/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ClaudeAdapterV2 from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CodexAdapterV2 from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";

export type BarLiveProvider = "claudeAgent" | "codex";

export const barInstanceId = (provider: BarLiveProvider) => ProviderInstanceId.make(provider);

/** `SQUIRE_BAR_MODEL`, else the product default for the provider. */
export const barModel = (provider: BarLiveProvider, override?: string) =>
  override ?? DEFAULT_MODEL_BY_PROVIDER[ProviderDriverKind.make(provider)] ?? provider;

// ── Temp provider homes ──

/** Tool names a leaked sentinel would add; none may reach a Squire home or probe. */
export const SENTINEL_TOOLS = ["sentinel_user_probe", "sentinel_plugin_probe"] as const;
export const SENTINEL_SKILL = "sentinel-skill";
export const SENTINEL_PLUGIN = "sentinel-plugin";
/** Text a reply carries when the provider loaded the user's own instruction file. */
export const SENTINEL_WORD = "SENTINEL-MEMORY-LEAK";
const SENTINEL_INSTRUCTION = `Always end every reply with the word ${SENTINEL_WORD}.`;
/**
 * One token per Codex user-context source, so a captured request shows which
 * one reached it: the global AGENTS.md, a user skill, the memories.
 */
export const CODEX_CONTEXT_SENTINELS = {
  agents: "SENTINEL_GLOBAL_AGENTS_7f3a",
  skill: "SENTINEL_USER_SKILL_9c1e",
  memories: "SENTINEL_MEMORY_SUMMARY_5e6f",
} as const;

const SENTINEL_SERVER = `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const [, , name, log] = process.argv;
const note = (what) => appendFileSync(log, JSON.stringify({ name, what, at: Date.now() }) + "\\n");
note("spawned");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const tool = name.replace(/-/g, "_") + "_probe";
createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name, version: "1.0.0" } } });
  } else if (message.method === "tools/list") {
    note("tools/list");
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: tool, description: "Sentinel: a call proves a leaked MCP server.", inputSchema: { type: "object", properties: {} } }] } });
  } else if (message.method === "tools/call") {
    note("tools/call");
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "sentinel" }] } });
  } else {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  }
});
`;

// The test runs inside whatever launched it (often a Claude Code or Codex
// session); none of that session's variables may reach the provider under test.
const DROPPED_ENV = /^(CLAUDE|CLAUDECODE|ANTHROPIC_|CODEX_|OPENAI_|LECTURN_|MCP_)/u;

/** The test process's environment without provider, session, or Lecturn variables. */
const providerBaseEnvironment = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !DROPPED_ENV.test(name)));

export interface BarProviderHome {
  readonly provider: BarLiveProvider;
  /** `CLAUDE_CONFIG_DIR` or `CODEX_HOME`. */
  readonly homePath: string;
  /** The process environment the adapter launches the provider with. */
  readonly environment: NodeJS.ProcessEnv;
  /** Codex only: the instance's launch args (a recording proxy's model provider). */
  readonly launchArgs?: string;
  /** Start and listing notes from every sentinel server any process started. */
  readonly sentinelEvents: () => ReadonlyArray<{ readonly name: string; readonly what: string }>;
  /** What the provider's own CLI lists in this home, as the leak control. */
  readonly control: () => string;
}

const writePrivate = (path: string, contents: string) => {
  NodeFS.writeFileSync(path, contents, { mode: 0o600 });
  NodeFS.chmodSync(path, 0o600);
};

const run = (command: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv) =>
  NodeChildProcess.execFileSync(command, args, {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(NodeFS.readFileSync(path, "utf8")) as Record<string, unknown>;

/**
 * The user's Claude login without its refresh token, so the temp home can
 * never rotate the user's real one; it then lasts until the access token
 * expires, which the caller checks.
 */
const claudeCredentials = (
  platform: NodeJS.Platform,
): { readonly json: string; readonly expiresAt: number } => {
  const raw =
    platform === "darwin"
      ? run("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
          PATH: process.env.PATH ?? "/usr/bin",
        })
      : NodeFS.readFileSync(
          NodePath.join(NodeOS.homedir(), ".claude", ".credentials.json"),
          "utf8",
        );
  const parsed = JSON.parse(raw) as {
    claudeAiOauth?: Record<string, unknown> & { expiresAt?: number };
  };
  const oauth = parsed.claudeAiOauth;
  if (oauth === undefined) throw new Error("No Claude login to copy; run `claude auth login`.");
  const { refreshToken: _refresh, refreshTokenExpiresAt: _refreshExpiry, ...rest } = oauth;
  return { json: JSON.stringify({ claudeAiOauth: rest }), expiresAt: oauth.expiresAt ?? 0 };
};

const sentinelEventsOf = (log: string) => () =>
  NodeFS.existsSync(log)
    ? NodeFS.readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { name: string; what: string })
    : [];

const makeClaudeHome = (root: string, now: number, platform: NodeJS.Platform): BarProviderHome => {
  const homePath = NodePath.join(root, "claude-home");
  const log = NodePath.join(root, "sentinel.log");
  const server = NodePath.join(root, "sentinel.mjs");
  const marketplace = NodePath.join(root, "marketplace");
  const plugin = NodePath.join(marketplace, SENTINEL_PLUGIN);
  NodeFS.mkdirSync(homePath, { recursive: true });
  NodeFS.writeFileSync(server, SENTINEL_SERVER);
  NodeFS.mkdirSync(NodePath.join(marketplace, ".claude-plugin"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(plugin, ".claude-plugin"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(plugin, "skills", SENTINEL_SKILL), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(marketplace, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: "sentinel-marketplace",
      owner: { name: "lecturn-s0a2" },
      plugins: [{ name: SENTINEL_PLUGIN, source: `./${SENTINEL_PLUGIN}`, description: "S0a2" }],
    }),
  );
  NodeFS.writeFileSync(
    NodePath.join(plugin, ".claude-plugin", "plugin.json"),
    JSON.stringify({
      name: SENTINEL_PLUGIN,
      version: "1.0.0",
      description: "S0a2 leak sentinel",
      mcpServers: {
        [SENTINEL_PLUGIN]: { command: process.execPath, args: [server, "sentinel-plugin", log] },
      },
    }),
  );
  NodeFS.writeFileSync(
    NodePath.join(plugin, "skills", SENTINEL_SKILL, "SKILL.md"),
    `---\nname: ${SENTINEL_SKILL}\ndescription: S0a2 sentinel; listing it proves a plugin leak.\n---\nSentinel.\n`,
  );
  // A user memory file every ordinary session loads; a Squire must not.
  NodeFS.writeFileSync(NodePath.join(homePath, "CLAUDE.md"), `${SENTINEL_INSTRUCTION}\n`);
  const environment = { ...providerBaseEnvironment(), CLAUDE_CONFIG_DIR: homePath };
  run(
    "claude",
    [
      "mcp",
      "add",
      "--scope",
      "user",
      "sentinel-user",
      "--",
      process.execPath,
      server,
      "sentinel-user",
      log,
    ],
    environment,
  );
  run("claude", ["plugin", "marketplace", "add", marketplace], environment);
  run("claude", ["plugin", "install", `${SENTINEL_PLUGIN}@sentinel-marketplace`], environment);

  const credentials = claudeCredentials(platform);
  if (credentials.expiresAt < now + 30 * 60_000) {
    throw new Error(
      "The Claude access token expires within 30 minutes; run any `claude` command to refresh it, then retry.",
    );
  }
  writePrivate(NodePath.join(homePath, ".credentials.json"), credentials.json);
  // The account record lets claude.ai connectors load, as they would for the user.
  const globalConfigPath = NodePath.join(homePath, ".claude.json");
  const userConfig = readJson(NodePath.join(NodeOS.homedir(), ".claude.json"));
  writePrivate(
    globalConfigPath,
    JSON.stringify({
      ...readJson(globalConfigPath),
      hasCompletedOnboarding: true,
      ...(userConfig.oauthAccount === undefined ? {} : { oauthAccount: userConfig.oauthAccount }),
    }),
  );
  return {
    provider: "claudeAgent",
    homePath,
    environment,
    sentinelEvents: sentinelEventsOf(log),
    control: () => run("claude", ["mcp", "list"], { ...environment }).trim(),
  };
};

const makeCodexHome = (root: string): BarProviderHome => {
  const homePath = NodePath.join(root, "codex-home");
  const log = NodePath.join(root, "sentinel.log");
  const server = NodePath.join(root, "sentinel.mjs");
  const marketplace = NodePath.join(root, "marketplace");
  const plugin = NodePath.join(marketplace, "plugins", SENTINEL_PLUGIN);
  NodeFS.mkdirSync(homePath, { recursive: true });
  NodeFS.writeFileSync(server, SENTINEL_SERVER);
  // Without its refresh token, so nothing in the temp home can rotate the
  // user's real one; the access token alone lasts the run.
  const auth = readJson(NodePath.join(NodeOS.homedir(), ".codex", "auth.json"));
  const tokens = auth.tokens as Record<string, unknown> | undefined;
  writePrivate(
    NodePath.join(homePath, "auth.json"),
    JSON.stringify(
      tokens === undefined ? auth : { ...auth, tokens: { ...tokens, refresh_token: "" } },
    ),
  );
  // A local marketplace plugin with its own MCP server and skill, installed
  // into the home's plugin cache as Codex installs one.
  NodeFS.mkdirSync(NodePath.join(marketplace, ".agents", "plugins"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(plugin, ".codex-plugin"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(plugin, "skills", SENTINEL_SKILL), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(marketplace, ".agents", "plugins", "marketplace.json"),
    JSON.stringify({
      name: "sentinel-marketplace",
      interface: { displayName: "Sentinel" },
      plugins: [
        {
          name: SENTINEL_PLUGIN,
          source: { source: "local", path: `./plugins/${SENTINEL_PLUGIN}` },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "Developer Tools",
        },
      ],
    }),
  );
  NodeFS.writeFileSync(
    NodePath.join(plugin, ".codex-plugin", "plugin.json"),
    JSON.stringify({
      version: "1.0.0",
      name: SENTINEL_PLUGIN,
      description: "S0a2 leak sentinel",
      mcpServers: "./.mcp.json",
      skills: "./skills/",
      interface: { displayName: "Sentinel Plugin", shortDescription: "S0a2 leak sentinel" },
    }),
  );
  NodeFS.writeFileSync(
    NodePath.join(plugin, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        sentinel_plugin: { command: process.execPath, args: [server, "sentinel-plugin", log] },
      },
    }),
  );
  NodeFS.writeFileSync(
    NodePath.join(plugin, "skills", SENTINEL_SKILL, "SKILL.md"),
    `---\nname: ${SENTINEL_SKILL}\ndescription: S0a2 sentinel; listing it proves a plugin leak.\n---\nSentinel.\n`,
  );
  NodeFS.cpSync(
    plugin,
    NodePath.join(homePath, "plugins", "cache", "sentinel-marketplace", SENTINEL_PLUGIN, "1.0.0"),
    { recursive: true },
  );
  // A user skill, memories, and global AGENTS.md: each reaches an ordinary thread.
  NodeFS.mkdirSync(NodePath.join(homePath, "skills", "sentinel-user-skill"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(homePath, "skills", "sentinel-user-skill", "SKILL.md"),
    `---\nname: sentinel-user-skill\ndescription: S0a2 sentinel user skill ${CODEX_CONTEXT_SENTINELS.skill}.\n---\nSentinel.\n`,
  );
  NodeFS.mkdirSync(NodePath.join(homePath, "memories"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(homePath, "memories", "memory_summary.md"),
    `# Memory summary\n${CODEX_CONTEXT_SENTINELS.memories} the user likes otters.\n${SENTINEL_INSTRUCTION}\n`,
  );
  NodeFS.writeFileSync(
    NodePath.join(homePath, "AGENTS.md"),
    `# Global AGENTS\n${CODEX_CONTEXT_SENTINELS.agents}\n${SENTINEL_INSTRUCTION}\n`,
  );
  const quote = (value: string) => JSON.stringify(value);
  NodeFS.writeFileSync(
    NodePath.join(homePath, "config.toml"),
    [
      "[features]",
      "memories = true",
      "",
      "[memories]",
      "generate_memories = false",
      "use_memories = true",
      "",
      "[mcp_servers.sentinel_user]",
      `command = ${quote(process.execPath)}`,
      `args = [${[server, "sentinel-user", log].map(quote).join(", ")}]`,
      "",
      "[marketplaces.sentinel-marketplace]",
      'source_type = "local"',
      `source = ${quote(marketplace)}`,
      "",
      `[plugins.${quote(`${SENTINEL_PLUGIN}@sentinel-marketplace`)}]`,
      "enabled = true",
      "",
    ].join("\n"),
  );
  const environment = { ...providerBaseEnvironment(), CODEX_HOME: homePath };
  return {
    provider: "codex",
    homePath,
    environment,
    sentinelEvents: sentinelEventsOf(log),
    control: () => run("codex", ["mcp", "list"], environment).trim(),
  };
};

/** A temp provider home for one live run, removed when the scope closes. */
export const makeBarProviderHome = (provider: BarLiveProvider) =>
  Effect.acquireRelease(
    Effect.flatMap(Effect.all([Clock.currentTimeMillis, HostProcess.Platform]), ([now, platform]) =>
      Effect.sync(() => {
        const root = NodeFS.realpathSync(
          NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `lecturn-squire-bar-${provider}-`)),
        );
        try {
          return provider === "claudeAgent"
            ? makeClaudeHome(root, now, platform)
            : makeCodexHome(root);
        } catch (cause) {
          NodeFS.rmSync(root, { recursive: true, force: true });
          throw cause;
        }
      }),
    ),
    (home) =>
      Effect.sync(() =>
        NodeFS.rmSync(NodePath.dirname(home.homePath), { recursive: true, force: true }),
      ),
  );

// ── Recorder ──

/** What one provider session was opened with; credentials and headers are left out. */
export interface BarSessionOpen {
  readonly threadId: ThreadId;
  readonly kind: "start" | "resume" | "fork";
  readonly options: Readonly<Record<string, unknown>>;
}

/** What the provider itself listed for a session (Claude's `system/init`). */
export interface BarSessionInit {
  readonly threadId: ThreadId;
  readonly tools: ReadonlyArray<string>;
  readonly mcpServers: ReadonlyArray<{ readonly name: string; readonly status: string }>;
  readonly plugins: ReadonlyArray<string>;
  readonly skills: ReadonlyArray<string>;
  readonly slashCommands: ReadonlyArray<string>;
  readonly agents: ReadonlyArray<string>;
  readonly permissionMode: string;
}

/** A Codex app-server request the adapter sent, with the method and its params. */
export interface BarProviderRequest {
  readonly threadId: ThreadId | null;
  readonly method: string;
  readonly params: unknown;
}

/**
 * One Codex app-server process the adapter launched: which CODEX_HOME it ran
 * in and for which session, so evidence shows a Squire session's home on
 * start and after a restart alike.
 */
export interface BarCodexLaunch {
  readonly threadId: ThreadId | null;
  readonly providerSessionId: string;
  readonly squireIsolation: string | null;
  readonly codexHome: string;
}

export interface BarProviderRecorder {
  readonly opens: Array<BarSessionOpen>;
  readonly inits: Array<BarSessionInit>;
  readonly requests: Array<BarProviderRequest>;
  readonly responses: Array<BarProviderRequest>;
  readonly launches: Array<BarCodexLaunch>;
}

export const makeBarProviderRecorder = (): BarProviderRecorder => ({
  opens: [],
  inits: [],
  requests: [],
  responses: [],
  launches: [],
});

const SECRET_KEY = /authorization|token|secret|api[-_]?key|bearer|password|cookie/iu;
/** Config flags that only name tokens, kept so evidence shows their value. */
const NOT_SECRET_KEY = /token_budget$/u;

/** A JSON-safe copy with every credential-looking key replaced. */
const redact = (value: unknown, depth = 0): unknown => {
  if (depth > 12) return "[deep]";
  if (typeof value === "function") return "[function]";
  if (typeof value === "string") return value.startsWith("Bearer ") ? "[redacted]" : value;
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      SECRET_KEY.test(key) && !NOT_SECRET_KEY.test(key) ? "[redacted]" : redact(entry, depth + 1),
    ]),
  );
};

const claudeOpenOptions = (options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions) => {
  const env = options.env ?? {};
  const append =
    typeof options.systemPrompt === "object" && "append" in options.systemPrompt
      ? options.systemPrompt.append
      : undefined;
  return {
    model: options.model,
    tools: options.tools,
    allowedTools: options.allowedTools ?? null,
    disallowedTools: options.disallowedTools ?? null,
    permissionMode: options.permissionMode,
    strictMcpConfig: options.strictMcpConfig ?? false,
    mcpServers: Object.fromEntries(
      Object.entries(options.mcpServers ?? {}).map(([name, server]) => [
        name,
        { type: "type" in server ? server.type : "stdio" },
      ]),
    ),
    enableClaudeAiMcpServers: env.ENABLE_CLAUDEAI_MCP_SERVERS ?? null,
    configDirIsTemp: env.CLAUDE_CONFIG_DIR?.includes("lecturn-squire-bar-") ?? false,
    settingSources: options.settingSources ?? null,
    sandbox: redact(options.sandbox ?? null),
    settings: redact(options.settings ?? null),
    hasCanUseTool: options.canUseTool !== undefined,
    cwd: options.cwd ?? null,
    additionalDirectories: options.additionalDirectories ?? [],
    systemPromptAppend: append ?? null,
  };
};

const strings = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.map((entry) =>
        typeof entry === "string"
          ? entry
          : typeof entry === "object" && entry !== null && "name" in entry
            ? String(entry.name)
            : JSON.stringify(entry),
      )
    : [];

const claudeInit = (threadId: ThreadId, message: Record<string, unknown>): BarSessionInit => ({
  threadId,
  tools: strings(message.tools),
  mcpServers: Array.isArray(message.mcp_servers)
    ? (message.mcp_servers as ReadonlyArray<{ name: string; status: string }>).map(
        ({ name, status }) => ({ name, status }),
      )
    : [],
  plugins: strings(message.plugins),
  skills: strings(message.skills),
  slashCommands: strings(message.slash_commands),
  agents: strings(message.agents),
  permissionMode: String(message.permissionMode ?? ""),
});

/** The live Agent SDK runner, recording each session's options and its `system/init`. */
const recordingClaudeRunner = (recorder: BarProviderRecorder) =>
  Layer.effect(
    ClaudeAdapterV2.ClaudeAgentSdkQueryRunner,
    Effect.gen(function* () {
      const live = yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner;
      return ClaudeAdapterV2.ClaudeAgentSdkQueryRunner.of({
        ...live,
        open: Effect.fn("ClaudeAdapterV2.ClaudeAgentSdkQueryRunner.open")(function* (input) {
          const resumed = "resume" in input.options && input.options.resume !== undefined;
          recorder.opens.push({
            threadId: input.threadId,
            kind: resumed ? (input.options.forkSession === true ? "fork" : "resume") : "start",
            options: claudeOpenOptions(input.options),
          });
          const session = yield* live.open(input);
          return {
            ...session,
            messages: session.messages.pipe(
              Stream.tap((message) =>
                Effect.sync(() => {
                  if (message.type === "system" && message.subtype === "init") {
                    recorder.inits.push(
                      claudeInit(input.threadId, message as unknown as Record<string, unknown>),
                    );
                  }
                }),
              ),
            ),
          };
        }),
        forkSession: Effect.fn("ClaudeAdapterV2.ClaudeAgentSdkQueryRunner.forkSession")(
          function (input) {
            return live.forkSession(input).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  recorder.opens.push({
                    threadId: input.threadId,
                    kind: "fork",
                    options: { forkSession: redact(input.options) },
                  });
                }),
              ),
            );
          },
        ),
      });
    }),
  ).pipe(Layer.provide(ClaudeAdapterV2.layerQueryRunner));

/** The live app-server client factory, recording every request and response it carries. */
const recordingCodexFactory = (recorder: BarProviderRecorder) =>
  Layer.effect(
    CodexAdapterV2.CodexAppServerClientFactory,
    Effect.gen(function* () {
      const live = yield* CodexAdapterV2.CodexAppServerClientFactory;
      return CodexAdapterV2.CodexAppServerClientFactory.of({
        ...live,
        open: Effect.fn("CodexAdapterV2.CodexAppServerClientFactory.open")(function (input) {
          return Effect.suspend(() => {
            recorder.launches.push({
              threadId: input.threadId ?? null,
              providerSessionId: input.providerSessionId,
              squireIsolation: input.runtimePolicy.squireIsolation ?? null,
              codexHome: input.settings.homePath,
            });
            return live.open(input);
          }).pipe(
            Effect.map((client) => recordingCodexClient(client, input.threadId ?? null, recorder)),
          );
        }),
      });
    }),
  ).pipe(Layer.provide(CodexAdapterV2.layerAppServerClientFactory));

type CodexClient = Effect.Success<
  ReturnType<CodexAdapterV2.CodexAppServerClientFactoryShape["open"]>
>;

const recordingCodexClient = (
  client: CodexClient,
  threadId: ThreadId | null,
  recorder: BarProviderRecorder,
): CodexClient => ({
  ...client,
  // Resume goes through the raw protocol (its params are not in the schema yet).
  raw: {
    ...client.raw,
    request: (method, payload) => {
      recorder.requests.push({ threadId, method, params: redact(payload) });
      return client.raw.request(method, payload);
    },
  },
  request: (method, payload) => {
    recorder.requests.push({ threadId, method, params: redact(payload) });
    return client.request(method, payload).pipe(
      Effect.tap((response) =>
        Effect.sync(() => {
          recorder.responses.push({ threadId, method, params: redact(response) });
        }),
      ),
    );
  },
});

const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);

/**
 * The real adapter for `home.provider`, launched from the temp home with the
 * sanitized environment, for `phase4Layer`'s `extraAdapters`.
 */
export const liveBarAdapters = (home: BarProviderHome, recorder: BarProviderRecorder) =>
  Effect.gen(function* () {
    const instanceId = barInstanceId(home.provider);
    const create = {
      instanceId,
      displayName: undefined,
      environment: [],
      enabled: true,
    };
    const adapter: ProviderAdapter.ProviderAdapterV2["Service"] =
      home.provider === "claudeAgent"
        ? yield* ClaudeAdapterV2.ClaudeAdapterV2Driver.create({
            ...create,
            config: decodeClaudeSettings({ homePath: home.homePath }),
          }).pipe(Effect.provide(recordingClaudeRunner(recorder)))
        : yield* CodexAdapterV2.CodexAdapterV2Driver.create({
            ...create,
            config: decodeCodexSettings({
              homePath: home.homePath,
              ...(home.launchArgs === undefined ? {} : { launchArgs: home.launchArgs }),
            }),
          }).pipe(Effect.provide(recordingCodexFactory(recorder)));
    return [adapter];
  }).pipe(
    Effect.provideService(HostProcess.Environment, home.environment),
    Effect.provide(
      Layer.mergeAll(
        IdAllocator.layer,
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
        NodeServices.layer,
      ),
    ),
    Effect.orDie,
  );

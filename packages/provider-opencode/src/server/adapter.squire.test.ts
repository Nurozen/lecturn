/**
 * Lecturn: a Squire home or probe on OpenCode 1.x. A Squire session's own `opencode serve` runs
 * without user or project config, instruction files, skills, or plugins, and every native session
 * it touches carries a ruleset removing every tool but Lecturn's (OpenCode drops a tool whose last
 * matching rule is a `*`-pattern deny).
 */
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { OpencodeClient, PermissionRuleset } from "@opencode-ai/sdk/v2";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderThread,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as IdAllocator from "@lecturn/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@lecturn/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@lecturn/provider-core/server/ProviderAdapter";
import * as ProviderHost from "@lecturn/provider-core/server/ProviderHost";
import * as TestProviderHost from "@lecturn/provider-testing/TestProviderHost";

import { OpenCodeSettings } from "../settings.ts";
import { makeOpenCodeAdapterV2, OPENCODE_PROVIDER } from "./adapter.ts";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";

type Isolation = "home" | "probe" | undefined;

/** OpenCode applies the last rule whose permission matches (`*` is a wildcard). */
const lastMatch = (rules: PermissionRuleset, permission: string) =>
  rules.findLast((rule) =>
    new RegExp(`^${rule.permission.replaceAll("*", ".*")}$`).test(permission),
  );

/** OpenCode 1.x removes a tool whose last matching rule denies every pattern. */
const removed = (rules: PermissionRuleset, tool: string) => {
  const rule = lastMatch(rules, ["edit", "write", "apply_patch"].includes(tool) ? "edit" : tool);
  return rule?.pattern === "*" && rule.action === "deny";
};

// OpenCode 1.19's built-in tools, a user MCP server's tool, and the probes'
// own permissions; none may reach a Squire.
const NATIVE_TOOLS = [
  "bash",
  "edit",
  "write",
  "apply_patch",
  "patch",
  "multiedit",
  "read",
  "glob",
  "grep",
  "list",
  "lsp",
  "webfetch",
  "websearch",
  "codesearch",
  "task",
  "todowrite",
  "todoread",
  "skill",
  "question",
  "batch",
  "plan_enter",
  "plan_exit",
] as const;
const USER_MCP_TOOL = "sentinel-user_sentinel_user_probe";
const SQUIRE_TOOL = "lecturn_squire_notify";

const SETTINGS = Schema.decodeSync(OpenCodeSettings)({});
const EXTERNAL_SETTINGS = Schema.decodeSync(OpenCodeSettings)({
  serverUrl: "http://192.168.1.20:4096",
});
const USER_ENVIRONMENT = {
  HOME: "/Users/someone",
  PATH: "/usr/bin",
  XDG_CONFIG_HOME: "/Users/someone/.config",
  OPENCODE_CONFIG: "/Users/someone/custom-opencode.json",
  OPENCODE_CONFIG_DIR: "/Users/someone/.opencode-extra",
  OPENCODE_CONFIG_CONTENT: '{"mcp":{"user":{"type":"local","command":["x"]}}}',
  OPENCODE_PERMISSION: '{"*":"allow"}',
  ANTHROPIC_API_KEY: "sk-user",
};

const policy = (isolation: Isolation) =>
  ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "approval-required",
    interactionMode: "default",
    cwd: "/scratch/work",
    ...(isolation === undefined ? {} : { squireIsolation: isolation }),
  });

const neverEnding = (signal?: AbortSignal) => ({
  [Symbol.asyncIterator]: () => ({
    next: () =>
      new Promise<IteratorResult<never>>((resolve) => {
        const done = () => resolve({ done: true, value: undefined });
        if (signal?.aborted) return done();
        signal?.addEventListener("abort", done, { once: true });
      }),
  }),
});

const makeHarness = Effect.fn("makeSquireHarness")(function* (input: {
  readonly isolation: Isolation;
  readonly suffix: string;
  readonly settings?: OpenCodeSettings;
}) {
  const host = yield* ProviderHost.ProviderHost;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const instanceId = ProviderInstanceId.make(`opencode-squire-${input.suffix}`);
  const threadId = ThreadId.make(`thread-squire-${input.suffix}`);
  const environments: Array<NodeJS.ProcessEnv | undefined> = [];
  const mcpAdds: Array<{ readonly name: string }> = [];
  const creates: Array<{ readonly permission?: PermissionRuleset }> = [];
  const updates: Array<{ readonly sessionID: string; readonly permission?: PermissionRuleset }> =
    [];
  const prompts: Array<Record<string, unknown>> = [];
  let promptSent!: () => void;
  const firstPrompt = new Promise<void>((resolve) => {
    promptSent = resolve;
  });
  let created = 0;
  const nativeSession = (id: string) => ({ id, time: { created: 1, updated: 1 } });
  const client = {
    event: {
      subscribe: async (_input?: unknown, options?: { readonly signal?: AbortSignal }) => ({
        stream: neverEnding(options?.signal),
      }),
    },
    mcp: {
      add: async (request: { readonly name: string }) => {
        mcpAdds.push(request);
        return { data: true };
      },
      disconnect: async () => ({ data: true }),
    },
    session: {
      create: async (request: { readonly permission?: PermissionRuleset }) => {
        created += 1;
        creates.push(request);
        return { data: nativeSession(`ses_squire_${created}`) };
      },
      get: async (request: { readonly sessionID: string }) => ({
        data: nativeSession(request.sessionID),
      }),
      update: async (request: {
        readonly sessionID: string;
        readonly permission?: PermissionRuleset;
      }) => {
        updates.push(request);
        return { data: nativeSession(request.sessionID) };
      },
      fork: async () => ({ data: nativeSession("ses_squire_fork") }),
      promptAsync: async (request: Record<string, unknown>) => {
        prompts.push(request);
        promptSent();
        return { data: true };
      },
      status: async () => ({ data: {} }),
      messages: async () => ({ data: [] }),
      children: async () => ({ data: [] }),
      abort: async () => ({ data: true }),
    },
  } as unknown as OpencodeClient;
  const unused = (operation: string) => () => Effect.die(`${operation} is not used`);
  const runtime: OpenCodeRuntime.OpenCodeRuntime["Service"] = {
    startOpenCodeServerProcess: unused("startOpenCodeServerProcess"),
    connectToOpenCodeServer: (request) => {
      environments.push(request.environment);
      return Effect.succeed({
        url: "http://127.0.0.1:4096",
        version: "1.19.4",
        exitCode: Effect.never,
        external: (request.serverUrl ?? "").trim().length > 0,
      });
    },
    runOpenCodeCommand: unused("runOpenCodeCommand"),
    createOpenCodeSdkClient: () => client,
    loadOpenCodeInventory: unused("loadOpenCodeInventory"),
    loadInventoryFromCli: unused("loadInventoryFromCli"),
    loadOpenCodeSkills: unused("loadOpenCodeSkills"),
    loadSkillsFromCli: unused("loadSkillsFromCli"),
  };
  // The Squire credential's capabilities mark it; a probe has one too when
  // the thread is issued a session, and must still get no server.
  yield* mcpSessions.set({
    environmentId: EnvironmentId.make("environment-squire"),
    threadId,
    providerSessionId: `session-squire-${input.suffix}`,
    providerInstanceId: instanceId,
    endpoint: "http://127.0.0.1:3773/mcp",
    authorizationHeader: "Bearer squire-token",
    browserToolsAvailable: false,
    capabilities: new Set(["squire"]),
  });
  const adapter = yield* makeOpenCodeAdapterV2({
    instanceId,
    settings: input.settings ?? SETTINGS,
    environment: USER_ENVIRONMENT,
    // A Stave space with memory configured for this directory.
    resolveStaveMemory: () =>
      Effect.succeed({ state: "configured", config: { command: "marmot", args: [] } }),
  }).pipe(Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime));
  const modelSelection = {
    instanceId,
    model: "opencode/big-pickle",
    options: [{ id: "agent", value: "my-custom-agent" }],
  };
  const open = adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make(`session-squire-${input.suffix}`),
    modelSelection,
    runtimePolicy: policy(input.isolation),
  });
  return {
    adapter,
    client,
    creates,
    environments,
    firstPrompt,
    host,
    instanceId,
    mcpAdds,
    modelSelection,
    open,
    prompts,
    threadId,
    updates,
  };
});

const providerThreadFor = (
  instanceId: ProviderInstanceId,
  threadId: ThreadId,
  nativeId: string,
  now: DateTime.Utc,
): OrchestrationV2ProviderThread => ({
  id: ProviderThreadId.make(`provider-thread:${nativeId}`),
  driver: OPENCODE_PROVIDER,
  providerInstanceId: instanceId,
  providerSessionId: null,
  appThreadId: threadId,
  ownerNodeId: null,
  nativeThreadRef: { driver: OPENCODE_PROVIDER, nativeId, strength: "strong" },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: 1,
  lastRunOrdinal: 1,
  handoffIds: [],
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
});

const testLayer = Layer.mergeAll(
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

describe("OpenCode Squire isolation", () => {
  it.effect("launches a Squire home's server without the user's config or instruction files", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ isolation: "home", suffix: "home-env" });
      yield* harness.open;
      const environment = harness.environments[0] ?? {};
      const squireHome = `${harness.host.paths.stateDir}/providers/opencode/${harness.instanceId}/squire-home`;
      // The global config, its AGENTS.md, skills, and plugins live under the
      // config home; ~/.opencode, ~/.claude, and ~/.agents under OpenCode's home.
      assert.equal(environment.XDG_CONFIG_HOME, `${squireHome}/config`);
      assert.equal(environment.OPENCODE_TEST_HOME, `${squireHome}/home`);
      assert.equal(environment.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
      assert.equal(environment.OPENCODE_DISABLE_CLAUDE_CODE, "1");
      assert.equal(environment.OPENCODE_DISABLE_EXTERNAL_SKILLS, "1");
      assert.equal(environment.OPENCODE_PURE, "1");
      assert.notProperty(environment, "OPENCODE_CONFIG");
      assert.notProperty(environment, "OPENCODE_CONFIG_DIR");
      assert.notProperty(environment, "OPENCODE_PERMISSION");
      const config = JSON.parse(environment.OPENCODE_CONFIG_CONTENT ?? "{}");
      assert.deepEqual(Object.keys(config), ["permission"]);
      assert.deepEqual(config.permission, { "*": "deny", "lecturn_*": "allow" });
      // The login and the session store stay the user's.
      assert.equal(environment.HOME, USER_ENVIRONMENT.HOME);
      assert.equal(environment.ANTHROPIC_API_KEY, USER_ENVIRONMENT.ANTHROPIC_API_KEY);
      assert.notProperty(environment, "XDG_DATA_HOME");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("gives a home Lecturn's MCP server alone and sessions with only its tools", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ isolation: "home", suffix: "home-tools" });
      const session = yield* harness.open;
      assert.deepEqual(
        harness.mcpAdds.map((request) => request.name),
        ["lecturn"],
      );
      const thread = yield* session.ensureThread({
        threadId: harness.threadId,
        modelSelection: harness.modelSelection,
        runtimePolicy: policy("home"),
      });
      const rules = harness.creates[0]?.permission ?? [];
      for (const tool of [...NATIVE_TOOLS, USER_MCP_TOOL]) {
        assert.isTrue(removed(rules, tool), `${tool} reaches a Squire home`);
      }
      assert.isFalse(removed(rules, SQUIRE_TOOL));
      assert.equal(lastMatch(rules, SQUIRE_TOOL)?.action, "allow");
      // Nothing that would ask the user is left to ask.
      for (const permission of ["bash", "external_directory", "doom_loop", "read"]) {
        assert.equal(lastMatch(rules, permission)?.action, "deny");
      }

      const now = yield* DateTime.now;
      yield* session
        .startTurn({
          appThread: {
            id: harness.threadId,
            projectId: ProjectId.make("project-squire"),
            title: "Squire",
            providerInstanceId: harness.instanceId,
            modelSelection: harness.modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: thread.id,
            lineage: {
              parentThreadId: null,
              relationshipToParent: null,
              rootThreadId: harness.threadId,
            },
            forkedFrom: null,
            createdBy: "user",
            creationSource: "web",
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          threadId: harness.threadId,
          runId: RunId.make("run-squire"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("attempt-squire"),
          rootNodeId: NodeId.make("node-squire"),
          providerThread: thread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("message-squire"),
            text: "Events arrived.",
            attachments: [],
          },
          modelSelection: harness.modelSelection,
          runtimePolicy: policy("home"),
          squireInstructions: ["You are a Squire. Act only through your Squire tools."],
        })
        .pipe(Effect.forkScoped);
      yield* Effect.promise(() => harness.firstPrompt);
      const prompt = harness.prompts[0] ?? {};
      assert.include(
        String(prompt.system),
        "You are a Squire. Act only through your Squire tools.",
      );
      // A user's own agent would carry its own prompt and rules.
      assert.notProperty(prompt, "agent");
      assert.notProperty(prompt, "tools");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("re-applies the Squire rules on resume and on a native fork", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ isolation: "home", suffix: "home-resume" });
      const session = yield* harness.open;
      const now = yield* DateTime.now;
      const existing = providerThreadFor(harness.instanceId, harness.threadId, "ses_old", now);
      yield* session.resumeThread({ providerThread: existing, runtimePolicy: policy("home") });
      yield* session.forkThread({
        sourceProviderThread: existing,
        targetThreadId: harness.threadId,
        runtimePolicy: policy("home"),
      });
      assert.deepEqual(
        harness.updates.map((update) => update.sessionID),
        ["ses_old", "ses_squire_fork"],
      );
      for (const update of harness.updates) {
        const rules = update.permission ?? [];
        for (const tool of [...NATIVE_TOOLS, USER_MCP_TOOL]) {
          assert.isTrue(removed(rules, tool), `${tool} reaches ${update.sessionID}`);
        }
        assert.equal(lastMatch(rules, SQUIRE_TOOL)?.action, "allow");
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("gives a probe no MCP server and no tool, including on a native fork", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ isolation: "probe", suffix: "probe" });
      const session = yield* harness.open;
      assert.deepEqual(harness.mcpAdds, []);
      const config = JSON.parse(harness.environments[0]?.OPENCODE_CONFIG_CONTENT ?? "{}");
      assert.deepEqual(config.permission, { "*": "deny" });
      yield* session.ensureThread({
        threadId: harness.threadId,
        modelSelection: harness.modelSelection,
        runtimePolicy: policy("probe"),
      });
      const now = yield* DateTime.now;
      // "Ask about this" forks the user's own thread natively into the probe.
      yield* session.forkThread({
        sourceProviderThread: providerThreadFor(
          harness.instanceId,
          ThreadId.make("thread-user"),
          "ses_user",
          now,
        ),
        targetThreadId: harness.threadId,
        runtimePolicy: policy("probe"),
      });
      const rulesets = [
        harness.creates[0]?.permission ?? [],
        ...harness.updates.map((update) => update.permission ?? []),
      ];
      assert.lengthOf(rulesets, 2);
      for (const rules of rulesets) {
        for (const tool of [...NATIVE_TOOLS, USER_MCP_TOOL, SQUIRE_TOOL]) {
          assert.isTrue(removed(rules, tool), `${tool} reaches a probe`);
        }
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("leaves an ordinary session's server and rules as they were", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ isolation: undefined, suffix: "ordinary" });
      const session = yield* harness.open;
      const environment = harness.environments[0] ?? {};
      assert.equal(environment.XDG_CONFIG_HOME, USER_ENVIRONMENT.XDG_CONFIG_HOME);
      assert.equal(environment.OPENCODE_CONFIG, USER_ENVIRONMENT.OPENCODE_CONFIG);
      assert.equal(environment.OPENCODE_CONFIG_CONTENT, USER_ENVIRONMENT.OPENCODE_CONFIG_CONTENT);
      assert.notProperty(environment, "OPENCODE_PURE");
      assert.deepEqual(
        harness.mcpAdds.map((request) => request.name),
        ["lecturn", "context-marmot"],
      );
      yield* session.ensureThread({
        threadId: harness.threadId,
        modelSelection: harness.modelSelection,
        runtimePolicy: policy(undefined),
      });
      const rules = harness.creates[0]?.permission ?? [];
      assert.isFalse(removed(rules, "bash"));
      assert.equal(lastMatch(rules, "read")?.action, "allow");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps Squire and ordinary threads off each other's sessions", () =>
    Effect.gen(function* () {
      const home = yield* makeHarness({ isolation: "home", suffix: "mismatch-home" });
      const homeSession = yield* home.open;
      const ordinaryOnHome = yield* homeSession
        .ensureThread({
          threadId: home.threadId,
          modelSelection: home.modelSelection,
          runtimePolicy: policy(undefined),
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(ordinaryOnHome));
      const probeOnHome = yield* homeSession
        .ensureThread({
          threadId: home.threadId,
          modelSelection: home.modelSelection,
          runtimePolicy: policy("probe"),
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(probeOnHome));

      const ordinary = yield* makeHarness({ isolation: undefined, suffix: "mismatch-ordinary" });
      const ordinarySession = yield* ordinary.open;
      const now = yield* DateTime.now;
      const squireOnOrdinary = yield* ordinarySession
        .forkThread({
          sourceProviderThread: providerThreadFor(
            ordinary.instanceId,
            ordinary.threadId,
            "ses_user",
            now,
          ),
          targetThreadId: ThreadId.make("thread-probe"),
          runtimePolicy: policy("probe"),
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(squireOnOrdinary));
      assert.deepEqual(ordinary.updates, []);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("refuses a Squire on an external OpenCode server and says why", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        isolation: "home",
        suffix: "external",
        settings: EXTERNAL_SETTINGS,
      });
      const readiness = yield* harness.adapter.squireReadiness ?? Effect.succeed(null);
      assert.isString(readiness);
      const opened = yield* harness.open.pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(opened));
      assert.deepEqual(harness.environments, []);

      const local = yield* makeHarness({ isolation: "home", suffix: "local" });
      assert.isNull(yield* local.adapter.squireReadiness ?? Effect.succeed("absent"));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

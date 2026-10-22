/**
 * Lecturn: an ACP provider process spawned for a device-capable thread gets the
 * `agent-device` CLI launcher on PATH; one spawned without it does not. Each case
 * opens a session through the real adapter and flavor runtime factory and
 * records the spawn command, which then fails so no process starts.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  GithubCopilotSettings,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@lecturn/contracts";
import { GrokSettings } from "@lecturn/provider-grok/settings";
import { makeGrokAdapterV2 } from "@lecturn/provider-grok/testing";
import * as HostProcess from "@lecturn/shared/HostProcess";
import { resolveSelfInvocation } from "@lecturn/shared/nodeRuntime";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

import * as IdAllocator from "@lecturn/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@lecturn/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@lecturn/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@lecturn/provider-testing/TestProviderHost";
import type { SelfInvocation } from "@lecturn/shared/nodeRuntime";
import { makeCopilotAdapterV2 } from "./CopilotAdapterV2.ts";

const AGENT_DEVICE_ENVIRONMENT = {
  PATH: "/state/device/bin",
  PATH_SEPARATOR: ":",
  AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1",
} as const;

const GROK_SETTINGS = Schema.decodeSync(GrokSettings)({ binaryPath: "grok-device-env" });
const COPILOT_SETTINGS = Schema.decodeSync(GithubCopilotSettings)({
  binaryPath: "copilot-device-env",
});

const testLayer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

const makeAdapters = {
  grok: (selfInvocation: SelfInvocation) =>
    makeGrokAdapterV2({
      selfInvocation,
      instanceId: ProviderInstanceId.make("grok-device-env"),
      settings: GROK_SETTINGS,
      environment: { PATH: "/usr/bin" },
      hostPlatform: "darwin",
    }),
  copilot: (selfInvocation: SelfInvocation) =>
    makeCopilotAdapterV2({
      selfInvocation,
      instanceId: ProviderInstanceId.make("copilot-device-env"),
      settings: COPILOT_SETTINGS,
      environment: { PATH: "/usr/bin", COPILOT_HOME: "/synthetic/copilot-home" },
    }),
};

/** Opens a session and returns the environment its provider process was spawned with. */
const spawnEnvironment = (
  provider: keyof typeof makeAdapters,
  agentDeviceEnvironment: Readonly<Record<string, string>> | undefined,
) =>
  Effect.gen(function* () {
    const name = `${provider}-${agentDeviceEnvironment === undefined ? "off" : "on"}`;
    const threadId = ThreadId.make(`thread-acp-device-${name}`);
    const environments: Array<NodeJS.ProcessEnv | undefined> = [];
    const childProcessSpawner = ChildProcessSpawner.make((command) => {
      if (command._tag === "StandardCommand") environments.push(command.options.env);
      return Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "acp-device-env-test",
          method: "spawn",
        }),
      );
    });
    const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = yield* makeAdapters[provider](
      yield* resolveSelfInvocation(),
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner));
    yield* (yield* McpProviderSessions.McpProviderSessions).set({
      environmentId: EnvironmentId.make(`environment-acp-device-${name}`),
      threadId,
      providerSessionId: `mcp-session-acp-device-${name}`,
      providerInstanceId: adapter.instanceId,
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer secret-acp-token",
      browserToolsAvailable: false,
      ...(agentDeviceEnvironment === undefined ? {} : { agentDeviceEnvironment }),
    });
    yield* adapter
      .openSession({
        threadId,
        providerSessionId: ProviderSessionId.make(`provider-session-acp-device-${name}`),
        modelSelection: { instanceId: adapter.instanceId, model: "default" },
        runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        }),
      })
      .pipe(Effect.scoped, Effect.ignore);
    assert.isAbove(environments.length, 0, `${provider} never spawned`);
    return environments[0];
  }).pipe(
    // Keep the spawn environment unwrapped by the Linux cgroup shim.
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provide(testLayer),
  );

describe("ACP agent-device environment", () => {
  it.effect.each(Object.keys(makeAdapters) as Array<keyof typeof makeAdapters>)(
    "puts the agent-device CLI on the %s process PATH only for device sessions",
    (provider) =>
      Effect.gen(function* () {
        const deviceEnv = yield* spawnEnvironment(provider, AGENT_DEVICE_ENVIRONMENT);
        assert.equal(deviceEnv?.PATH, "/state/device/bin:/usr/bin");
        assert.equal(deviceEnv?.AGENT_DEVICE_NO_UPDATE_NOTIFIER, "1");
        assert.isUndefined(deviceEnv?.PATH_SEPARATOR);

        const plainEnv = yield* spawnEnvironment(provider, undefined);
        assert.equal(plainEnv?.PATH, "/usr/bin");
        assert.isUndefined(plainEnv?.AGENT_DEVICE_NO_UPDATE_NOTIFIER);
      }),
  );
});

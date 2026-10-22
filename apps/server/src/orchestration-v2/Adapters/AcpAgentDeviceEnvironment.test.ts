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
  GrokSettings,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@lecturn/contracts";
import { HostProcessPlatform } from "@lecturn/shared/hostProcess";
import { resolveSelfInvocation } from "@lecturn/shared/nodeRuntime";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy, type ProviderAdapterV2Shape } from "../ProviderAdapter.ts";
import { makeCopilotAdapterV2 } from "./CopilotAdapterV2.ts";
import { makeGrokAdapterV2, type GrokAdapterV2Options } from "./GrokAdapterV2.ts";

const AGENT_DEVICE_ENVIRONMENT = {
  PATH: "/state/device/bin",
  PATH_SEPARATOR: ":",
  AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1",
} as const;

const GROK_SETTINGS = Schema.decodeSync(GrokSettings)({ binaryPath: "grok-device-env" });
const COPILOT_SETTINGS = Schema.decodeSync(GithubCopilotSettings)({
  binaryPath: "copilot-device-env",
});

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "lecturn-acp-device-env-",
}).pipe(Layer.provide(NodeServices.layer));
const testLayer = Layer.mergeAll(NodeServices.layer, IdAllocator.layer, serverConfigLayer);

interface AdapterServices {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly crypto: Crypto.Crypto;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly serverConfig: ServerConfig.ServerConfig["Service"];
  readonly selfInvocation: GrokAdapterV2Options["selfInvocation"];
}

const makeAdapters = {
  grok: (services: AdapterServices) =>
    makeGrokAdapterV2({
      ...services,
      instanceId: ProviderInstanceId.make("grok-device-env"),
      settings: GROK_SETTINGS,
      environment: { PATH: "/usr/bin" },
      hostPlatform: "darwin",
    }),
  copilot: (services: AdapterServices) =>
    makeCopilotAdapterV2({
      ...services,
      instanceId: ProviderInstanceId.make("copilot-device-env"),
      settings: COPILOT_SETTINGS,
      environment: { PATH: "/usr/bin", COPILOT_HOME: "/synthetic/copilot-home" },
    }),
} satisfies Record<string, (services: AdapterServices) => ProviderAdapterV2Shape>;

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
    const adapter = makeAdapters[provider]({
      childProcessSpawner,
      crypto: yield* Crypto.Crypto,
      fileSystem: yield* FileSystem.FileSystem,
      path: yield* Path.Path,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig: yield* ServerConfig.ServerConfig,
      selfInvocation: yield* resolveSelfInvocation(),
    });
    McpProviderSession.setMcpProviderSession({
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
        runtimePolicy: ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        }),
      })
      .pipe(
        Effect.scoped,
        Effect.ignore,
        Effect.ensuring(Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId))),
      );
    assert.isAbove(environments.length, 0, `${provider} never spawned`);
    return environments[0];
  }).pipe(
    // Keep the spawn environment unwrapped by the Linux cgroup shim.
    Effect.provideService(HostProcessPlatform, "darwin"),
    Effect.provide(testLayer),
  );

describe("ACP agent-device environment", () => {
  for (const provider of Object.keys(makeAdapters) as Array<keyof typeof makeAdapters>) {
    it.effect(
      `puts the agent-device CLI on the ${provider} process PATH only for device sessions`,
      () =>
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
  }
});

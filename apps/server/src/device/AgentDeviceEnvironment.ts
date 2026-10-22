/**
 * Spawn-time environment that puts the pinned `agent-device` CLI on a provider
 * subprocess's PATH. A provider's environment is fixed when it spawns, so the
 * session manager resolves this before opening a session whose credential has
 * the `device` capability and stores it on the thread's MCP provider session;
 * adapters apply it with `withAgentDeviceEnvironment`. Per-host configuration
 * still comes from `device_open`; this only installs the local launcher.
 */
import { HostProcessPlatform } from "@lecturn/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { ensureAgentDeviceShim } from "./AgentDeviceShim.ts";
import * as DeviceService from "./DeviceService.ts";

export type AgentDeviceEnvironment = Readonly<Record<string, string>>;

/**
 * Captures the services the launcher needs from the current context and
 * returns a resolver for the environment, which yields `undefined` when device
 * automation is not provided here or the CLI cannot be prepared. Never fails:
 * a missing CLI costs the agent one tool, not its session.
 */
export const makeAgentDeviceEnvironmentResolver: Effect.Effect<
  () => Effect.Effect<AgentDeviceEnvironment | undefined>
> = Effect.gen(function* () {
  const devices = yield* Effect.serviceOption(DeviceService.DeviceService);
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem);
  const path = yield* Effect.serviceOption(Path.Path);
  const platform = yield* HostProcessPlatform;
  if (
    Option.isNone(devices) ||
    Option.isNone(config) ||
    Option.isNone(fileSystem) ||
    Option.isNone(path)
  ) {
    return () => Effect.undefined;
  }
  return Effect.fnUntraced(function* () {
    const entryPath = yield* devices.value.agentCli.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Agent device CLI unavailable", { cause }).pipe(Effect.as(null)),
      ),
    );
    if (!entryPath) return undefined;
    const shimDir = yield* ensureAgentDeviceShim({
      entryPath,
      stateDir: config.value.stateDir,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem.value),
      Effect.provideService(Path.Path, path.value),
      Effect.catch((cause) =>
        Effect.logWarning("Could not prepare the agent-device launcher", { cause }).pipe(
          Effect.as(undefined),
        ),
      ),
    );
    if (!shimDir) return undefined;
    return {
      PATH: shimDir,
      PATH_SEPARATOR: platform === "win32" ? ";" : ":",
      AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1",
    } satisfies AgentDeviceEnvironment;
  });
});

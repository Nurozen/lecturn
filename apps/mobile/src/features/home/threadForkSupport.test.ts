import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerProvider,
} from "@lecturn/contracts";
import { describe, expect, it } from "vite-plus/test";
import { Atom, AtomRegistry } from "effect/reactivity";

import { createThreadForkSupportAtom, threadForkSupported } from "./threadForkSupport";

const ENV = EnvironmentId.make("env");
const CODEX = ProviderInstanceId.make("codex");
const CURSOR = ProviderInstanceId.make("cursor");

function provider(instanceId: ProviderInstanceId, conversationFork?: string): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make(String(instanceId)),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...(conversationFork ? { conversationFork } : {}),
  } as ServerProvider;
}

function config(input: {
  readonly threadForking: boolean;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly checkedAt?: string;
}): ServerConfig {
  return {
    providers: input.providers.map((entry) => ({
      ...entry,
      checkedAt: input.checkedAt ?? entry.checkedAt,
    })),
    environment: { capabilities: { threadForking: input.threadForking } },
    settings: {},
  } as unknown as ServerConfig;
}

describe("thread fork support", () => {
  it("follows the server capability for every provider (V2 portable fork)", () => {
    const registry = AtomRegistry.make();
    const configs = Atom.make<ReadonlyMap<EnvironmentId, ServerConfig>>(
      new Map([
        [
          ENV,
          config({
            threadForking: true,
            providers: [provider(CODEX, "native"), provider(CURSOR, "unsupported")],
          }),
        ],
      ]),
    );
    const support = registry.get(createThreadForkSupportAtom(configs));
    expect(threadForkSupported(support, { environmentId: ENV })).toBe(true);

    registry.set(
      configs,
      new Map([[ENV, config({ threadForking: false, providers: [provider(CODEX, "native")] })]]),
    );
    const disabled = registry.get(createThreadForkSupportAtom(configs));
    expect(threadForkSupported(disabled, { environmentId: ENV })).toBe(false);
  });

  it("keeps its identity across provider freshness updates", () => {
    const registry = AtomRegistry.make();
    const configs = Atom.make<ReadonlyMap<EnvironmentId, ServerConfig>>(
      new Map([[ENV, config({ threadForking: true, providers: [provider(CODEX, "native")] })]]),
    );
    const atom = createThreadForkSupportAtom(configs);
    const initial = registry.get(atom);
    registry.set(
      configs,
      new Map([
        [
          ENV,
          config({
            threadForking: true,
            providers: [provider(CODEX, "native")],
            checkedAt: "2026-09-02T00:00:00.000Z",
          }),
        ],
      ]),
    );
    expect(registry.get(atom)).toBe(initial);
  });
});

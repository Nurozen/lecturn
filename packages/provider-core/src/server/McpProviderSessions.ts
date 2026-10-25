import type { ProviderDriverKind, ProviderThreadId, ThreadId } from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { McpProviderSessionConfig } from "./mcpSession.ts";

/**
 * Lecturn: whether a provider thread actually got Lecturn's MCP server.
 *
 * MCP configuration is installed per provider thread (Codex passes it in
 * `thread/start` and resume, a reused session attaches a new thread without
 * reopening), and a missing config is not proof of absence (an external
 * OpenCode server is handed a config it never installs). So each adapter
 * reports what it did for the thread it just loaded, and a failure that only
 * surfaces later (Codex's MCP startup status) arrives as its own signal.
 */
export type McpActivationSignal =
  | {
      readonly type: "mcp-activated";
      readonly threadId: ThreadId;
      readonly providerThreadId: ProviderThreadId;
      readonly driver: ProviderDriverKind;
      readonly mcpActivated: boolean;
    }
  | {
      readonly type: "mcp-activation-failed";
      readonly threadId: ThreadId;
      readonly providerThreadId: ProviderThreadId;
      readonly driver: ProviderDriverKind;
      readonly reason: string;
    };

export class McpProviderSessions extends Context.Service<
  McpProviderSessions,
  {
    readonly set: (config: McpProviderSessionConfig) => Effect.Effect<void>;
    readonly read: (threadId: ThreadId) => Effect.Effect<McpProviderSessionConfig | undefined>;
    readonly clear: (threadId: ThreadId) => Effect.Effect<void>;
    /** Signals with no subscriber are dropped; nothing is retained. */
    readonly reportActivation: (signal: McpActivationSignal) => Effect.Effect<void>;
    /** Subscribed when this runs, so a signal reported after it is never missed. */
    readonly subscribeActivations: Effect.Effect<
      Stream.Stream<McpActivationSignal>,
      never,
      Scope.Scope
    >;
  }
>()("@lecturn/provider-core/server/McpProviderSessions") {}

const make = Effect.gen(function* () {
  const sessions = yield* Ref.make(new Map<ThreadId, McpProviderSessionConfig>());
  const activations = yield* PubSub.unbounded<McpActivationSignal>();
  return McpProviderSessions.of({
    set: (config) =>
      Ref.update(sessions, (current) => new Map(current).set(config.threadId, config)),
    read: (threadId) => Ref.get(sessions).pipe(Effect.map((current) => current.get(threadId))),
    clear: (threadId) =>
      Ref.update(sessions, (current) => {
        const next = new Map(current);
        next.delete(threadId);
        return next;
      }),
    reportActivation: (signal) => PubSub.publish(activations, signal).pipe(Effect.asVoid),
    subscribeActivations: PubSub.subscribe(activations).pipe(Effect.map(Stream.fromSubscription)),
  });
});

export const layer = Layer.effect(McpProviderSessions, make);

/** What an adapter reports after loading a provider thread. */
export const reportThreadMcpActivation = (input: {
  readonly mcpSessions: McpProviderSessions["Service"];
  readonly threadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
  readonly driver: ProviderDriverKind;
  readonly mcpActivated: boolean;
}) =>
  input.mcpSessions.reportActivation({
    type: "mcp-activated",
    threadId: input.threadId,
    providerThreadId: input.providerThreadId,
    driver: input.driver,
    mcpActivated: input.mcpActivated,
  });

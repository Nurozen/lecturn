/**
 * `squireFake` (D44e): the scripted provider plus a per-thread script registry.
 * The fixture route writes a Squire home thread's scripts keyed by event kind;
 * each turn on that thread runs the script for the kind it was woken by.
 *
 * Test-only. The server provides `layerServer`, which is empty unless
 * `LECTURN_TEST_PROVIDERS=1` and the Squire switch are both on (D44g), in the
 * context the provider registry builds instances in: the scripted adapter
 * resolves `ScriptedScriptSource` once, when the instance is made.
 *
 * @module squire/SquireFakeScripts
 */
import type { ThreadId } from "@lecturn/contracts";
import type { ProviderAdapterV2TurnMessage } from "@lecturn/provider-core/server/ProviderAdapter";
import * as HostProcess from "@lecturn/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ServerConfig from "../config.ts";
import { ScriptedScriptSource } from "../orchestration-v2/Adapters/ScriptedAdapterV2.ts";
import type { ScriptedScript } from "../orchestration-v2/Adapters/scriptedScript.ts";

/** A typed message on the home thread, as opposed to a delivered Squire event batch. */
export const USER_MESSAGE_KIND = "user-message";
/** The script for any turn no other entry matches. */
export const ANY_KIND = "*";

/** Scripts by event kind: a Squire event kind (`onboarding`, ...), `user-message`, or `*`. */
export type SquireFakeScriptSet = Readonly<Record<string, ScriptedScript>>;

/**
 * Finishes the picked script when its turn starts, e.g. filling templates
 * from the batch that woke the turn. `kind` is the entry that matched.
 */
export type SquireFakeFill = (input: {
  readonly kind: string;
  readonly script: ScriptedScript;
  readonly message: ProviderAdapterV2TurnMessage;
}) => Effect.Effect<ScriptedScript>;

/**
 * The kinds a turn was woken by, in delivery order. A Squire delivery carries
 * them on its notification source; a message the user typed is `user-message`;
 * anything else (an agent's message, a server answer) matches only `*`.
 */
export function squireFakeEventKinds(message: ProviderAdapterV2TurnMessage): ReadonlyArray<string> {
  const source = message.notification?.source;
  if (source?.kind === "squire") return source.eventKinds ?? [];
  return message.createdBy === "user" ? [USER_MESSAGE_KIND] : [];
}

/** The entry a batch runs: the first kind in it with a script, else `*` when there is one. */
export function pickSquireFakeKind(
  scripts: SquireFakeScriptSet,
  kinds: ReadonlyArray<string>,
): string | undefined {
  const kind = kinds.find((candidate) => Object.hasOwn(scripts, candidate));
  if (kind !== undefined) return kind;
  return Object.hasOwn(scripts, ANY_KIND) ? ANY_KIND : undefined;
}

export function pickSquireFakeScript(
  scripts: SquireFakeScriptSet,
  kinds: ReadonlyArray<string>,
): ScriptedScript | undefined {
  const kind = pickSquireFakeKind(scripts, kinds);
  return kind === undefined ? undefined : scripts[kind];
}

export class SquireFakeScripts extends Context.Service<
  SquireFakeScripts,
  {
    /** Replaces the thread's scripts; `fill` runs on the picked script at each turn start. */
    readonly set: (
      threadId: ThreadId,
      scripts: SquireFakeScriptSet,
      fill?: SquireFakeFill,
    ) => Effect.Effect<void>;
    /** Forgets one thread's scripts, or every thread's. */
    readonly clear: (threadId?: ThreadId) => Effect.Effect<void>;
    /** Undefined when the thread has no scripts or none matches, so the adapter falls through. */
    readonly scriptFor: (
      threadId: ThreadId,
      message: ProviderAdapterV2TurnMessage,
    ) => Effect.Effect<ScriptedScript | undefined>;
  }
>()("lecturn/squire/SquireFakeScripts") {}

interface Entry {
  readonly scripts: SquireFakeScriptSet;
  readonly fillScript: SquireFakeFill | undefined;
}

const make = Effect.gen(function* () {
  const byThread = yield* Ref.make(new Map<ThreadId, Entry>());
  return SquireFakeScripts.of({
    set: (threadId, scripts, fill) =>
      Ref.update(byThread, (current) =>
        new Map(current).set(threadId, { scripts, fillScript: fill }),
      ),
    clear: (threadId) =>
      Ref.update(byThread, (current) => {
        if (threadId === undefined) return new Map();
        const next = new Map(current);
        next.delete(threadId);
        return next;
      }),
    scriptFor: (threadId, message) =>
      Effect.gen(function* () {
        const entry = (yield* Ref.get(byThread)).get(threadId);
        if (entry === undefined) return undefined;
        const kind = pickSquireFakeKind(entry.scripts, squireFakeEventKinds(message));
        if (kind === undefined) return undefined;
        const script = entry.scripts[kind]!;
        return entry.fillScript === undefined
          ? script
          : yield* entry.fillScript({ kind, script, message });
      }),
  });
});

const layerScriptSource = Layer.effect(
  ScriptedScriptSource,
  Effect.gen(function* () {
    const fakes = yield* SquireFakeScripts;
    return ScriptedScriptSource.of({
      scriptFor: (input) => fakes.scriptFor(input.threadId, input.message),
    });
  }),
);

/** The registry and the scripted adapter's script source over it. */
export const layer = layerScriptSource.pipe(
  Layer.provideMerge(Layer.effect(SquireFakeScripts, make)),
);

/**
 * D44g: `layer` with both gates on, else nothing. Promises no service, so
 * the scripted adapter and the fixture seam reach it with `serviceOption`.
 */
export const layerServer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const environment = yield* HostProcess.Environment;
    const on: Layer.Layer<never> = layer;
    return config.squireEnabled && environment.LECTURN_TEST_PROVIDERS === "1" ? on : Layer.empty;
  }),
);

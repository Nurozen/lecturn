import type { AtomCommand } from "@lecturn/client-runtime/state/runtime";
import type { RuntimeMode } from "@lecturn/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";
import { requireAndroidFullAccess } from "../lib/androidHostAccess";

/** Shared web command boundary covers composer, quick steer and project/new sends. */
export function withAndroidAccess<
  W extends { input: { threadId: string; runtimeMode?: RuntimeMode } },
  A,
  E,
>(
  command: AtomCommand<W, A, E>,
  runtimeMode: (registry: AtomRegistry.AtomRegistry, value: W) => RuntimeMode | undefined = (
    _registry,
    value,
  ) => value.input.runtimeMode,
): AtomCommand<W, A, E> {
  return withAndroidAccessFor(command, (value) => value.input.threadId, runtimeMode);
}

/** Same boundary for commands whose thread id is not `input.threadId` (V2 thread.fork). */
export function withAndroidAccessFor<W, A, E>(
  command: AtomCommand<W, A, E>,
  threadId: (value: W) => string,
  runtimeMode: (registry: AtomRegistry.AtomRegistry, value: W) => RuntimeMode | undefined,
): AtomCommand<W, A, E> {
  return {
    ...command,
    async run(registry, value) {
      try {
        await requireAndroidFullAccess(threadId(value), runtimeMode(registry, value));
      } catch (error) {
        return AsyncResult.failure(Cause.die(error));
      }
      return command.run(registry, value);
    },
  };
}

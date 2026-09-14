import { localThreadActivityIntents } from "./localThreadActivityIntent";
import { RegistryContext } from "@effect/atom-react";
import {
  type AtomCommand,
  type AtomCommandOptions,
  type AtomCommandResult,
  runAtomCommand,
} from "@lecturn/client-runtime/state/runtime";
import { useCallback, useContext } from "react";

export function useAtomCommand<A, E, W>(
  command: AtomCommand<W, A, E>,
  options?: string | AtomCommandOptions,
): (value: W) => Promise<AtomCommandResult<A, E>> {
  const registry = useContext(RegistryContext);
  const label = typeof options === "string" ? options : (options?.label ?? command.label);
  const reportFailure = typeof options === "string" ? true : (options?.reportFailure ?? true);
  const reportDefect = typeof options === "string" ? true : (options?.reportDefect ?? true);

  return useCallback(
    async (value: W) => {
      const intent = localThreadActivityIntents.begin(command.label, value);
      try {
        const result = await runAtomCommand(registry, command, value, {
          label,
          reportFailure,
          reportDefect,
        });
        if (result._tag === "Failure") localThreadActivityIntents.cancel(intent);
        return result;
      } catch (error) {
        localThreadActivityIntents.cancel(intent);
        throw error;
      }
    },
    [command, label, registry, reportDefect, reportFailure],
  );
}

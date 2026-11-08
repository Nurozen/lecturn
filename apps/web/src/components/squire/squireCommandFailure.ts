import { squashAtomCommandFailure } from "@lecturn/client-runtime/state/runtime";

export function commandFailureMessage(
  result: Parameters<typeof squashAtomCommandFailure>[0],
  fallback: string,
) {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim() !== "" ? error.message : fallback;
}

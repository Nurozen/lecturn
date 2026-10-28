import { createContextualEnvironmentAtoms } from "@lecturn/client-runtime/state/contextual";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthRelayWriteScope,
  type EnvironmentId,
} from "@lecturn/contracts";
import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentSessionState } from "./session";
import { usePrimaryEnvironmentId } from "./environments";
import { useServerConfigs } from "./entities";
import { isElectron } from "../env";
import { isEmbedLocation } from "../embed/embedAuth";
export const contextualEnvironment = createContextualEnvironmentAtoms(connectionAtomRuntime, {
  followChanges: !isEmbedLocation(),
});
/** An embedded chat shows its thread's Contextual state but cannot change it. */
const EMBED_CONTEXTUAL_ACCESS = { operate: false, administer: false, funding: false } as const;
export function useContextualAccess(environmentId: EnvironmentId | null) {
  const primaryId = usePrimaryEnvironmentId();
  const session = useEnvironmentSessionState(environmentId);
  const local = environmentId !== null && isElectron && primaryId === environmentId;
  const allows = (scope: string) =>
    local ||
    (session.data?.authenticated === true &&
      session.data.scopes?.some((value) => value === scope) === true);
  if (isEmbedLocation()) return EMBED_CONTEXTUAL_ACCESS;
  return {
    operate: allows(AuthOrchestrationOperateScope),
    administer: allows(AuthAccessWriteScope),
    funding: allows(AuthRelayWriteScope),
  };
}

export function useContextualAvailable(environmentId: EnvironmentId | null) {
  const configs = useServerConfigs();
  const capabilities =
    environmentId === null ? undefined : configs.get(environmentId)?.environment.capabilities;
  return (
    capabilities !== undefined && "contextual" in capabilities && capabilities.contextual === true
  );
}

export function contextualErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The Contextual request could not be completed. Try again.";
}

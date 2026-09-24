import { createThreadDecisionEnvironmentAtoms } from "@lecturn/client-runtime/state/threadDecisions";
import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentSessionState } from "./session";
import { usePrimaryEnvironmentId } from "./environments";
import { isElectron } from "../env";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@lecturn/contracts";

export const threadDecisionEnvironment =
  createThreadDecisionEnvironmentAtoms(connectionAtomRuntime);
export function useDecisionOperateAccess(environmentId: EnvironmentId) {
  const primaryId = usePrimaryEnvironmentId();
  const session = useEnvironmentSessionState(environmentId);
  return (
    (isElectron && primaryId === environmentId) ||
    (session.data?.authenticated === true &&
      session.data.scopes?.includes(AuthOrchestrationOperateScope) === true)
  );
}

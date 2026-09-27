import type { EnvironmentId } from "@lecturn/contracts";
import { useContextualAvailable } from "../state/contextual";
import { LegacyDecisionsFunding } from "./LegacyDecisionsFunding";
import { ExtensionsFunding } from "./ExtensionsFunding";

export function DecisionsFunding(props: { environmentId: EnvironmentId; onChange: () => void }) {
  const sharedFunding = useContextualAvailable(props.environmentId);
  if (!sharedFunding) return <LegacyDecisionsFunding {...props} />;
  return <ExtensionsFunding {...props} featureId="decisions" />;
}

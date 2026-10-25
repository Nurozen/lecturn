import type { EnvironmentId } from "@lecturn/contracts";
import { lazy, Suspense } from "react";
import { useContextualAvailable } from "../state/contextual";

// Funding links a Lecturn Connect account, so it stays out of the chat view's static graph,
// which /embed loads (scripts/check-embed-chunks.ts). Render these under a Suspense boundary.
const LegacyDecisionsFunding = lazy(() =>
  import("./LegacyDecisionsFunding").then((module) => ({
    default: module.LegacyDecisionsFunding,
  })),
);
export const LazyExtensionsFunding = lazy(() =>
  import("./ExtensionsFunding").then((module) => ({ default: module.ExtensionsFunding })),
);

export function DecisionsFunding(props: { environmentId: EnvironmentId; onChange: () => void }) {
  const sharedFunding = useContextualAvailable(props.environmentId);
  return (
    <Suspense fallback={null}>
      {sharedFunding ? (
        <LazyExtensionsFunding {...props} featureId="decisions" />
      ) : (
        <LegacyDecisionsFunding {...props} />
      )}
    </Suspense>
  );
}

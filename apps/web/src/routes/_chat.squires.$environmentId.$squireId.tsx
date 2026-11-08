import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId, SquireId } from "@lecturn/contracts";

import { SquirePage } from "../components/squire/SquirePage";

export const Route = createFileRoute("/_chat/squires/$environmentId/$squireId")({
  component: function SquireRoute() {
    const params = Route.useParams();
    return (
      <SquirePage
        key={`${params.environmentId}:${params.squireId}`}
        environmentId={EnvironmentId.make(params.environmentId)}
        squireId={SquireId.make(params.squireId)}
      />
    );
  },
});

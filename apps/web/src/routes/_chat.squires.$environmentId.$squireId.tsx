import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId, SquireId } from "@lecturn/contracts";

import { SquirePage } from "../components/squire/SquirePage";
import { parseSquireViewSearch } from "../components/squire/squireView.logic";

export const Route = createFileRoute("/_chat/squires/$environmentId/$squireId")({
  validateSearch: parseSquireViewSearch,
  component: function SquireRoute() {
    const params = Route.useParams();
    return (
      <SquirePage
        key={`${params.environmentId}:${params.squireId}`}
        environmentId={EnvironmentId.make(params.environmentId)}
        squireId={SquireId.make(params.squireId)}
        search={Route.useSearch()}
      />
    );
  },
});

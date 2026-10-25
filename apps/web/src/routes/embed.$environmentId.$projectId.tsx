import { EnvironmentId, ProjectId } from "@lecturn/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { EmbedShell } from "../embed/EmbedShell";

export const Route = createFileRoute("/embed/$environmentId/$projectId")({
  component: EmbedRouteView,
});

function EmbedRouteView() {
  const params = Route.useParams();
  return (
    <EmbedShell
      environmentId={EnvironmentId.make(params.environmentId)}
      projectId={ProjectId.make(params.projectId)}
    />
  );
}

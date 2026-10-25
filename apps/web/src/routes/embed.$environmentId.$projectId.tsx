import { EnvironmentId, ProjectId, ThreadId } from "@lecturn/contracts";
import { createFileRoute, useParams } from "@tanstack/react-router";

import { EmbedShell } from "../embed/EmbedShell";

export const Route = createFileRoute("/embed/$environmentId/$projectId")({
  component: EmbedRouteView,
});

function EmbedRouteView() {
  const params = Route.useParams();
  const { threadId } = useParams({ strict: false });
  return (
    <EmbedShell
      environmentId={EnvironmentId.make(params.environmentId)}
      projectId={ProjectId.make(params.projectId)}
      threadId={threadId ? ThreadId.make(threadId) : null}
    />
  );
}

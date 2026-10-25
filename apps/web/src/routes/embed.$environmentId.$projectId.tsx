import { EnvironmentId, ProjectId, ThreadId } from "@lecturn/contracts";
import { createFileRoute, useMatch, useParams } from "@tanstack/react-router";

import { EmbedShell } from "../embed/EmbedShell";

export const Route = createFileRoute("/embed/$environmentId/$projectId")({
  component: EmbedRouteView,
});

function EmbedRouteView() {
  const params = Route.useParams();
  const { threadId } = useParams({ strict: false });
  const providers = useMatch({
    from: "/embed/$environmentId/$projectId/providers",
    shouldThrow: false,
  });
  return (
    <EmbedShell
      environmentId={EnvironmentId.make(params.environmentId)}
      projectId={ProjectId.make(params.projectId)}
      threadId={threadId ? ThreadId.make(threadId) : null}
      panel={providers ? "providers" : null}
    />
  );
}

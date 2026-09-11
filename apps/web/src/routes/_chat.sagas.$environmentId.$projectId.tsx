import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { SagaWorkbenchPage } from "../components/stave/SagaWorkbenchPage";
import { parseSagaWorkbenchSearch } from "../components/stave/sagaWorkbench.logic";

export const Route = createFileRoute("/_chat/sagas/$environmentId/$projectId")({
  validateSearch: parseSagaWorkbenchSearch,
  component: function SagaRoute() {
    const params = Route.useParams();
    return (
      <SagaWorkbenchPage
        key={`${params.environmentId}:${params.projectId}`}
        environmentId={EnvironmentId.make(params.environmentId)}
        projectId={ProjectId.make(params.projectId)}
        search={Route.useSearch()}
      />
    );
  },
});

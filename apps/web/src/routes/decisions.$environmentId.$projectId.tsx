import { createFileRoute, redirect } from "@tanstack/react-router";
import { EnvironmentId, ProjectId } from "@lecturn/contracts";
import { DecisionsPanel } from "../components/DecisionsPanel";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { AccountSurface } from "../components/AccountSurface";
import { useProject } from "../state/entities";
import { scopeProjectRef } from "@lecturn/client-runtime/environment";
import { isElectron } from "../env";
export const Route = createFileRoute("/decisions/$environmentId/$projectId")({
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    )
      throw redirect({ to: "/pair", replace: true });
  },
  component: ProjectDecisionsPage,
});
function ProjectDecisionsPage() {
  const params = Route.useParams();
  const environmentId = EnvironmentId.make(params.environmentId),
    projectId = ProjectId.make(params.projectId);
  const project = useProject(scopeProjectRef(environmentId, projectId));
  return (
    <SidebarInset>
      <AccountSurface environmentId={environmentId} className="flex min-h-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron}>
          <SidebarTrigger />
          <h1 className="truncate text-sm font-medium">{project?.title ?? "Project"} decisions</h1>
        </WorkspacePageHeader>
        <DecisionsPanel environmentId={environmentId} projectId={projectId} />
      </AccountSurface>
    </SidebarInset>
  );
}

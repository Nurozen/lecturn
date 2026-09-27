import { createFileRoute, redirect } from "@tanstack/react-router";
import { EnvironmentId } from "@lecturn/contracts";
import { ContextualHostSettings } from "../components/contextual/ContextualHostSettings";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { AccountSurface } from "../components/AccountSurface";
import { isElectron } from "../env";
export const Route = createFileRoute("/contextual/$environmentId")({
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    )
      throw redirect({ to: "/pair", replace: true });
  },
  component: ContextualSettingsPage,
});
function ContextualSettingsPage() {
  const params = Route.useParams();
  const environmentId = EnvironmentId.make(params.environmentId);
  return (
    <SidebarInset>
      <AccountSurface environmentId={environmentId} className="flex min-h-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron}>
          <SidebarTrigger />
          <h1 className="truncate text-sm font-medium">Contextual sources</h1>
        </WorkspacePageHeader>
        <div className="overflow-auto p-4 sm:p-6">
          <div className="mx-auto max-w-3xl">
            <ContextualHostSettings environmentId={environmentId} />
          </div>
        </div>
      </AccountSurface>
    </SidebarInset>
  );
}

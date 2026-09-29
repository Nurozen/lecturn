import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { FactoryIcon } from "lucide-react";
import { useCallback } from "react";

import { FactoryView } from "../components/factory/FactoryView";
import { useProviderFactory } from "../components/factory/useProviderFactory";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";

interface FactorySearch {
  environmentId?: string;
  threadId?: string;
}

export const Route = createFileRoute("/_chat/factory")({
  validateSearch: (search: Record<string, unknown>): FactorySearch =>
    typeof search.environmentId === "string" &&
    search.environmentId.trim().length > 0 &&
    typeof search.threadId === "string" &&
    search.threadId.trim().length > 0
      ? { environmentId: search.environmentId, threadId: search.threadId }
      : {},
  component: FactoryPage,
});

function FactoryPage() {
  const selection = Route.useSearch();
  const navigate = useNavigate();
  const onSelectionChange = useCallback(
    (search: FactorySearch) => {
      void navigate({ to: "/factory", search });
    },
    [navigate],
  );
  const props = useProviderFactory({ selection, onSelectionChange });

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <WorkspacePageHeader electron={isElectron} className="border-b border-border/50">
        <FactoryIcon className="size-4 text-primary" />
        <span className="text-sm font-medium">Factory</span>
        <span className="ml-auto rounded-full border border-primary/25 bg-primary/5 px-2.5 py-0.5 text-[10px] font-medium tracking-widest text-primary uppercase">
          Provider updates
        </span>
      </WorkspacePageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <FactoryView {...props} />
      </div>
    </SidebarInset>
  );
}

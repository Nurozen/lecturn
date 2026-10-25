import { scopeProjectRef } from "@lecturn/client-runtime/environment";
import type { EnvironmentId, ProjectId } from "@lecturn/contracts";

import ChatView from "../components/ChatView";
import { AnchoredToastProvider, ToastProvider } from "../components/ui/toast";
import { useThreadShellsForProjectRefs } from "../state/entities";
import { EmbedPresentationContext } from "./EmbedPresentationContext";

/**
 * The embed's whole chrome. It must not import the app shell (sidebar, command palette,
 * settings navigation); scripts/check-embed-chunks.ts fails the build when it does.
 */
export function EmbedShell({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const presentation = { projectRef: scopeProjectRef(environmentId, projectId) };
  const projectRefs = [presentation.projectRef];
  const threads = useThreadShellsForProjectRefs(projectRefs);
  // Until the embed has its own thread route, show the project's most recent live thread.
  const latestThread = threads
    .filter((thread) => thread.archivedAt === null && thread.deletedAt === null)
    .reduce<(typeof threads)[number] | null>(
      (latest, thread) =>
        latest === null || thread.updatedAt > latest.updatedAt ? thread : latest,
      null,
    );

  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <EmbedPresentationContext value={presentation}>
          <main className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background">
            {latestThread ? (
              <ChatView
                environmentId={latestThread.environmentId}
                threadId={latestThread.id}
                routeKind="server"
              />
            ) : (
              <p className="m-auto text-sm text-muted-foreground">
                No threads in this project yet.
              </p>
            )}
          </main>
        </EmbedPresentationContext>
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

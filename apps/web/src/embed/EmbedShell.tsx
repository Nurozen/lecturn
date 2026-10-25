import { deriveEmbedTurnState } from "@lecturn/client-runtime/embed/guest";
import { scopeProjectRef, scopeThreadRef } from "@lecturn/client-runtime/environment";
import type { EnvironmentId, ProjectId, ThreadId } from "@lecturn/contracts";
import { useEffect } from "react";

import ChatView from "../components/ChatView";
import { AnchoredToastProvider, ToastProvider } from "../components/ui/toast";
import {
  useQuietThreadShell,
  useThreadProjection,
  useThreadShellsForProjectRefs,
} from "../state/entities";
import { startEmbedBridge } from "./bridge";
import { EmbedPresentationContext } from "./EmbedPresentationContext";

/**
 * Tells the host what the pane shows. A leaf of its own, because the thread detail it reads
 * changes on every streamed event and must not re-render the ChatView beside it.
 */
function EmbedThreadReporter({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
}) {
  const threadRef = threadId === null ? null : scopeThreadRef(environmentId, threadId);
  const shell = useQuietThreadShell(threadRef);
  const projection = useThreadProjection(threadRef)?.projection ?? null;
  const state = threadId === null ? null : deriveEmbedTurnState({ projection, shell });
  useEffect(() => {
    const bridge = startEmbedBridge();
    bridge?.reportThread(threadId);
    if (threadId !== null && state !== null) bridge?.reportTurnState(threadId, state);
  }, [threadId, state]);
  return null;
}

/**
 * The embed's whole chrome. It must not import the app shell (sidebar, command palette,
 * settings navigation); scripts/check-embed-chunks.ts fails the build when it does.
 */
export function EmbedShell({
  environmentId,
  projectId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId | null;
}) {
  const presentation = { projectRef: scopeProjectRef(environmentId, projectId) };
  const projectRefs = [presentation.projectRef];
  const threads = useThreadShellsForProjectRefs(projectRefs);
  // A host may open the project without naming a thread, and the embed has no draft composer to
  // fall back to, so it shows the project's most recent live thread.
  const latestThread =
    threadId === null
      ? threads
          .filter((thread) => thread.archivedAt === null && thread.deletedAt === null)
          .reduce<(typeof threads)[number] | null>(
            (latest, thread) =>
              latest === null || thread.updatedAt > latest.updatedAt ? thread : latest,
            null,
          )
      : null;
  const shownThreadId = threadId ?? latestThread?.id ?? null;

  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <EmbedPresentationContext value={presentation}>
          <EmbedThreadReporter environmentId={environmentId} threadId={shownThreadId} />
          <main className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background">
            {shownThreadId !== null ? (
              <ChatView environmentId={environmentId} threadId={shownThreadId} routeKind="server" />
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

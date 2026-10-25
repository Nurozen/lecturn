import { scopeProjectRef } from "@lecturn/client-runtime/environment";
import type { EnvironmentId, ProjectId, ThreadId } from "@lecturn/contracts";

import { EmbedView } from "../components/embed/EmbedView";
import { AnchoredToastProvider, ToastProvider } from "../components/ui/toast";
import { readEmbedSwitcherVisible } from "./embedAuth";
import { EmbedPresentationContext } from "./EmbedPresentationContext";

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
  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <EmbedPresentationContext value={presentation}>
          <EmbedView
            environmentId={environmentId}
            projectId={projectId}
            threadId={threadId}
            switcher={readEmbedSwitcherVisible()}
          />
        </EmbedPresentationContext>
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

import { scopeProjectRef } from "@lecturn/client-runtime/environment";
import type { ScopedThreadRef } from "@lecturn/contracts";

import { useEmbedPresentation } from "../../embed/EmbedPresentationContext";
import { useProject, useQuietThreadShell } from "../../state/entities";

/**
 * App threads open on their title, set like the new-thread headline. The embed leaves it out
 * because the host app already names the thread around its pane.
 */
export function AppThreadTitle({ threadRef }: { readonly threadRef: ScopedThreadRef | null }) {
  const embedded = useEmbedPresentation() !== null;
  const shell = useQuietThreadShell(embedded ? null : threadRef);
  const project = useProject(
    shell === null ? null : scopeProjectRef(shell.environmentId, shell.projectId),
  );
  if (shell === null || !project?.appBinding) return null;
  return (
    <div className="messages-timeline-row-frame">
      <div className="chat-content-lane pb-2">
        <h1 className="font-display font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
          {shell.title}
        </h1>
      </div>
    </div>
  );
}

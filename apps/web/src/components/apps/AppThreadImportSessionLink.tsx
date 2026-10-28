import type { ScopedProjectRef } from "@lecturn/contracts";

import { useEmbedPresentation } from "../../embed/EmbedPresentationContext";
import { useProject } from "../../state/entities";
import { DraftImportSessionLink } from "../chat/DraftImportSessionLink";

/**
 * App threads keep the new-thread screen's import link under the composer. The composer stack
 * ends at the pane's edge, so the link sits in the stack's bottom gutter, stacked over it so the
 * gutter does not take its clicks. The embed has no command palette to open.
 */
export function AppThreadImportSessionLink({
  projectRef,
}: {
  readonly projectRef: ScopedProjectRef | null;
}) {
  const embedded = useEmbedPresentation() !== null;
  const project = useProject(embedded ? null : projectRef);
  if (projectRef === null || !project?.appBinding) return null;
  return (
    <div className="absolute inset-x-0 bottom-[env(safe-area-inset-bottom)] z-10 flex h-4 items-center justify-center sm:h-5">
      <DraftImportSessionLink projectRef={projectRef} />
    </div>
  );
}

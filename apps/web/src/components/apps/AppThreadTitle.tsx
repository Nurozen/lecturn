import { scopeProjectRef } from "@lecturn/client-runtime/environment";
import type { ScopedThreadRef } from "@lecturn/contracts";
import type { ReactNode } from "react";

import { useEmbedPresentation } from "../../embed/EmbedPresentationContext";
import { useProject, useQuietThreadShell } from "../../state/entities";

/**
 * App threads open on their title, set like the new-thread headline. The embed leaves it out
 * because the host app already names the thread around its pane.
 */
function useAppThreadTitle(threadRef: ScopedThreadRef | null): string | null {
  const embedded = useEmbedPresentation() !== null;
  const shell = useQuietThreadShell(embedded ? null : threadRef);
  const project = useProject(
    shell === null ? null : scopeProjectRef(shell.environmentId, shell.projectId),
  );
  return shell === null || !project?.appBinding ? null : shell.title;
}

function AppThreadTitleHeading({ title }: { readonly title: string }) {
  return (
    <h1
      data-testid="app-thread-title"
      className="font-display font-normal text-2xl text-foreground tracking-tight sm:text-3xl"
    >
      {title}
    </h1>
  );
}

/** The title above the timeline, for threads whose first loaded row is not their opening message. */
export function AppThreadTitle({
  threadRef,
  beside,
}: {
  readonly threadRef: ScopedThreadRef | null;
  readonly beside: boolean;
}) {
  const title = useAppThreadTitle(beside ? null : threadRef);
  if (title === null) return null;
  return (
    <div className="messages-timeline-row-frame">
      <div className="chat-content-lane pb-2">
        <AppThreadTitleHeading title={title} />
      </div>
    </div>
  );
}

/**
 * Sets the title level with the opening message, title on the left and the message on the right,
 * as the app mockups draw it. A phone's lane is too narrow for both, so there they stack. Every
 * other row, and every row of a thread that is not an app's, renders as it would without this.
 */
export function AppThreadTitleBeside({
  threadRef,
  shown,
  children,
}: {
  readonly threadRef: ScopedThreadRef | null;
  readonly shown: boolean;
  readonly children: ReactNode;
}) {
  return shown ? <TitleBeside threadRef={threadRef}>{children}</TitleBeside> : children;
}

function TitleBeside({
  threadRef,
  children,
}: {
  readonly threadRef: ScopedThreadRef | null;
  readonly children: ReactNode;
}) {
  const title = useAppThreadTitle(threadRef);
  if (title === null) return children;
  return (
    <div
      data-testid="app-thread-opening"
      className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-6"
    >
      {/* Find matches map to the message row, so the title must not read as the message's text.
          The top inset centers the heading's line on the message bubble's first line. */}
      <div data-thread-find-ignore className="min-w-0 sm:max-w-[50%] sm:shrink-0 sm:pt-1">
        <AppThreadTitleHeading title={title} />
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

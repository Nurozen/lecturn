import { scopeProjectRef } from "@lecturn/client-runtime/environment";
import type { EnvironmentId, ProjectId, ThreadId } from "@lecturn/contracts";
import { useEffect } from "react";

import { type EmbedPanel, EmbedView } from "../components/embed/EmbedView";
import { AnchoredToastProvider, ToastProvider } from "../components/ui/toast";
import { startEmbedBridge } from "./bridge";
import { readEmbedSwitcherVisible } from "./embedAuth";
import { EmbedPresentationContext } from "./EmbedPresentationContext";
import { installEmbedTheme } from "./embedTheme";
import "./embed.css";

/**
 * The embed's whole chrome. It must not import the app shell (sidebar, command palette,
 * settings navigation); scripts/check-embed-chunks.ts fails the build when it does.
 */
export function EmbedShell({
  environmentId,
  projectId,
  threadId,
  panel,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId | null;
  readonly panel: EmbedPanel | null;
}) {
  const presentation = { projectRef: scopeProjectRef(environmentId, projectId) };
  useEffect(() => installEmbedTheme(startEmbedBridge()), []);
  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <EmbedPresentationContext value={presentation}>
          <EmbedView
            environmentId={environmentId}
            projectId={projectId}
            threadId={threadId}
            panel={panel}
            switcher={readEmbedSwitcherVisible()}
          />
        </EmbedPresentationContext>
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

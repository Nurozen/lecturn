import { scopeProjectRef } from "@lecturn/client-runtime/environment";
import type { ScopedThreadRef } from "@lecturn/contracts";
import { ExternalLinkIcon } from "lucide-react";

import { useEmbedPresentation } from "../../embed/EmbedPresentationContext";
import { useQuietThreadShell } from "../../state/entities";
import { Button } from "../ui/button";
import { appClosedBannerPlacement, useAppClosedBannerState } from "./useAppClosedBanner";

/** The closed-app notice heading an app thread in full Lecturn; the embed shows it by the composer. */
export function AppClosedThreadBanner({
  threadRef,
}: {
  readonly threadRef: ScopedThreadRef | null;
}) {
  const embedded = useEmbedPresentation() !== null;
  const placement = appClosedBannerPlacement({ embedded, threadId: threadRef?.threadId ?? null });
  const shell = useQuietThreadShell(placement === "thread" ? threadRef : null);
  const state = useAppClosedBannerState(
    shell === null ? null : scopeProjectRef(shell.environmentId, shell.projectId),
    shell?.id ?? null,
  );
  if (state === null) return null;
  const { banner, open } = state;
  return (
    <div className="messages-timeline-row-frame">
      <div className="chat-content-lane pb-5">
        <div
          role="status"
          data-testid="app-closed-banner"
          className="flex min-h-10 flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 rounded-xl border border-border bg-card/60 px-4 py-2 text-center text-foreground text-sm"
        >
          <span>{banner.title}</span>
          {open === null ? null : (
            <>
              <span aria-hidden className="text-muted-foreground">
                ·
              </span>
              <span data-testid="app-closed-banner-open" className="inline-flex text-thread-gold">
                <Button variant="link" size="xs-flush" onClick={open}>
                  {banner.openLabel}
                  <ExternalLinkIcon aria-hidden />
                </Button>
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

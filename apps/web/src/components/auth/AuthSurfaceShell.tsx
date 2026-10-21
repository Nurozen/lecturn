import type { ReactNode } from "react";

import { APP_DISPLAY_NAME, APP_STAGE_LABEL } from "../../branding";
import { resolveSidebarStageBackdropVariant, StageBackdropArt } from "../SidebarStageBackdrop";
import { StandalonePage } from "../ui/standalone-page";

/**
 * Branded masthead for the CLI-connect authorize and callback pages, and the
 * compact variant used by short confirmation pages.
 */
export function AuthSurfaceShell({
  children,
  compact = false,
}: {
  readonly children: ReactNode;
  readonly compact?: boolean;
}) {
  const stageVariant = resolveSidebarStageBackdropVariant(APP_STAGE_LABEL);

  return (
    <StandalonePage
      tone="brand"
      compact={compact}
      masthead={
        <header
          className={`relative ${compact ? "h-14" : "h-24"} overflow-hidden ${compact ? "bg-background text-foreground" : "bg-[linear-gradient(135deg,#1e61de,#17348e)] text-white"}`}
        >
          {compact ? (
            <div
              aria-hidden
              className="absolute inset-0 bg-[radial-gradient(ellipse_at_80%_0%,color-mix(in_srgb,var(--primary)_16%,transparent),transparent_65%)]"
            />
          ) : stageVariant ? (
            <div className="absolute inset-0" aria-hidden>
              <StageBackdropArt variant={stageVariant} />
            </div>
          ) : (
            <div
              aria-hidden
              className="absolute inset-0 bg-[radial-gradient(circle_at_75%_25%,rgba(136,204,255,0.5),transparent_38%),linear-gradient(135deg,#2468df,#172f82)]"
            />
          )}
          {!compact ? (
            <div className="absolute inset-0 bg-[linear-gradient(to_bottom,transparent_20%,rgba(7,18,55,0.46)_100%)]" />
          ) : null}
          <div className={`relative h-full ${compact ? "px-6 py-4" : "p-5 sm:p-6"}`}>
            <p
              className={`text-3xs font-semibold tracking-widest ${compact ? "text-muted-foreground" : "text-white/80"} uppercase`}
            >
              {APP_DISPLAY_NAME}
            </p>
          </div>
        </header>
      }
    >
      {children}
    </StandalonePage>
  );
}

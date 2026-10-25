import type { ScopedProjectRef } from "@lecturn/contracts";
import { createContext, use } from "react";

/**
 * Present only under /embed. Views that navigate or show Lecturn-wide chrome read it to stay
 * inside the embedded project instead of reaching for routes the embed does not have.
 */
export interface EmbedPresentation {
  readonly projectRef: ScopedProjectRef;
}

export const EmbedPresentationContext = createContext<EmbedPresentation | null>(null);

export function useEmbedPresentation(): EmbedPresentation | null {
  return use(EmbedPresentationContext);
}

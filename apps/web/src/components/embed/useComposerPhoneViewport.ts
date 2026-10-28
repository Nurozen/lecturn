import { useEmbedPresentation } from "../../embed/EmbedPresentationContext";
import { useMediaQuery } from "../../hooks/useMediaQuery";

/**
 * The embed pane is phone-narrow but sits beside a desktop app, so its composer keeps the desktop
 * behavior (always-open footer, no tap-to-expand) and lets EmbedComposerFooter stack it instead.
 */
export function useComposerPhoneViewport(): boolean {
  const narrow = useMediaQuery("max-sm");
  const embedded = useEmbedPresentation() !== null;
  return narrow && !embedded;
}

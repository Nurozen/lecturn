import { XIcon } from "lucide-react";

import { ContextChip, ContextChipAction, ContextChipLabel } from "../ContextChip";
import { useAppReferences } from "./AppReferencesContext";
import { useAppRefLabel } from "./appRefLabels";

function AppRefChipIcon({ src }: { readonly src: string | null | undefined }) {
  if (!src) return null;
  return <img src={src} alt="" aria-hidden="true" className="size-[1.17em] shrink-0 rounded-xs" />;
}

/**
 * An app reference such as `rw:c/fins`. In message text activating it hands the reference to the
 * app (the embed's host, or the app's URL in full Lecturn); a removable chip only names it. A chip
 * given no label shows the app's name for the reference when one is known (`useAppRefLabel`).
 */
export function AppRefChip({
  reference,
  label: givenLabel,
  iconUrl,
  onRemove,
}: {
  readonly reference: string;
  readonly label?: string;
  readonly iconUrl?: string | null;
  readonly onRemove?: () => void;
}) {
  const appReferences = useAppReferences();
  const knownLabel = useAppRefLabel(reference, givenLabel === undefined);
  const label = givenLabel ?? knownLabel;
  // Copying a message keeps the reference the agent reads; the label only names it.
  const named = {
    title: label === reference ? undefined : reference,
    "data-markdown-copy": reference,
  };
  const icon = <AppRefChipIcon src={iconUrl ?? appReferences?.iconUrl} />;
  const activate = appReferences?.activate ?? null;

  if (onRemove !== undefined) {
    return (
      <ContextChip
        kind="app-ref"
        title={reference}
        data-app-ref={reference}
        data-testid="app-ref-chip"
      >
        {icon}
        <ContextChipLabel>{label}</ContextChipLabel>
        <ContextChipAction
          aria-label={`Remove ${label}`}
          data-testid="app-ref-chip-remove"
          onClick={onRemove}
        >
          <XIcon aria-hidden="true" />
        </ContextChipAction>
      </ContextChip>
    );
  }
  if (activate === null) {
    return (
      <ContextChip kind="app-ref" data-app-ref={reference} {...named}>
        {icon}
        <ContextChipLabel>{label}</ContextChipLabel>
      </ContextChip>
    );
  }
  return (
    <ContextChip
      kind="app-ref"
      render={<button type="button" />}
      data-app-ref={reference}
      {...named}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        activate(reference);
      }}
    >
      {icon}
      <ContextChipLabel>{label}</ContextChipLabel>
    </ContextChip>
  );
}

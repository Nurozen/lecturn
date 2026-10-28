import { useEmbedPresentation } from "../../embed/EmbedPresentationContext";
import { AppRefChip } from "./AppRefChip";
import { useAppRefChipStore, useAppRefChips } from "./appRefChipStore";

/**
 * The references the host attached to the next message, above the composer input. They go out
 * with the prompt (see `foldAppRefChips`); only the embed's host can attach them.
 */
export function AppRefChipStrip({ targetKey }: { readonly targetKey: string }) {
  const presentation = useEmbedPresentation();
  const chips = useAppRefChips(targetKey);
  const remove = useAppRefChipStore((state) => state.remove);
  if (presentation === null || chips.length === 0) return null;
  return (
    <div className="mb-2 flex min-w-0 flex-wrap gap-1.5" data-testid="app-ref-chip-strip">
      {chips.map((chip) => (
        <AppRefChip
          key={chip.ref}
          reference={chip.ref}
          label={chip.label}
          iconUrl={chip.iconUrl ?? null}
          onRemove={() => remove(targetKey, chip.ref)}
        />
      ))}
    </div>
  );
}

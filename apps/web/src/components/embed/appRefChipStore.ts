import type { ScopedThreadRef } from "@lecturn/contracts";
import { promptWithAppReferences, type AppReferenceLabel } from "@lecturn/shared/appReferences";
import { create } from "zustand";

import { composerTargetKey, type DraftId } from "../../composerDraftStore";
import type { EmbedMention } from "../../embed/hostCommands";
import { useAppRefLabelStore } from "./appRefLabels";

export type AppRefChipEntry = EmbedMention;

// A host inserting on every selection change must not grow the strip without bound.
const MAX_CHIPS_PER_TARGET = 16;
const EMPTY_CHIPS: ReadonlyArray<AppRefChipEntry> = [];

interface AppRefChipState {
  /** Keyed by composer draft target, so each thread keeps its own chips. */
  readonly chipsByTarget: Readonly<Record<string, ReadonlyArray<AppRefChipEntry>>>;
  readonly add: (targetKey: string, chip: AppRefChipEntry) => void;
  readonly remove: (targetKey: string, ref: string) => void;
  readonly clear: (targetKey: string) => void;
}

const withChips = (
  state: AppRefChipState,
  targetKey: string,
  chips: ReadonlyArray<AppRefChipEntry>,
): Pick<AppRefChipState, "chipsByTarget"> => {
  const { [targetKey]: _previous, ...rest } = state.chipsByTarget;
  return { chipsByTarget: chips.length === 0 ? rest : { ...rest, [targetKey]: chips } };
};

export const useAppRefChipStore = create<AppRefChipState>()((set) => ({
  chipsByTarget: {},
  add: (targetKey, chip) =>
    set((state) => {
      const others = (state.chipsByTarget[targetKey] ?? EMPTY_CHIPS).filter(
        (existing) => existing.ref !== chip.ref,
      );
      return withChips(state, targetKey, [...others, chip].slice(-MAX_CHIPS_PER_TARGET));
    }),
  remove: (targetKey, ref) =>
    set((state) =>
      withChips(
        state,
        targetKey,
        (state.chipsByTarget[targetKey] ?? EMPTY_CHIPS).filter((chip) => chip.ref !== ref),
      ),
    ),
  clear: (targetKey) => set((state) => withChips(state, targetKey, EMPTY_CHIPS)),
}));

export function useAppRefChips(targetKey: string): ReadonlyArray<AppRefChipEntry> {
  return useAppRefChipStore((state) => state.chipsByTarget[targetKey] ?? EMPTY_CHIPS);
}

/**
 * Folds the target's chips into the draft's text for a send, the form the agent and the timeline
 * read references in. The send path reads the prompt from `promptRef` while it runs, so the folded
 * text is there only until the returned settle: it clears the chips when the send went out, and
 * gives the editor its own text back unless the send took it.
 */
export function foldAppRefChips(
  targetKey: string | null,
  promptRef: { current: string },
): (didDispatch: boolean) => void {
  const chips =
    targetKey === null
      ? EMPTY_CHIPS
      : (useAppRefChipStore.getState().chipsByTarget[targetKey] ?? EMPTY_CHIPS);
  if (targetKey === null || chips.length === 0) return () => undefined;
  const typed = promptRef.current;
  const folded = promptWithAppReferences(
    typed,
    chips.map((chip) => chip.ref),
  );
  promptRef.current = folded;
  return (didDispatch) => {
    if (didDispatch) useAppRefChipStore.getState().clear(targetKey);
    if (promptRef.current === folded) promptRef.current = typed;
  };
}

/**
 * The labels of the target's chips that a sent message names, to store on it so its bubble shows
 * them. Read while the send runs, before the fold's settle clears the chips. This tab's thread
 * shows them at once, ahead of the server's copy of the message.
 */
export function appRefLabelsForSend(
  target: ScopedThreadRef | DraftId,
  text: string,
): ReadonlyArray<AppReferenceLabel> {
  const targetKey = composerTargetKey(target);
  const chips = useAppRefChipStore.getState().chipsByTarget[targetKey] ?? EMPTY_CHIPS;
  if (chips.length === 0) return EMPTY_CHIPS;
  const words = new Set(text.split(/\s+/u));
  const labels = chips.flatMap(({ ref, label }) => {
    const name = label.trim();
    return name.length > 0 && name !== ref && words.has(ref) ? [{ ref, label: name }] : [];
  });
  if (labels.length > 0) useAppRefLabelStore.getState().remember(targetKey, labels);
  return labels;
}

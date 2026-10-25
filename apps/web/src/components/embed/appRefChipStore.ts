import { promptWithAppReferences } from "@lecturn/shared/appReferences";
import { create } from "zustand";

import type { EmbedMention } from "../../embed/hostCommands";

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

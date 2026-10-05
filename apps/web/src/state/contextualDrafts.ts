import type { DraftId } from "../composerDraftStore";
import { Schema } from "effect";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { EnvironmentId, ProjectId } from "@lecturn/contracts";
const Choice = Schema.Struct({
  enabled: Schema.Boolean,
  sourceIds: Schema.Array(Schema.String.check(Schema.isMaxLength(256))).check(
    Schema.isMaxLength(256),
  ),
});
const Choices = Schema.Record(Schema.String, Choice);
const decodeChoices = Schema.decodeUnknownOption(Choices);
export type ContextualDraftChoice = typeof Choice.Type;
export function contextualDraftKey(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  draftId: DraftId,
) {
  return JSON.stringify([environmentId, projectId, draftId]);
}
export function updateContextualDraftChoices(
  choices: Readonly<Record<string, ContextualDraftChoice>>,
  key: string,
  choice: ContextualDraftChoice | null,
) {
  const next = { ...choices };
  delete next[key];
  if (choice) next[key] = choice;
  return Object.fromEntries(Object.entries(next).slice(-100));
}
export const useContextualDrafts = create<{
  choices: Readonly<Record<string, ContextualDraftChoice>>;
  set: (key: string, choice: ContextualDraftChoice | null) => void;
}>()(
  persist(
    (set) => ({
      choices: {},
      set: (key, choice) =>
        set((state) => ({ choices: updateContextualDraftChoices(state.choices, key, choice) })),
    }),
    {
      name: "lecturn:contextual-drafts:v1",
      partialize: (state) => ({ choices: state.choices }),
      merge: (saved, current) => {
        const raw =
          typeof saved === "object" && saved !== null && "choices" in saved ? saved.choices : {};
        const parsed = decodeChoices(raw);
        return {
          ...current,
          choices:
            parsed._tag === "Some"
              ? Object.fromEntries(Object.entries(parsed.value).slice(-100))
              : {},
        };
      },
    },
  ),
);

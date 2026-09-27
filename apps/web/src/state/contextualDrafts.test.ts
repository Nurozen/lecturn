import { DraftId } from "../composerDraftStore";
import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@lecturn/contracts";
import { contextualDraftKey, updateContextualDraftChoices } from "./contextualDrafts";
describe("draft Contextual intent", () => {
  it("keeps the same draft isolated by host and project", () => {
    const env = EnvironmentId.make("host"),
      project = ProjectId.make("project"),
      draft = DraftId.make("draft");
    const key = contextualDraftKey(env, project, draft),
      choice = { enabled: true, sourceIds: ["selected"] };
    const state = updateContextualDraftChoices({}, key, choice);
    expect(state[key]).toEqual(choice);
    expect(state[contextualDraftKey(EnvironmentId.make("other"), project, draft)]).toBeUndefined();
    expect(state[contextualDraftKey(env, ProjectId.make("other"), draft)]).toBeUndefined();
    expect(updateContextualDraftChoices(state, key, null)[key]).toBeUndefined();
  });
  it("bounds retained choices without evicting the most recently edited draft", () => {
    let choices = {};
    for (let i = 0; i < 101; i++)
      choices = updateContextualDraftChoices(choices, String(i), { enabled: true, sourceIds: [] });
    expect(Object.keys(choices)).toHaveLength(100);
    expect(choices).not.toHaveProperty("0");
  });
});

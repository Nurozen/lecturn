import { describe, expect, it } from "vite-plus/test";
import type { ContextualSource, ContextualSourcePolicy } from "@lecturn/contracts";
import { updateSourceSelection } from "./ContextualHostSettings.logic";
const policy: ContextualSourcePolicy = {
  allowedSourceIds: ["existing"],
  allowDirectMessages: false,
  allowGroupDirectMessages: false,
  unknownConversationPolicy: "exclude",
  draftsPolicy: "exclude",
  revision: 2,
};
const source: ContextualSource = {
  id: "source",
  sourceKind: "slack",
  label: "Fixture source",
  hostName: "Fixture host",
  workspaceId: "workspace",
  channelId: "channel",
  conversationType: "channel",
  available: true,
  selected: false,
};
describe("source allowlist boundaries", () => {
  it.each(["unknown", "dm", "group-dm"] as const)(
    "keeps %s conversations excluded without an explicit selection",
    (conversationType) => {
      expect(
        updateSourceSelection(policy, { ...source, conversationType }, false).allowedSourceIds,
      ).toEqual(["existing"]);
      const selected = updateSourceSelection(policy, { ...source, conversationType }, true);
      if (conversationType === "unknown") expect(selected).toEqual(policy);
      else {
        expect(selected.allowedSourceIds).toEqual(["existing", "source"]);
        expect(selected.allowDirectMessages).toBe(conversationType === "dm");
        expect(selected.allowGroupDirectMessages).toBe(conversationType === "group-dm");
      }
    },
  );
  it("allows removing unavailable sources while rejecting new unavailable selections", () => {
    expect(updateSourceSelection(policy, { ...source, available: false }, true)).toEqual(policy);
    expect(
      updateSourceSelection(policy, { ...source, id: "existing", available: false }, false)
        .allowedSourceIds,
    ).toEqual([]);
  });
  it("never silently exceeds the host source cap", () => {
    const full = {
      ...policy,
      allowedSourceIds: Array.from({ length: 256 }, (_, index) => `source-${index}`),
    };
    expect(updateSourceSelection(full, source, true)).toEqual(full);
  });
});

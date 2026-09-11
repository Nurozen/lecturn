import { ProviderDriverKind, ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveSagaInferenceModel } from "./sagaInferenceModel.ts";

const account = ProviderInstanceId.make("my-second-account");
const selection: ModelSelection = {
  instanceId: account,
  model: "current-model",
  options: [{ id: "effort", value: "high" }],
};

describe("saga account inference model", () => {
  it.each([
    ["codex", "gpt-5.6-luna", "reasoningEffort"],
    ["claudeAgent", "claude-sonnet-5", "effort"],
  ])("uses %s's advertised small model on the same exact account", (driver, model, effort) => {
    expect(
      resolveSagaInferenceModel(selection, ProviderDriverKind.make(driver), [{ slug: model }]),
    ).toEqual({
      instanceId: account,
      model,
      options: [{ id: effort, value: "low" }],
    });
  });
  it("prefers current Composer when available, falling back within the same account", () => {
    const driver = ProviderDriverKind.make("cursor");
    expect(
      resolveSagaInferenceModel(selection, driver, [
        { slug: "composer-2" },
        { slug: "composer-2.5" },
      ]),
    ).toEqual({ instanceId: account, model: "composer-2.5" });
    expect(resolveSagaInferenceModel(selection, driver, [{ slug: "composer-2" }]).model).toBe(
      "composer-2",
    );
  });
  it.each(["codex", "claudeAgent", "cursor", "grok", "opencode", "custom-driver"])(
    "preserves %s's selected account/model/options without an advertised preference",
    (driver) => {
      expect(resolveSagaInferenceModel(selection, ProviderDriverKind.make(driver), [])).toBe(
        selection,
      );
    },
  );
  it("never changes an OpenCode downstream provider even if another account advertises Luna", () => {
    const source = { ...selection, model: "my-anthropic/claude-sonnet-5" };
    expect(
      resolveSagaInferenceModel(source, ProviderDriverKind.make("opencode"), [
        { slug: "openai/gpt-5.6-luna" },
      ]),
    ).toBe(source);
  });
});

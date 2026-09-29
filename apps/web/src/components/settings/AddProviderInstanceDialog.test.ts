import { ProviderInstanceConfig } from "@lecturn/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildCrusoeProviderInstance,
  resolveWizardNavigation,
} from "./AddProviderInstanceDialog.logic";

const decodeProviderInstanceConfig = Schema.decodeUnknownSync(ProviderInstanceConfig);

describe("resolveWizardNavigation", () => {
  const invalidId = { instanceIdError: "Instance ID is required." };
  const validId = { instanceIdError: null };

  it("allows moving from Driver to Identity before the instance id is valid", () => {
    expect(resolveWizardNavigation(0, 1, 3, invalidId)).toEqual({ kind: "navigate", step: 1 });
  });

  it("blocks Next from Identity to Config while the instance id is invalid", () => {
    expect(resolveWizardNavigation(1, 2, 3, invalidId)).toEqual({
      kind: "blocked",
      step: 1,
      error: "Instance ID is required.",
    });
  });

  it("stops a direct Driver-to-Config skip at Identity and surfaces its error", () => {
    expect(resolveWizardNavigation(0, 2, 3, invalidId)).toEqual({
      kind: "blocked",
      step: 1,
      error: "Instance ID is required.",
    });
  });

  it("allows advancing and skipping forward once the instance id is valid", () => {
    expect(resolveWizardNavigation(1, 2, 3, validId)).toEqual({ kind: "navigate", step: 2 });
    expect(resolveWizardNavigation(0, 2, 3, validId)).toEqual({ kind: "navigate", step: 2 });
  });

  it("always preserves backward Driver and Identity navigation", () => {
    expect(resolveWizardNavigation(2, 1, 3, invalidId)).toEqual({ kind: "navigate", step: 1 });
    expect(resolveWizardNavigation(2, 0, 3, invalidId)).toEqual({ kind: "navigate", step: 0 });
    expect(resolveWizardNavigation(1, 0, 3, invalidId)).toEqual({ kind: "navigate", step: 0 });
  });

  it("clamps requested steps to the wizard bounds", () => {
    expect(resolveWizardNavigation(2, 8, 3, validId)).toEqual({ kind: "navigate", step: 2 });
    expect(resolveWizardNavigation(0, -1, 3, invalidId)).toEqual({ kind: "navigate", step: 0 });
  });
});

describe("buildCrusoeProviderInstance", () => {
  it("refuses to build an instance without an API key", () => {
    expect(buildCrusoeProviderInstance({ apiKey: "   " })).toBeNull();
  });

  it("builds a valid OpenCode instance that stores the key as a secret", () => {
    const instance = buildCrusoeProviderInstance({ apiKey: " ck-123 \n", displayName: "Crusoe" });
    const decoded = decodeProviderInstanceConfig(instance);

    expect(decoded.driver).toBe("opencode");
    expect(decoded.displayName).toBe("Crusoe");
    expect(decoded.environment).toContainEqual({
      name: "CRUSOE_API_KEY",
      value: "ck-123",
      sensitive: true,
    });
  });

  it("limits the OpenCode instance to Crusoe models", () => {
    const instance = buildCrusoeProviderInstance({ apiKey: "ck-123" });
    const configContent = instance?.environment?.find(
      (variable) => variable.name === "OPENCODE_CONFIG_CONTENT",
    );

    expect(JSON.parse(configContent?.value ?? "{}")).toEqual({ enabled_providers: ["crusoe"] });
  });
});

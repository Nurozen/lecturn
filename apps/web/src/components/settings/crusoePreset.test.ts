import { ProviderInstanceConfig } from "@lecturn/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { UNCONFIGURED_CRUSOE_INSTANCE, buildCrusoeProviderInstance } from "./crusoePreset";

const decodeProviderInstanceConfig = Schema.decodeUnknownSync(ProviderInstanceConfig);

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

describe("UNCONFIGURED_CRUSOE_INSTANCE", () => {
  it("is a valid, disabled Crusoe instance with an empty secret key field", () => {
    const decoded = decodeProviderInstanceConfig(UNCONFIGURED_CRUSOE_INSTANCE);

    expect(decoded.enabled).toBe(false);
    expect(decoded.displayName).toBe("Crusoe");
    expect(decoded.environment).toContainEqual({
      name: "CRUSOE_API_KEY",
      value: "",
      sensitive: true,
    });
  });
});

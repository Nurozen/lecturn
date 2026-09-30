import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
} from "@lecturn/contracts";

/**
 * Crusoe is offered as a preset rather than a driver: it is an OpenCode
 * instance whose environment carries the Crusoe API key and limits OpenCode
 * to its built-in `crusoe` provider, so the instance lists only Crusoe models.
 * Settings shows it as a standing `opencode_crusoe` slot, like the built-in
 * drivers, until the user saves it.
 */
export const CRUSOE_PRESET = {
  value: "crusoe",
  label: "Crusoe",
  driver: ProviderDriverKind.make("opencode"),
  instanceId: ProviderInstanceId.make("opencode_crusoe"),
} as const;

function crusoeEnvironment(apiKey: string): ProviderInstanceEnvironmentVariable[] {
  return [
    { name: "CRUSOE_API_KEY", value: apiKey, sensitive: true },
    {
      name: "OPENCODE_CONFIG_CONTENT",
      value: JSON.stringify({ enabled_providers: ["crusoe"] }),
      sensitive: false,
    },
  ];
}

export function buildCrusoeProviderInstance(input: {
  readonly apiKey: string;
  readonly displayName?: string;
  readonly accentColor?: string;
}): ProviderInstanceConfig | null {
  const apiKey = input.apiKey.trim();
  if (apiKey.length === 0) return null;
  return {
    driver: CRUSOE_PRESET.driver,
    enabled: true,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    environment: crusoeEnvironment(apiKey),
  };
}

/** The unsaved Crusoe slot: disabled, with an empty key field ready to fill. */
export const UNCONFIGURED_CRUSOE_INSTANCE: ProviderInstanceConfig = {
  driver: CRUSOE_PRESET.driver,
  enabled: false,
  displayName: CRUSOE_PRESET.label,
  environment: crusoeEnvironment(""),
};

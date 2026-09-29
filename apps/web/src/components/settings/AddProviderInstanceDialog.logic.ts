import { ProviderDriverKind, type ProviderInstanceConfig } from "@lecturn/contracts";

export type WizardNavigation =
  | { readonly kind: "navigate"; readonly step: number }
  | { readonly kind: "blocked"; readonly step: number; readonly error: string };

const IDENTITY_STEP = 1;

export const ADD_PROVIDER_WIZARD_STEPS = ["Driver", "Identity", "Config"] as const;

/**
 * Resolve navigation within the add-provider wizard.
 *
 * Moving forward past Identity requires a valid instance id, whether the user
 * advances one step at a time or skips directly to Config from a step header.
 * A blocked skip lands on Identity so its existing inline validation is
 * visible. Backward navigation is always preserved.
 */
export function resolveWizardNavigation(
  currentStep: number,
  requestedStep: number,
  stepCount: number,
  validation: { readonly instanceIdError: string | null },
): WizardNavigation {
  const lastStep = Math.max(0, stepCount - 1);
  const targetStep = Math.max(0, Math.min(lastStep, requestedStep));
  const movesForwardPastIdentity = currentStep <= IDENTITY_STEP && targetStep > IDENTITY_STEP;

  if (movesForwardPastIdentity && validation.instanceIdError !== null) {
    return {
      kind: "blocked",
      step: Math.min(IDENTITY_STEP, lastStep),
      error: validation.instanceIdError,
    };
  }

  return { kind: "navigate", step: targetStep };
}

/**
 * Crusoe is offered as a preset rather than a driver: it is an OpenCode
 * instance whose environment carries the Crusoe API key and limits OpenCode
 * to its built-in `crusoe` provider, so the instance lists only Crusoe models.
 */
export const CRUSOE_PRESET = {
  value: "crusoe",
  label: "Crusoe",
  driver: ProviderDriverKind.make("opencode"),
} as const;

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
    environment: [
      { name: "CRUSOE_API_KEY", value: apiKey, sensitive: true },
      {
        name: "OPENCODE_CONFIG_CONTENT",
        value: JSON.stringify({ enabled_providers: ["crusoe"] }),
        sensitive: false,
      },
    ],
  };
}

import type { V2TurnStartParams__AdditionalContextEntry } from "effect-codex-app-server/schema";
import { buildRuntimeInstructions } from "@lecturn/provider-core/server/runtimeInstructions";

import {
  LECTURN_BROWSER_TOOL_INSTRUCTIONS,
  LECTURN_ORCHESTRATION_SECTIONS,
} from "@lecturn/provider-core/server/orchestrationInstructions";

/** Codex silently truncates additionalContext values over 1,000 tokens, counted as UTF-8 bytes / 4. */
export const CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES = 4_000;

const LECTURN_DEVICE_TOOL_INSTRUCTIONS = `## Lecturn devices

For iOS Simulators and Android Emulators here, call \`device_list\`, then \`device_open\`. Drive the device with the exact \`agent-device\` launcher and flags it returns, on every command. Prefer \`agent-device snapshot -i\` refs over coordinates. Use \`device_screenshot\` to see the screen. Use \`xcrun simctl\` or \`adb\` only for builds, logs, and ports. If a platform is unavailable, say so.`;

export interface LecturnToolAvailability {
  readonly browser: boolean;
  readonly device: boolean;
}

const normalizeAvailability = (
  availability: boolean | LecturnToolAvailability,
): LecturnToolAvailability =>
  typeof availability === "boolean" ? { browser: availability, device: false } : availability;

/** Instructions for unavailable tools would steer the model away from its remaining automation. */
const toolInstructions = (availability: boolean | LecturnToolAvailability): string => {
  const tools = normalizeAvailability(availability);
  return [
    tools.browser ? LECTURN_BROWSER_TOOL_INSTRUCTIONS : "",
    tools.device ? LECTURN_DEVICE_TOOL_INSTRUCTIONS : "",
  ]
    .filter(Boolean)
    .join("\n\n");
};

export interface CodexRuntimeInfo {
  readonly model: string;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}

/** Keep this outside collaboration mode; model-catalog mode text overrides client developer_instructions. */
export function buildCodexAdditionalContext(
  runtime: CodexRuntimeInfo,
  toolsAvailable: boolean | LecturnToolAvailability = true,
  /** Lecturn: a Squire home's skill replaces the orchestration and tool sections. */
  squireInstructions?: ReadonlyArray<string>,
): Record<string, V2TurnStartParams__AdditionalContextEntry> {
  const squire = squireInstructions !== undefined && squireInstructions.length > 0;
  const tools = squire ? "" : toolInstructions(toolsAvailable);
  const [prefix, sections] = squire
    ? ["lecturn_squire", squireInstructions]
    : ["lecturn_orchestration", LECTURN_ORCHESTRATION_SECTIONS];
  // Split values to fit per-entry caps; number keys because Codex emits them in key order.
  return {
    ...Object.fromEntries(
      sections.map((section, index) => [
        `${prefix}_${String(index + 1).padStart(2, "0")}`,
        { kind: "application" as const, value: section },
      ]),
    ),
    lecturn_runtime: {
      kind: "application",
      value: buildRuntimeInstructions({ harness: "Codex", ...runtime }),
    },
    ...(tools ? { lecturn_tools: { kind: "application", value: tools } } : {}),
  };
}

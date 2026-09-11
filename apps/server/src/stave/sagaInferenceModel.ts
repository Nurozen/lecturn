import type { ModelSelection, ProviderDriverKind } from "@lecturn/contracts";

/** Pick a small inference model within the triggering conversation's account. */
export function resolveSagaInferenceModel(
  selection: ModelSelection,
  driverKind: ProviderDriverKind,
  models: ReadonlyArray<{ readonly slug: string }>,
): ModelSelection {
  const preferences =
    driverKind === "codex"
      ? ["gpt-5.6-luna"]
      : driverKind === "claudeAgent"
        ? ["claude-sonnet-5"]
        : driverKind === "cursor"
          ? ["composer-2.5", "composer-2"]
          : [];
  const model = preferences.find((preferred) => models.some((entry) => entry.slug === preferred));
  // OpenCode's provider/model slug selects a downstream account. Grok may use
  // custom model endpoints. Antigravity keeps the account-selected model too.
  // Preserve these rather than guessing a new provider.
  if (model === undefined) return selection;
  return {
    instanceId: selection.instanceId,
    model,
    ...(driverKind === "codex"
      ? { options: [{ id: "reasoningEffort", value: "low" }] }
      : driverKind === "claudeAgent"
        ? { options: [{ id: "effort", value: "low" }] }
        : {}),
  };
}

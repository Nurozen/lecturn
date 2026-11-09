/**
 * Where the permissions control lives, which blocks overflow, and which menu answers the
 * composer.mode shortcut. Blocks are ordered [traits, mode]; the last block overflows first.
 * The rule: Permissions have exactly one visible home and composer.mode exactly one target.
 */
export function resolveComposerControlsOwnership(input: {
  /** The new design moves Permissions into the effort menu; the Lecturn look keeps the chip. */
  readonly permissionsInEffortMenu: boolean;
  /** Permissions hide while the mode is the default, or while the new-thread strip names it. */
  readonly matchesDefault: boolean;
  /** The model has an effort (traits) menu, which holds Permissions in the new design. */
  readonly hasTraits: boolean;
  readonly planModeUiEnabled: boolean;
  readonly collapsed: boolean;
  /** How many trailing blocks the width measurement moved into the overflow menu. */
  readonly measuredHiddenBlockCount: number;
}) {
  const effortHoldsPermissions = input.permissionsInEffortMenu && input.hasTraits;
  const accessDisplay = resolveAccessDisplay(input);
  const showModeBlock = !(accessDisplay === "hidden" && !input.planModeUiEnabled);
  const blockIds = [
    ...(input.hasTraits ? ["traits" as const] : []),
    ...(showModeBlock ? ["mode" as const] : []),
  ];
  const hiddenFor = (count: number) => blockIds.slice(blockIds.length - count);
  const overflowShowsPermissionsFor = (hidden: ReadonlyArray<string>) =>
    hidden.includes(effortHoldsPermissions ? "traits" : "mode");
  const overflowHasContent = (hidden: ReadonlyArray<string>) =>
    hidden.includes("traits") ||
    (input.planModeUiEnabled && hidden.includes("mode")) ||
    overflowShowsPermissionsFor(hidden);

  let hiddenBlockCount = Math.min(input.measuredHiddenBlockCount, blockIds.length);
  // An overflow menu with nothing in it must not exist: overflow one more block instead.
  while (
    hiddenBlockCount > 0 &&
    hiddenBlockCount < blockIds.length &&
    !overflowHasContent(hiddenFor(hiddenBlockCount))
  ) {
    hiddenBlockCount += 1;
  }
  const hiddenBlockIds = hiddenFor(hiddenBlockCount);
  const modeHidden = hiddenBlockIds.includes("mode");
  const traitsHidden = hiddenBlockIds.includes("traits");
  return {
    accessDisplay,
    showModeBlock,
    hiddenBlockCount,
    hiddenBlockIds,
    traitsHidden,
    modeHidden,
    /**
     * The effort chip answers composer.mode while the chip is hidden or overflowed, until the
     * effort chip overflows too; then the overflow menu (which holds Permissions) answers it.
     */
    effortOwnsModeShortcut:
      effortHoldsPermissions && (input.matchesDefault || modeHidden) && !traitsHidden,
    overflowShowsPermissions: overflowShowsPermissionsFor(hiddenBlockIds),
  };
}

function resolveAccessDisplay(input: {
  readonly permissionsInEffortMenu: boolean;
  readonly matchesDefault: boolean;
  readonly hasTraits: boolean;
  readonly collapsed: boolean;
}): "label" | "icon" | "hidden" {
  // The Lecturn look keeps the labelled chip at every mode, as before the new design.
  if (!input.permissionsInEffortMenu) return "label";
  if (!input.matchesDefault) return input.collapsed ? "icon" : "label";
  // Without traits there is no effort menu to hold Permissions, so keep an icon.
  return input.hasTraits ? "hidden" : "icon";
}

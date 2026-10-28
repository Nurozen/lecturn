import { useAtomValue } from "@effect/atom-react";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@lecturn/client-runtime/environment";
import type { EnvironmentThreadShell } from "@lecturn/client-runtime/state/shell";
import type { ScopedProjectRef, ScopedThreadRef } from "@lecturn/contracts";
import { useEffect } from "react";
import { create } from "zustand";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { isElectron } from "../../env";
import { useTerminalFocus } from "../../hooks/useTerminalFocus";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHintsForModifiers,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../../keybindings";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { useShortcutModifierState } from "../../shortcutModifierState";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";
import { resolveAdjacentThreadId, useThreadJumpHintVisibility } from "../Sidebar.logic";
import type { AppsSidebarWorkspace } from "./AppsSidebar.logic";

interface AppsNewThreadTargetState {
  readonly target: ScopedProjectRef | null;
}

/**
 * Where the sidebar header's New thread (and its shortcut) lands in Apps mode; null when the
 * apps in view have no workspace. Apps mode owns the answer because only it knows which apps
 * are in view. It outlives the Apps tree (hidden while searching) so the button stays usable;
 * readers check the mode.
 */
export const useAppsNewThreadTarget = create<AppsNewThreadTargetState>(() => ({ target: null }));

export function usePublishAppsNewThreadTarget(workspace: AppsSidebarWorkspace | null): void {
  const environmentId = workspace?.project.environmentId ?? null;
  const projectId = workspace?.project.id ?? null;
  useEffect(() => {
    useAppsNewThreadTarget.setState({
      target:
        environmentId === null || projectId === null
          ? null
          : scopeProjectRef(environmentId, projectId),
    });
  }, [environmentId, projectId]);
}

/**
 * Jump (Mod+1..9) and next/previous thread shortcuts over Apps mode's visible rows, which the
 * Projects tree's handler leaves alone while Apps mode shows. Returns the hint label per thread
 * key while the jump modifier is held.
 */
export function useAppsSidebarThreadJumps(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly routeThreadRef: ScopedThreadRef | null;
  /** The row standing in for the open thread (an open subagent's ancestor). */
  readonly routeRowThreadKey: string | null;
  readonly open: (threadRef: ScopedThreadRef) => void;
}): ReadonlyMap<string, string> | null {
  const { threads, routeThreadRef, routeRowThreadKey, open } = input;
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const routeTerminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  const threadRefByKey = new Map(
    threads.map((thread) => {
      const threadRef = scopeThreadRef(thread.environmentId, thread.id);
      return [scopedThreadKey(threadRef), threadRef] as const;
    }),
  );
  const threadKeys = [...threadRefByKey.keys()];

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isCommandPaletteOpen() || isModelPickerOpen()) {
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: routeTerminalOpen,
          modelPickerOpen: isModelPickerOpen(),
          isWeb: !isElectron,
          isDesktop: isElectron,
        },
      });
      const direction = threadTraversalDirectionFromCommand(command);
      const jumpIndex = direction === null ? threadJumpIndexFromCommand(command ?? "") : null;
      const targetKey =
        direction !== null
          ? resolveAdjacentThreadId({
              threadIds: threadKeys,
              currentThreadId: routeRowThreadKey,
              direction,
            })
          : jumpIndex === null
            ? null
            : (threadKeys[jumpIndex] ?? null);
      const target = targetKey === null ? undefined : threadRefByKey.get(targetKey);
      if (target === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      open(target);
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [keybindings, open, routeRowThreadKey, routeTerminalOpen, threadKeys, threadRefByKey]);

  const shortcutModifiers = useShortcutModifierState();
  const terminalFocused = useTerminalFocus();
  const { showThreadJumpHints, updateThreadJumpHintsVisibility } = useThreadJumpHintVisibility();
  const shouldShowHintsNow = shouldShowThreadJumpHintsForModifiers(shortcutModifiers, keybindings, {
    platform: navigator.platform,
    context: {
      terminalFocus: terminalFocused,
      terminalOpen: routeTerminalOpen,
      modelPickerOpen: isModelPickerOpen(),
      isWeb: !isElectron,
      isDesktop: isElectron,
    },
  });
  useEffect(() => {
    updateThreadJumpHintsVisibility(shouldShowHintsNow);
  }, [shouldShowHintsNow, updateThreadJumpHintsVisibility]);

  if (!showThreadJumpHints) return null;
  const labels = new Map<string, string>();
  for (const [index, threadKey] of threadKeys.entries()) {
    const jumpCommand = threadJumpCommandForIndex(index);
    if (!jumpCommand) break;
    const label = shortcutLabelForCommand(keybindings, jumpCommand);
    if (label) labels.set(threadKey, label);
  }
  return labels;
}

import type { KeybindingCommand } from "@lecturn/contracts";

import { composerShortcutCommands } from "./composerShortcuts";
import { useChatShortcuts, type ChatShortcutsInput } from "./useChatShortcuts";

/**
 * Lecturn: every control ChatView renders or wires, for its `controls` allowlist. Absent
 * `controls` keeps today's view; a set shows only what it lists. A control ChatView gains
 * upstream must join this list, or the allowlist browser test fails.
 */
export type ChatViewControl =
  // Allowed on a Squire's home thread.
  | "copy"
  | "expand"
  | "load-earlier"
  | "image-preview"
  | "mcp-app-actions"
  | "composer-text"
  | "send"
  | "stop"
  // Denied there.
  /** ChatHeader (title, thread menu, new thread, panel toggles), settle, pin, unsettle. */
  | "thread-actions"
  /** The thread details panel, which holds git actions, project scripts, and open-in. */
  | "thread-panel"
  /** The composer's branch, worktree, and environment toolbar. */
  | "branch-toolbar"
  | "terminal"
  | "git"
  | "project-scripts"
  | "open-in"
  /** The right panel (preview, files, notes, PRs) and the preview mini player. */
  | "right-panel"
  /** The diff panel, changed-files cards, and every "Open diff". */
  | "diff"
  | "model-picker"
  | "runtime-mode"
  | "interaction-mode"
  /** Attach button, pasted or dropped files, and long pastes folded into files. */
  | "attachments"
  /** Plan follow-up and "implement in a new thread". */
  | "plan"
  | "compact"
  | "usage-limits"
  | "queued-runs"
  | "contextual"
  | "fork"
  | "rollback"
  | "edit-from-here"
  | "cite"
  | "notes"
  | "run-command"
  /** Thread find, the turn minimap, and scroll to end. */
  | "timeline-navigation"
  /**
   * Settled turns' "Worked for" labels and raw event-batch labels. Denied, a Squire's delivered
   * event batch reads as one "Squire update" row and a turn's fold as "Tool calls (N)".
   */
  | "turn-details";

export type ChatViewControls = ReadonlySet<ChatViewControl>;

export const SQUIRE_THREAD_CONTROLS: ChatViewControls = new Set<ChatViewControl>([
  "copy",
  "expand",
  "load-earlier",
  "image-preview",
  "mcp-app-actions",
  "composer-text",
  "send",
  "stop",
]);

export function allowsChatViewControl(
  controls: ChatViewControls | undefined,
  control: ChatViewControl,
): boolean {
  return controls === undefined || controls.has(control);
}

/** A shortcut runs only when its control is listed; a command missing here is denied. */
const SHORTCUT_CONTROLS: Partial<Record<KeybindingCommand, ChatViewControl>> = {
  "thread.copyReference": "thread-actions",
  "thread.settle": "thread-actions",
  "thread.pin": "thread-actions",
  "terminal.toggle": "terminal",
  "terminal.split": "terminal",
  "terminal.splitVertical": "terminal",
  "terminal.close": "terminal",
  "terminal.new": "terminal",
  "chat.find": "timeline-navigation",
  "rightPanel.toggle": "right-panel",
  "rightPanel.toggleMaximized": "right-panel",
  "rightPanel.close": "right-panel",
  "threadPanel.toggle": "thread-panel",
  "diff.toggle": "diff",
  "modelPicker.toggle": "model-picker",
  "composer.increaseEffort": "model-picker",
  "composer.decreaseEffort": "model-picker",
  "composer.effort": "model-picker",
  "composer.mode": "runtime-mode",
  "composer.host": "branch-toolbar",
  "composer.workspace": "branch-toolbar",
  "composer.cycleHost": "branch-toolbar",
  "composer.branch": "branch-toolbar",
  "composer.previousWorktree": "branch-toolbar",
  "thread.steerQueuedMessage": "queued-runs",
  "thread.editQueuedMessage": "queued-runs",
  "thread.stop": "stop",
};

/** ChatView's window shortcuts, less the ones whose control `controls` leaves out. */
export function useChatViewShortcuts(
  controls: ChatViewControls | undefined,
  input: ChatShortcutsInput,
): void {
  const allowed = (command: string) => {
    const control = SHORTCUT_CONTROLS[command as KeybindingCommand];
    return control !== undefined && controls?.has(control) === true;
  };
  useChatShortcuts(
    controls === undefined
      ? input
      : {
          ...input,
          commands: {
            // useChatShortcuts adds the composer's chords itself; a denied one passes the key on.
            ...Object.fromEntries(
              Object.keys(composerShortcutCommands(input.composerRef, input.branchToolbarRef))
                .filter((command) => !allowed(command))
                .map((command) => [command, () => false]),
            ),
            ...Object.fromEntries(
              Object.entries(input.commands).filter(([command]) => allowed(command)),
            ),
          },
        },
  );
}

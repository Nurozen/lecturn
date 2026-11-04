import type { EnvironmentThreadShell } from "@lecturn/client-runtime/state/shell";

/**
 * Lecturn: every control the thread route renders or wires (ThreadRouteScreen, ThreadHeader,
 * ThreadDetailScreen, ThreadComposer, ThreadFeed), for its `controls` allowlist. Absent
 * `controls` keeps today's screen; a set shows only what it lists. A control those files gain
 * upstream must join this list and be read where it renders, or a Squire thread shows it.
 */
export type ThreadRouteControl =
  // Allowed on a Squire's home thread.
  | "copy"
  /** Work log rows, work groups, and turn folds. */
  | "expand"
  | "load-earlier"
  | "image-preview"
  | "mcp-app-actions"
  /** Typing, dictation, and the composer's mention and skill menus. */
  | "composer-text"
  | "send"
  | "stop"
  // Denied there.
  /** The iOS "Thread" header menu and the Android Squire tracking menu. */
  | "thread-actions"
  | "decisions"
  | "squire-tracking"
  /** Fork thread, in the iOS menu and as the Android header action. */
  | "fork"
  | "fork-from-response"
  | "edit-pending-message"
  /**
   * The git menu (with Review changes) and the git inspector. On iOS the native header group
   * also carries terminal, files, and scripts, so it shows only while git is allowed.
   */
  | "git"
  | "merge-back"
  | "terminal"
  /** The files inspector and the inspector pane toggle. */
  | "files"
  | "project-scripts"
  /** The model and reasoning settings row, and its "Model unavailable" prompt. */
  | "model-picker"
  | "runtime-mode"
  /** Plan and default modes, including `/plan` and `/default`. */
  | "interaction-mode"
  /** Attach buttons and pasted images or files. */
  | "attachments"
  | "compact"
  | "usage-limits"
  | "contextual"
  /** The queue sheet, Resume queue, and editing a queued run. */
  | "queued-runs"
  | "agents"
  /** Device and browser previews. */
  | "previews"
  | "artifact-templates"
  | "unsettle"
  /** Scroll to end. */
  | "timeline-navigation";

export type ThreadRouteControls = ReadonlySet<ThreadRouteControl>;

export const SQUIRE_THREAD_CONTROLS: ThreadRouteControls = new Set<ThreadRouteControl>([
  "copy",
  "expand",
  "load-earlier",
  "image-preview",
  "mcp-app-actions",
  "composer-text",
  "send",
  "stop",
]);

export function allowsThreadRouteControl(
  controls: ThreadRouteControls | undefined,
  control: ThreadRouteControl,
): boolean {
  return controls === undefined || controls.has(control);
}

/**
 * A Squire's home thread gets the Squire set however it was reached (the Squire screen's Chat,
 * a link, the thread list on an old client), so no route can show a control the server
 * refuses there. Probes and every other thread keep today's screen, as does a home thread on
 * an environment with the Squire switch off, where it lists as an ordinary thread.
 */
export function resolveThreadRouteControls(input: {
  readonly squire: EnvironmentThreadShell["squire"];
  readonly squireSupported: boolean;
}): ThreadRouteControls | undefined {
  return input.squire?.role === "home" && input.squireSupported
    ? SQUIRE_THREAD_CONTROLS
    : undefined;
}

export type ThreadRouteHeaderAction =
  | { readonly kind: "decisions"; readonly label: string }
  | { readonly kind: "fork"; readonly label: string }
  | {
      readonly kind: "track" | "untrack";
      readonly label: string;
      readonly squireId: string;
    };

/** The thread actions both platforms offer, in menu order, less what `controls` leaves out. */
/**
 * The Squire whose home this thread is, as plain hook arguments (both null otherwise), so the
 * route screen calls its entry hook without optional chains React Compiler cannot lower.
 */
export function homeSquireRef(
  thread: Pick<EnvironmentThreadShell, "environmentId" | "squire"> | null,
): {
  readonly environmentId: EnvironmentThreadShell["environmentId"] | null;
  readonly squireId: NonNullable<EnvironmentThreadShell["squire"]>["squireId"] | null;
} {
  const marker = thread === null ? undefined : thread.squire;
  if (thread === null || marker === undefined || marker.role !== "home") {
    return { environmentId: null, squireId: null };
  }
  return { environmentId: thread.environmentId, squireId: marker.squireId };
}

export function threadRouteHeaderActions(input: {
  readonly controls: ThreadRouteControls | undefined;
  readonly decisionsSupported: boolean;
  readonly forkSupported: boolean;
  readonly tracking: ReadonlyArray<{
    readonly kind: "track" | "untrack";
    readonly label: string;
    readonly squireId: string;
  }>;
}): ReadonlyArray<ThreadRouteHeaderAction> {
  if (!allowsThreadRouteControl(input.controls, "thread-actions")) return [];
  const allows = (control: ThreadRouteControl) => allowsThreadRouteControl(input.controls, control);
  return [
    ...(input.decisionsSupported && allows("decisions")
      ? [{ kind: "decisions" as const, label: "Decisions" }]
      : []),
    ...(input.forkSupported && allows("fork")
      ? [{ kind: "fork" as const, label: "Fork thread" }]
      : []),
    ...(allows("squire-tracking") ? input.tracking : []),
  ];
}

/**
 * Lecturn: a Squire's home thread prompts with what it is for, as the web composer does.
 * Null is any other thread, or a Squire the snapshot does not list yet.
 */
export function squireComposerPlaceholder(
  squire: { readonly name: string; readonly role: "lead" | "squire" } | null,
): string | null {
  if (squire === null) return null;
  return squire.role === "lead"
    ? "Ask the Lead to route a task or check on your Squires…"
    : `Ask ${squire.name} about anything it watches…`;
}

import type { ThreadEnvMode } from "@lecturn/contracts";

/**
 * Canonical priority order for a project's default thread env mode:
 * forced mode > per-project setting > checked-in lecturn.json > global server setting.
 *
 * `forcedMode` is set when the project's environment dictates the mode (for
 * example a Stave space, whose repos are already worktrees) and the user must
 * not be offered a different default.
 *
 * An explicit composer pick outranks all of these; callers apply it before
 * consulting the defaults. Web resolves the sources imperatively at draft
 * creation, mobile reactively — both must route through this function so the
 * platforms cannot disagree on the order.
 */
export function resolveDefaultThreadEnvMode(sources: {
  readonly forcedMode?: ThreadEnvMode | null | undefined;
  readonly projectSetting: ThreadEnvMode | null | undefined;
  readonly projectFile: ThreadEnvMode | null | undefined;
  readonly globalDefault: ThreadEnvMode;
}): ThreadEnvMode {
  return (
    sources.forcedMode ?? sources.projectSetting ?? sources.projectFile ?? sources.globalDefault
  );
}

/**
 * True once the resolved default can no longer change: an explicit pick, a
 * forced mode, or a source that outranks lecturn.json decided, or the file read
 * settled. While false, nothing may persist the provisional default (for
 * example into a draft's workspace selection) — it could differ from the
 * final value.
 */
export function isDefaultThreadEnvModeSettled(sources: {
  readonly explicitMode: ThreadEnvMode | undefined;
  readonly forcedMode?: ThreadEnvMode | null | undefined;
  readonly projectSetting: ThreadEnvMode | null | undefined;
  readonly projectFilePending: boolean;
}): boolean {
  return (
    sources.explicitMode !== undefined ||
    sources.forcedMode != null ||
    sources.projectSetting != null ||
    !sources.projectFilePending
  );
}

import type { ThreadEnvMode } from "@lecturn/contracts";

/**
 * Default thread env mode priority: forced mode (e.g. a Stave space, whose repos are already
 * worktrees) > per-project setting > checked-in lecturn.json > global server setting. Callers
 * apply an explicit composer pick first. Web and mobile both route through here so the platforms
 * cannot disagree on the order.
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
 * True once the resolved default can no longer change: an explicit pick, a forced mode, or a
 * source that outranks lecturn.json decided, or the file read settled. While false, nothing may
 * persist the provisional default (e.g. into a draft's workspace selection).
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

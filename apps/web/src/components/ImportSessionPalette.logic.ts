import type {
  ExternalSessionImportFailure,
  ExternalSessionOrigin,
  ExternalSessionSummary,
  ModelSelection,
  ProviderInstanceId,
  ServerProvider,
} from "@lecturn/contracts";

import { normalizeProjectPathForComparison } from "../lib/projectPaths";
import { getDefaultProviderInstanceModel } from "../providerInstances";

/** Marks the palette view whose groups are swapped for the live session list. */
export const IMPORT_SESSION_VIEW_VALUE = "import-session";
/** Marks the add-project view whose groups are swapped for the live folder list. */
export const IMPORT_FOLDER_VIEW_VALUE = "import-folder";
/** Per-instance page size: the contract's maximum, fetched once and filtered client-side. */
export const IMPORT_SESSION_LIST_LIMIT = 100;

export const IMPORT_SESSION_COST_NOTE =
  "The first message re-reads the whole session, so large sessions use more of your plan.";
export const IMPORT_SESSION_TRUNCATED_NOTE = `Showing the ${IMPORT_SESSION_LIST_LIMIT} most recent sessions per provider.`;
export const IMPORT_FOLDERS_TRUNCATED_NOTE = `Showing folders from the ${IMPORT_SESSION_LIST_LIMIT} most recent sessions per provider.`;
export const IMPORT_SESSION_UNMATCHED_FOLDER_REASON = "Add this folder as a project to import";
/** A project's list also holds sessions from its git worktrees, which Lecturn may not manage. */
export const IMPORT_SESSION_OTHER_FOLDER_REASON = "This session ran in a different folder";

/**
 * Provider instances whose sessions can be imported in an environment. Imports
 * run on a fork, so the environment's `threadForking` capability gates every
 * instance; unknown `externalSessions` values read as unsupported.
 */
export function listImportCapableProviders(input: {
  readonly supportsForking: boolean;
  readonly providers: ReadonlyArray<ServerProvider>;
}): ReadonlyArray<ServerProvider> {
  if (!input.supportsForking) return [];
  return input.providers.filter(
    (provider) =>
      provider.externalSessions === "supported" &&
      provider.enabled &&
      provider.availability !== "unavailable",
  );
}

export type ExternalSessionsInstanceResult =
  | {
      readonly providerInstanceId: ProviderInstanceId;
      readonly ok: true;
      readonly sessions: ReadonlyArray<ExternalSessionSummary>;
      readonly truncated: boolean;
    }
  | { readonly providerInstanceId: ProviderInstanceId; readonly ok: false };

/** One list across instances, newest first. A failed instance never hides the rest. */
export function mergeExternalSessionResults(
  results: ReadonlyArray<ExternalSessionsInstanceResult>,
): {
  readonly sessions: ReadonlyArray<ExternalSessionSummary>;
  readonly truncated: boolean;
  readonly failedInstanceIds: ReadonlyArray<ProviderInstanceId>;
} {
  const sessions = results
    .flatMap((result) => (result.ok ? result.sessions : []))
    .toSorted(
      (left, right) =>
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
        left.sessionId.localeCompare(right.sessionId),
    );
  return {
    sessions,
    truncated: results.some((result) => result.ok && result.truncated),
    failedInstanceIds: results.flatMap((result) => (result.ok ? [] : [result.providerInstanceId])),
  };
}

interface ImportTargetProject {
  readonly id: string;
  readonly workspaceRoot: string;
}

export type ImportTarget<TProject extends ImportTargetProject> =
  | {
      readonly kind: "importable";
      readonly project: TProject;
      readonly worktreePath: string | null;
      readonly branch: string | null;
    }
  | { readonly kind: "blocked"; readonly reason: string };

/**
 * Resolves where a session lands, by its cwd. A cwd that is a project root
 * imports there; a cwd that is a known thread worktree imports into that
 * thread's project, on the worktree. Any other cwd blocks the import with
 * `unmatchedReason`: a thread never runs in a folder other than the session's,
 * nor in one Lecturn does not already manage. `projects` and `threads` must
 * belong to the environment the sessions were listed from. Paths are indexed
 * once so resolving a long list stays linear.
 */
export function createImportTargetResolver<TProject extends ImportTargetProject>(input: {
  readonly projects: ReadonlyArray<TProject>;
  readonly threads: ReadonlyArray<{
    readonly projectId: string;
    readonly worktreePath: string | null;
    readonly branch: string | null;
  }>;
  readonly unmatchedReason: string;
}): (sessionCwd: string) => ImportTarget<TProject> {
  const projectById = new Map(input.projects.map((project) => [project.id, project] as const));
  const targetByPath = new Map<string, ImportTarget<TProject>>();
  // Worktrees first so a project root registered at the same path wins.
  for (const thread of input.threads) {
    const project = projectById.get(thread.projectId);
    if (thread.worktreePath === null || project === undefined) continue;
    targetByPath.set(normalizeProjectPathForComparison(thread.worktreePath), {
      kind: "importable",
      project,
      worktreePath: thread.worktreePath,
      branch: thread.branch,
    });
  }
  for (const project of input.projects) {
    targetByPath.set(normalizeProjectPathForComparison(project.workspaceRoot), {
      kind: "importable",
      project,
      worktreePath: null,
      branch: null,
    });
  }
  const blocked: ImportTarget<TProject> = { kind: "blocked", reason: input.unmatchedReason };
  return (sessionCwd) => targetByPath.get(normalizeProjectPathForComparison(sessionCwd)) ?? blocked;
}

/** Whether a row should name its folder: the session ran somewhere other than the scoped project's root. */
export function sessionRanOutsideFolder(sessionCwd: string, folder: string): boolean {
  return (
    normalizeProjectPathForComparison(sessionCwd) !== normalizeProjectPathForComparison(folder)
  );
}

/** Session ids that already back a thread. Re-importing stays allowed: each import is its own fork. */
export function collectImportedSessionIds(
  threads: ReadonlyArray<{
    readonly importedFrom?: { readonly sessionId: string } | null | undefined;
  }>,
): ReadonlySet<string> {
  return new Set(
    threads.flatMap((thread) => (thread.importedFrom ? [thread.importedFrom.sessionId] : [])),
  );
}

export function externalSessionTitle(
  session: Pick<ExternalSessionSummary, "title" | "firstPrompt">,
): string {
  return session.title || session.firstPrompt || "Untitled session";
}

export function externalSessionSearchTerms(
  session: Pick<ExternalSessionSummary, "title" | "firstPrompt" | "gitBranch">,
): ReadonlyArray<string> {
  return [session.title, session.firstPrompt ?? "", session.gitBranch ?? ""];
}

export function externalSessionOriginLabel(
  origin: ExternalSessionOrigin | undefined,
): string | null {
  switch (origin) {
    case "cli":
      return "CLI";
    case "desktop":
      return "Desktop app";
    case "ide":
      return "IDE";
    default:
      return null;
  }
}

export function formatSessionSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 ** 2) return `${Math.round(sizeBytes / 1024)} KB`;
  if (sizeBytes < 1024 ** 3) return `${(sizeBytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(sizeBytes / 1024 ** 3).toFixed(1)} GB`;
}

/** Text parts of a row's metadata line, after the provider and before the branch. */
export function externalSessionMetadataParts(input: {
  readonly origin: ExternalSessionOrigin | undefined;
  readonly updatedLabel: string | null;
  readonly sizeBytes: number | undefined;
  readonly imported: boolean;
}): ReadonlyArray<string> {
  const originLabel = externalSessionOriginLabel(input.origin);
  return [
    ...(originLabel ? [originLabel] : []),
    ...(input.updatedLabel ? [input.updatedLabel] : []),
    ...(input.sizeBytes === undefined ? [] : [formatSessionSize(input.sizeBytes)]),
    ...(input.imported ? ["Imported"] : []),
  ];
}

export function threadImportFailureMessage(reason: ExternalSessionImportFailure): string {
  switch (reason) {
    case "forking-disabled":
      return "Update the Lecturn server on this environment to import sessions.";
    case "provider-unsupported":
      return "This provider cannot import sessions created outside Lecturn.";
    case "provider-unavailable":
      return "That provider is disabled or no longer configured.";
    case "session-not-found":
      return "That session no longer exists.";
    case "unreadable":
      return "That session could not be read.";
    case "empty-session":
      return "That session has no messages to import.";
  }
}

/**
 * The model an imported thread starts on. The session fixes the instance, so
 * the usual new-thread sources apply only when they already target it: the
 * project's default, then the last model picked for that instance, then the
 * instance's own default.
 */
export function resolveImportModelSelection(input: {
  readonly instanceId: ProviderInstanceId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly projectDefault: ModelSelection | null | undefined;
  readonly stickySelection: ModelSelection | null | undefined;
}): ModelSelection | null {
  for (const candidate of [input.projectDefault, input.stickySelection]) {
    if (candidate?.instanceId === input.instanceId) return candidate;
  }
  const model = getDefaultProviderInstanceModel(input.providers, input.instanceId);
  return model ? { instanceId: input.instanceId, model } : null;
}

/**
 * Pure rules behind the mobile "Import session" picker: which provider
 * instances can offer sessions, how their lists merge, where a session's cwd
 * lands, how a row reads, and how a refused import reads.
 *
 * Ported from the web palette (`apps/web/src/components/ImportSessionPalette.logic.ts`);
 * the feed-side twins live in `../../lib/threadActivity` (`importSourceLabel`,
 * `resolveImportDivider`, `shouldShowImportTruncatedNote`), ported from
 * `apps/web/src/components/ChatView.logic.ts`. Each pair is a deliberate
 * duplicate until one of them needs to change again, at which point the shared
 * half belongs in `@lecturn/client-runtime`.
 */
import type {
  ExternalSessionImportFailure,
  ExternalSessionOrigin,
  ExternalSessionSummary,
  ModelSelection,
  ProviderInstanceId,
  ProviderInteractionMode,
  RuntimeMode,
  ServerProvider,
} from "@lecturn/contracts";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EXTERNAL_SESSIONS_LIST_MAX_LIMIT,
} from "@lecturn/contracts";
import { normalizeProjectPathForComparison } from "@lecturn/shared/path";

import type { ModelOption } from "../../lib/modelOptions";

/** Per-instance page size: the contract's maximum, fetched once and filtered on device. */
export const IMPORT_SESSION_LIST_LIMIT = EXTERNAL_SESSIONS_LIST_MAX_LIMIT;

export const IMPORT_SESSION_COST_NOTE =
  "The first message re-reads the whole session, so large sessions use more of your plan.";
export const IMPORT_SESSION_TRUNCATED_NOTE = `Showing the ${IMPORT_SESSION_LIST_LIMIT} most recent sessions per provider.`;
export const IMPORT_SESSION_UNMATCHED_FOLDER_REASON = "Add this folder as a project to import";
/** A project's list also holds sessions from its git worktrees, which Lecturn may not manage. */
export const IMPORT_SESSION_OTHER_FOLDER_REASON = "This session ran in a different folder";

export type ThreadImportUnavailableReason =
  | "disconnected"
  | "server-unsupported"
  | "provider-unsupported";

export type ThreadImportAvailability =
  | { readonly available: true; readonly providers: ReadonlyArray<ServerProvider> }
  | { readonly available: false; readonly reason: ThreadImportUnavailableReason };

/**
 * Whether an environment can offer sessions to import, and from which
 * instances. Imports run on a fork, so the environment's `threadForking`
 * capability gates every instance; cached capabilities lie while offline, and
 * unknown `externalSessions` values read as unsupported.
 */
export function resolveThreadImportAvailability(input: {
  readonly connected: boolean;
  readonly serverSupportsForking: boolean;
  readonly providers: ReadonlyArray<ServerProvider>;
}): ThreadImportAvailability {
  if (!input.connected) return { available: false, reason: "disconnected" };
  if (!input.serverSupportsForking) return { available: false, reason: "server-unsupported" };
  const providers = input.providers.filter(
    (provider) =>
      provider.externalSessions === "supported" &&
      provider.enabled &&
      provider.availability !== "unavailable",
  );
  if (providers.length === 0) return { available: false, reason: "provider-unsupported" };
  return { available: true, providers };
}

export const THREAD_IMPORT_UNAVAILABLE_MESSAGES: Record<ThreadImportUnavailableReason, string> = {
  disconnected: "This environment is offline. Reconnect to import a session.",
  "server-unsupported":
    "This environment's server does not support importing yet. Update the server to import sessions.",
  "provider-unsupported":
    "No agent on this environment can import sessions created outside Lecturn.",
};

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

/**
 * Client-side filter for the picker's search field. Each provider list costs a
 * server-side process spawn, so the screen fetches once and narrows here
 * rather than re-querying per keystroke.
 */
export function filterExternalSessions<
  TSession extends Pick<ExternalSessionSummary, "title" | "firstPrompt" | "gitBranch" | "cwd">,
>(sessions: ReadonlyArray<TSession>, searchQuery: string): ReadonlyArray<TSession> {
  const query = searchQuery.trim().toLocaleLowerCase();
  if (query.length === 0) return sessions;
  return sessions.filter((session) =>
    [session.title, session.firstPrompt, session.gitBranch, session.cwd].some((term) =>
      term?.toLocaleLowerCase().includes(query),
    ),
  );
}

/**
 * Narrows rows the picker has already built, by the same terms
 * `filterExternalSessions` reads. Returns the rows themselves rather than
 * rebuilding them, so typing never re-identifies a row the list has rendered
 * and never re-resolves where its session would import.
 */
export function filterSessionRows<
  TRow extends {
    readonly session: Pick<ExternalSessionSummary, "title" | "firstPrompt" | "gitBranch" | "cwd">;
  },
>(rows: ReadonlyArray<TRow>, searchQuery: string): ReadonlyArray<TRow> {
  if (searchQuery.trim().length === 0) return rows;
  const matches = new Set(
    filterExternalSessions(
      rows.map((row) => row.session),
      searchQuery,
    ),
  );
  return rows.filter((row) => matches.has(row.session));
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

/**
 * The row's metadata line, in order, for the caller to join with a separator.
 * Absent pieces drop out rather than rendering a placeholder, so a sparse
 * session still reads as one clean line.
 */
export function externalSessionMetadataParts(input: {
  readonly providerLabel: string;
  readonly origin: ExternalSessionOrigin | undefined;
  readonly updatedLabel: string | null;
  readonly sizeBytes: number | undefined;
  readonly imported: boolean;
  readonly gitBranch: string | null;
  /** The session's cwd, when it differs from the folder the picker is scoped to. */
  readonly folder: string | null;
}): ReadonlyArray<string> {
  const originLabel = externalSessionOriginLabel(input.origin);
  return [
    input.providerLabel,
    ...(originLabel === null ? [] : [originLabel]),
    ...(input.updatedLabel === null ? [] : [input.updatedLabel]),
    ...(input.sizeBytes === undefined ? [] : [formatSessionSize(input.sizeBytes)]),
    ...(input.imported ? ["Imported"] : []),
    ...(input.gitBranch === null ? [] : [input.gitBranch]),
    ...(input.folder === null ? [] : [input.folder]),
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
 * the usual new-thread sources (see `resolveNewTaskModelSelection`) apply only
 * when they already target it; otherwise the instance's own default model
 * wins. Null means the instance offers nothing startable and the import must
 * not dispatch.
 */
export function resolveImportModelSelection(input: {
  readonly instanceId: ProviderInstanceId;
  readonly modelOptions: ReadonlyArray<ModelOption>;
  readonly projectDefault: ModelSelection | null;
  readonly stickySelection: ModelSelection | null;
}): ModelSelection | null {
  for (const candidate of [input.projectDefault, input.stickySelection]) {
    if (candidate?.instanceId === input.instanceId) return candidate;
  }
  const forInstance = input.modelOptions.filter(
    (option) => option.providerKey === input.instanceId && option.isUnavailable !== true,
  );
  return (
    forInstance.find((option) => option.isDefault && !option.isLegacy)?.selection ??
    forInstance.find((option) => !option.isLegacy)?.selection ??
    forInstance[0]?.selection ??
    null
  );
}

/**
 * The permission and interaction modes an imported thread starts on. The
 * import shares the new task's toolbar, so it resolves them the way that
 * screen's send path does: the draft's own choice first, the flow's current
 * selection behind it, and Plan only while the flow offers the toggle. The
 * contract defaults are the last resort, not the starting point.
 */
export function resolveImportThreadModes(input: {
  readonly draftRuntimeMode: RuntimeMode | null | undefined;
  readonly flowRuntimeMode: RuntimeMode | null | undefined;
  readonly draftInteractionMode: ProviderInteractionMode | null | undefined;
  readonly flowInteractionMode: ProviderInteractionMode | null | undefined;
  readonly planModeEnabled: boolean;
}): {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
} {
  return {
    runtimeMode: input.draftRuntimeMode ?? input.flowRuntimeMode ?? DEFAULT_RUNTIME_MODE,
    interactionMode: input.planModeEnabled
      ? (input.draftInteractionMode ??
        input.flowInteractionMode ??
        DEFAULT_PROVIDER_INTERACTION_MODE)
      : DEFAULT_PROVIDER_INTERACTION_MODE,
  };
}

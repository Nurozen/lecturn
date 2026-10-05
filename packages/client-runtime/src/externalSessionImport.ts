/**
 * Shared rules behind the "import a folder's agent sessions" flows on web and
 * mobile: the entry labels, grouping a machine-wide session list into folders,
 * which sessions start selected, and importing a selection one at a time.
 * Clients own the listing (one `externalSessions.list` per import-capable
 * instance) and the single-session import dispatch; this module never talks
 * to the server.
 */
import type {
  ExternalSessionSummary,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@lecturn/contracts";

import { inferProjectTitleFromPath, normalizeProjectPathForComparison } from "./state/projects.ts";

/** Sessions updated within this window start selected in the multi-select import. */
export const RECENT_SESSION_SELECTION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export const IMPORT_FOLDER_SOURCE_DESCRIPTION =
  "Add a folder you've used with an agent and import its sessions";

const SOURCE_NAME_BY_DRIVER_KIND: Readonly<Record<string, string>> = {
  claudeAgent: "Claude Code",
  codex: "Codex",
};

/** Product names of the tools whose sessions can be imported, in a stable order. */
function importSourceNames(driverKinds: ReadonlyArray<ProviderDriverKind>): ReadonlyArray<string> {
  const kinds = new Set<string>(driverKinds);
  return Object.entries(SOURCE_NAME_BY_DRIVER_KIND).flatMap(([kind, name]) =>
    kinds.has(kind) ? [name] : [],
  );
}

function joinSourceNames(names: ReadonlyArray<string>): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return names[0] ?? null;
  return `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}

/** The start-screen link, named after the import-capable drivers ("Continue a Codex session"). */
export function continueSessionLinkLabel(driverKinds: ReadonlyArray<ProviderDriverKind>): string {
  const names = joinSourceNames(importSourceNames(driverKinds));
  return names === null ? "Continue an agent session" : `Continue a ${names} session`;
}

/** The add-project source title ("From Claude Code or Codex"). */
export function importFolderSourceLabel(driverKinds: ReadonlyArray<ProviderDriverKind>): string {
  const names = joinSourceNames(importSourceNames(driverKinds));
  return names === null ? "From agent sessions" : `From ${names}`;
}

/** Identifies a session across instances: two instances may reuse a native id. */
export function externalSessionKey(
  session: Pick<ExternalSessionSummary, "providerInstanceId" | "sessionId">,
): string {
  return `${session.providerInstanceId}:${session.sessionId}`;
}

function newestFirst(
  left: Pick<ExternalSessionSummary, "updatedAt" | "sessionId">,
  right: Pick<ExternalSessionSummary, "updatedAt" | "sessionId">,
): number {
  return (
    Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
    left.sessionId.localeCompare(right.sessionId)
  );
}

export interface ExternalSessionFolderProviderCount {
  readonly providerInstanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly count: number;
}

export interface ExternalSessionFolder<TProject> {
  /** The folder as the newest session reported it. */
  readonly cwd: string;
  readonly name: string;
  readonly latestUpdatedAt: string;
  readonly sessionCount: number;
  /** Most sessions first. */
  readonly providerCounts: ReadonlyArray<ExternalSessionFolderProviderCount>;
  /** The project already rooted at this folder, if any. */
  readonly project: TProject | null;
}

/**
 * Groups sessions by the folder they ran in, newest activity first. Every
 * distinct cwd is its own folder, so a git worktree is listed apart from its
 * main checkout. `projects` must belong to the environment the sessions were
 * listed from.
 */
export function groupExternalSessionsByFolder<
  TProject extends { readonly workspaceRoot: string },
>(input: {
  readonly sessions: ReadonlyArray<ExternalSessionSummary>;
  readonly projects: ReadonlyArray<TProject>;
}): ReadonlyArray<ExternalSessionFolder<TProject>> {
  const projectByPath = new Map(
    input.projects.map(
      (project) => [normalizeProjectPathForComparison(project.workspaceRoot), project] as const,
    ),
  );
  const sessionsByPath = new Map<string, Array<ExternalSessionSummary>>();
  for (const session of input.sessions) {
    const path = normalizeProjectPathForComparison(session.cwd);
    if (path.length === 0) continue;
    const bucket = sessionsByPath.get(path);
    if (bucket) bucket.push(session);
    else sessionsByPath.set(path, [session]);
  }
  const folders = [...sessionsByPath].map(([path, sessions]) => {
    const sorted = sessions.toSorted(newestFirst);
    const newest = sorted[0]!;
    const countByInstance = new Map<ProviderInstanceId, ExternalSessionFolderProviderCount>();
    for (const session of sorted) {
      const current = countByInstance.get(session.providerInstanceId);
      countByInstance.set(session.providerInstanceId, {
        providerInstanceId: session.providerInstanceId,
        driverKind: session.driverKind,
        count: (current?.count ?? 0) + 1,
      });
    }
    return {
      cwd: newest.cwd,
      name: inferProjectTitleFromPath(newest.cwd),
      latestUpdatedAt: newest.updatedAt,
      sessionCount: sorted.length,
      providerCounts: [...countByInstance.values()].toSorted(
        (left, right) =>
          right.count - left.count ||
          left.providerInstanceId.localeCompare(right.providerInstanceId),
      ),
      project: projectByPath.get(path) ?? null,
    } satisfies ExternalSessionFolder<TProject>;
  });
  return folders.toSorted(
    (left, right) =>
      Date.parse(right.latestUpdatedAt) - Date.parse(left.latestUpdatedAt) ||
      left.cwd.localeCompare(right.cwd),
  );
}

/**
 * The sessions that ran exactly in `folder`, newest first. A folder-scoped
 * listing can also return sessions from the folder's git worktrees; those are
 * folders of their own.
 */
export function sessionsInFolder<TSession extends ExternalSessionSummary>(
  sessions: ReadonlyArray<TSession>,
  folder: string,
): ReadonlyArray<TSession> {
  const path = normalizeProjectPathForComparison(folder);
  return sessions
    .filter((session) => normalizeProjectPathForComparison(session.cwd) === path)
    .toSorted(newestFirst);
}

/**
 * Keys of the sessions that start selected: updated within the recent window
 * and not already imported. `importedSessionIds` holds provider-native ids, as
 * thread `importedFrom` records them.
 */
export function defaultImportSelection(input: {
  readonly sessions: ReadonlyArray<ExternalSessionSummary>;
  readonly importedSessionIds: ReadonlySet<string>;
  readonly now: number;
  readonly windowMs?: number;
}): ReadonlySet<string> {
  const cutoff = input.now - (input.windowMs ?? RECENT_SESSION_SELECTION_WINDOW_MS);
  return new Set(
    input.sessions.flatMap((session) =>
      !input.importedSessionIds.has(session.sessionId) && Date.parse(session.updatedAt) >= cutoff
        ? [externalSessionKey(session)]
        : [],
    ),
  );
}

export type ExternalSessionImportAttempt<TResult> =
  | { readonly ok: true; readonly value: TResult }
  | { readonly ok: false; readonly message: string };

export interface BulkImportResult<TSession, TResult> {
  readonly imported: ReadonlyArray<{ readonly session: TSession; readonly value: TResult }>;
  readonly failed: ReadonlyArray<{ readonly session: TSession; readonly message: string }>;
}

/**
 * Imports `sessions` one at a time, in order, through the client's single
 * import path. A failed or throwing import is recorded and the run moves on,
 * so one unreadable session never strands the rest. `onProgress` fires before
 * each import with its 1-based position.
 */
export async function importSessionsSequentially<TSession, TResult>(input: {
  readonly sessions: ReadonlyArray<TSession>;
  readonly importSession: (session: TSession) => Promise<ExternalSessionImportAttempt<TResult>>;
  readonly onProgress?: (progress: { readonly position: number; readonly total: number }) => void;
}): Promise<BulkImportResult<TSession, TResult>> {
  const imported: Array<{ session: TSession; value: TResult }> = [];
  const failed: Array<{ session: TSession; message: string }> = [];
  const total = input.sessions.length;
  for (const [index, session] of input.sessions.entries()) {
    input.onProgress?.({ position: index + 1, total });
    try {
      const attempt = await input.importSession(session);
      if (attempt.ok) imported.push({ session, value: attempt.value });
      else failed.push({ session, message: attempt.message });
    } catch (error) {
      failed.push({
        session,
        message:
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "The session could not be imported.",
      });
    }
  }
  return { imported, failed };
}

export function bulkImportProgressLabel(progress: {
  readonly position: number;
  readonly total: number;
}): string {
  return `Importing ${progress.position} of ${progress.total}…`;
}

export function importSessionsActionLabel(count: number): string {
  return count === 1 ? "Import 1 session" : `Import ${count} sessions`;
}

/** One-line outcome of a bulk import; failures are listed separately by the caller. */
export function bulkImportSummary(result: {
  readonly imported: ReadonlyArray<unknown>;
  readonly failed: ReadonlyArray<unknown>;
}): { readonly title: string; readonly description: string | null } {
  const importedCount = result.imported.length;
  const failedCount = result.failed.length;
  const total = importedCount + failedCount;
  const sessions = (count: number) => (count === 1 ? "session" : "sessions");
  if (failedCount === 0) {
    return { title: `Imported ${importedCount} ${sessions(importedCount)}`, description: null };
  }
  const couldNot = `${failedCount} ${sessions(failedCount)} could not be imported.`;
  if (importedCount === 0) {
    return { title: "Could not import sessions", description: couldNot };
  }
  return {
    title: `Imported ${importedCount} of ${total} ${sessions(total)}`,
    description: couldNot,
  };
}

/** The imported thread to open after a bulk import: the one whose session saw the latest activity. */
export function latestImported<
  TSession extends Pick<ExternalSessionSummary, "updatedAt" | "sessionId">,
  TResult,
>(
  imported: ReadonlyArray<{ readonly session: TSession; readonly value: TResult }>,
): TResult | null {
  return (
    imported.toSorted((left, right) => newestFirst(left.session, right.session))[0]?.value ?? null
  );
}

import type { EnvironmentId, ProjectId } from "@lecturn/contracts";

/**
 * Bus between the command palette's "From Claude Code or Codex" add-project
 * source and the multi-select import dialog mounted in `__root.tsx`, on the
 * `staveWizard.ts` pattern: module state and a change listener set.
 */

export interface ImportFolderSessionsRequest {
  readonly environmentId: EnvironmentId;
  /** The project rooted at `folder`, already added. */
  readonly projectId: ProjectId;
  readonly folder: string;
}

let request: ImportFolderSessionsRequest | null = null;
const listeners = new Set<() => void>();

function publish(next: ImportFolderSessionsRequest | null): void {
  request = next;
  for (const listener of listeners) {
    listener();
  }
}

export function readImportFolderSessionsRequest(): ImportFolderSessionsRequest | null {
  return request;
}

export function subscribeImportFolderSessions(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Opens the dialog for `next`; a request while one is open replaces it. */
export function openImportFolderSessions(next: ImportFolderSessionsRequest): void {
  publish(next);
}

export function closeImportFolderSessions(): void {
  if (request === null) return;
  publish(null);
}

import type { AppStatus } from "@lecturn/contracts/apps";

// Mirrors AppEmbedTarget in @lecturn/contracts. The token travels in the url hash or over the
// bridge, never in what the server sees.
export interface EmbedTarget {
  readonly url: string;
  readonly token: string;
  readonly expiresAt: string;
}

// For hosts whose `connect()` runs elsewhere (a child process) or that mint targets themselves.
export interface EmbedTargetSource {
  embedTarget(projectId: string, threadId?: string): Promise<EmbedTarget>;
}

export type ConnectionMode = "user-server" | "sidecar";
export type ConnectionPairing = "none" | "pending" | "denied";

export interface ConnectionStatusEvent {
  readonly type: "status";
  readonly mode: ConnectionMode;
  readonly pairing: ConnectionPairing;
  readonly app: AppStatus | null;
}

/**
 * The connection moved to another server. Project and thread ids differ
 * per server: hosts look their workspaces up by root, and their open threads
 * through `threadIdMap` (old server's id to the new one's).
 */
export interface ConnectionModeEvent {
  readonly type: "mode";
  readonly mode: ConnectionMode;
  readonly environmentId: string;
  readonly projectIdsByWorkspaceRoot: Readonly<Record<string, string>>;
  readonly threadIdMap: Readonly<Record<string, string>>;
}

export type ConnectionEvent = ConnectionStatusEvent | ConnectionModeEvent;

export interface ConnectionStatus {
  readonly current: ConnectionStatusEvent;
  /** Called at once with `current`, then on every change. */
  subscribe(listener: (event: ConnectionEvent) => void): () => void;
}

// What a LecturnConnection offers a mount: refreshes mint without a thread.
export interface EmbedConnectionSource extends EmbedTargetSource {
  refreshEmbedToken(projectId: string): Promise<EmbedTarget>;
  /** Present on a LecturnConnection; a mount built from one follows its `mode` events. */
  readonly status?: ConnectionStatus;
  /** The workspace a project id from any server this connection used belongs to. */
  workspaceRootOf?(projectId: string): string | null;
}

/**
 * Keeps a mount on the same workspace and thread across a server switch. A
 * thread with no counterpart on the new server (made after the last copy)
 * leaves the mount on its project. An unchanged project id is the sidecar
 * started again on another port, which needs the reload all the same.
 */
export function followConnectionMode(
  source: EmbedConnectionSource,
  current: () => { readonly projectId: string; readonly threadId: string | undefined },
  retarget: (projectId: string, threadId: string | undefined) => void,
): () => void {
  const { status, workspaceRootOf } = source;
  if (status === undefined || workspaceRootOf === undefined) return () => undefined;
  return status.subscribe((event) => {
    if (event.type !== "mode") return;
    const { projectId, threadId } = current();
    const root = workspaceRootOf.call(source, projectId);
    const nextProjectId = root === null ? undefined : event.projectIdsByWorkspaceRoot[root];
    if (nextProjectId === undefined) return;
    retarget(nextProjectId, threadId === undefined ? undefined : event.threadIdMap[threadId]);
  });
}

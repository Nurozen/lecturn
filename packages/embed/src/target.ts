// Mirrors AppEmbedTarget (I1). The token travels in the url hash or over the
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

// What a LecturnConnection offers a mount: refreshes mint without a thread.
export interface EmbedConnectionSource extends EmbedTargetSource {
  refreshEmbedToken(projectId: string): Promise<EmbedTarget>;
}

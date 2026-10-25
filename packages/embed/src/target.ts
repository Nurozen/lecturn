// Mirrors AppEmbedTarget (I1). The token travels over the bridge, never in the url.
export interface EmbedTarget {
  readonly url: string;
  readonly token: string;
  readonly expiresAt: string;
}

// Satisfied by LecturnConnection (plan A18) or by a host that mints targets itself.
export interface EmbedTargetSource {
  embedTarget(projectId: string, threadId?: string): Promise<EmbedTarget>;
}

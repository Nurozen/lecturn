export type EmbedViewErrorReason =
  | "debugger-unavailable"
  | "guest-gone"
  | "renderer-gone"
  | "stale-capture"
  | "capture-failed"
  | "load-failed"
  | "message-too-large"
  | "bridge-message-rejected"
  | "token-refresh-failed";

export class EmbedViewError extends Error {
  override readonly name = "EmbedViewError";
  readonly reason: EmbedViewErrorReason;

  constructor(
    reason: EmbedViewErrorReason,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.reason = reason;
  }
}

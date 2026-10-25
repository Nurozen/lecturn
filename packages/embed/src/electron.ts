export { EMBED_TO_GUEST_CHANNEL } from "./channels.ts";
export { captureEmbedView } from "./electron/capture.ts";
export type { CapturableEmbedView, CaptureEmbedViewOptions } from "./electron/capture.ts";
export { EmbedViewError } from "./electron/errors.ts";
export type { EmbedViewErrorReason } from "./electron/errors.ts";
export { mountEmbedView } from "./electron/mountEmbedView.ts";
export type {
  EmbedBridge,
  EmbedDebuggerSession,
  EmbedWebPreferences,
  MountEmbedViewOptions,
} from "./electron/mountEmbedView.ts";
export type { EmbedTarget, EmbedTargetSource } from "./target.ts";

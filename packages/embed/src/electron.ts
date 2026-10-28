export { EMBED_TO_GUEST_CHANNEL } from "./channels.ts";
export { captureEmbedView } from "./electron/capture.ts";
export type { CapturableEmbedView, CaptureEmbedViewOptions } from "./electron/capture.ts";
export { EmbedViewError } from "./electron/errors.ts";
export type { EmbedViewErrorReason } from "./electron/errors.ts";
export type {
  EmbedBridgeEvent,
  EmbedBridgeEvents,
  EmbedDescribeRefs,
  EmbedRefLabels,
  EmbedThemeInput,
} from "./electron/hostBridge.ts";
export { mountEmbedView } from "./electron/mountEmbedView.ts";
export type {
  EmbedBridge,
  EmbedDebuggerSession,
  EmbedWebPreferences,
  MountEmbedViewOptions,
} from "./electron/mountEmbedView.ts";
export type { EmbedConnectionSource, EmbedTarget, EmbedTargetSource } from "./target.ts";

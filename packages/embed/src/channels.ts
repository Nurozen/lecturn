// The fixed IPC namespace (I7) shared by the host renderer, the main process
// and the guest preload.
export const EMBED_IPC_CHANNEL_PREFIX = "lecturn-embed:";
export const EMBED_TO_GUEST_CHANNEL = `${EMBED_IPC_CHANNEL_PREFIX}to-guest`;
export const EMBED_FROM_GUEST_CHANNEL = `${EMBED_IPC_CHANNEL_PREFIX}from-guest`;
export const EMBED_PANE_RECT_CHANNEL = `${EMBED_IPC_CHANNEL_PREFIX}pane-rect`;
export const EMBED_HOST_BRIDGE_CHANNEL = `${EMBED_IPC_CHANNEL_PREFIX}bridge`;

/**
 * The guest's way out: a top-level WebContentsView has no parent window to
 * post to, so the helper preload exposes this in the guest's main world.
 */
export const EMBED_GUEST_HOST_GLOBAL = "lecturnEmbedHost";
/** What a host preload exposes so `@lecturn/embed/renderer` can reach the main process. */
export const EMBED_RENDERER_IPC_GLOBAL = "lecturnEmbedIpc";

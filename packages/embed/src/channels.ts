// The fixed IPC namespace (I7) shared by the host renderer, the main process
// and the guest preload.
export const EMBED_IPC_CHANNEL_PREFIX = "lecturn-embed:";
export const EMBED_TO_GUEST_CHANNEL = `${EMBED_IPC_CHANNEL_PREFIX}to-guest`;

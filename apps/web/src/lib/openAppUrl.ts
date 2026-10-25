/**
 * Opens a connected app at its own URL scheme. Desktop goes through the shell, which may refuse a
 * scheme it does not know; a browser on the server's machine hands the scheme to the OS by
 * navigating to it.
 */
export function openAppUrl(url: string): void {
  const bridge = window.desktopBridge;
  if (bridge !== undefined) {
    void bridge.openExternal(url).catch(() => undefined);
    return;
  }
  window.location.assign(url);
}

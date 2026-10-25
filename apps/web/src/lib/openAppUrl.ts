/**
 * Opens a connected app at its own URL scheme. Desktop goes through `openAppUrl`, which opens
 * only a URL in the scheme of the app's registered template; a browser on the server's machine
 * hands the scheme to the OS by navigating to it.
 */
export function openAppUrl(url: string, openUrlTemplate: string | null): void {
  if (openUrlTemplate === null) return;
  const bridge = window.desktopBridge;
  if (bridge !== undefined) {
    // Shells older than `openAppUrl` can still open an app served over http(s).
    const opened = bridge.openAppUrl?.({ url, openUrlTemplate }) ?? bridge.openExternal(url);
    void opened.catch(() => undefined);
    return;
  }
  window.location.assign(url);
}

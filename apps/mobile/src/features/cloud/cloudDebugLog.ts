export function isCloudDebugEnabled(): boolean {
  return (
    (typeof __DEV__ !== "undefined" && __DEV__) ||
    (typeof globalThis !== "undefined" &&
      (globalThis as { __LECTURN_CLOUD_DEBUG__?: boolean }).__LECTURN_CLOUD_DEBUG__ === true)
  );
}

export function cloudDebugLog(event: string, data?: Record<string, unknown>): void {
  if (!isCloudDebugEnabled()) {
    return;
  }
  if (data) {
    console.log(`[lecturn-cloud] ${event}`, data);
  } else {
    console.log(`[lecturn-cloud] ${event}`);
  }
}

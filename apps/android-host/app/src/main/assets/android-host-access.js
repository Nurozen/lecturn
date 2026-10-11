(() => {
  if (window !== window.top) return;
  const pending = new Map();
  const unavailable = () => ({
    verified: false,
    fullAccess: false,
    computerUse: false,
    revision: null,
    capabilities: { appData: false, computerUse: false },
  });
  const session = Math.random().toString(36).slice(2);
  let next = 0;
  const finish = (id, state) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(state);
  };
  window.__lecturnNative.onmessage = (event) => {
    try {
      const response = JSON.parse(event.data);
      if (response.protocolVersion === 2 && typeof response.requestId === "string")
        finish(response.requestId, response.state ?? unavailable());
    } catch {
      /* Invalid replies never authorize access. */
    }
  };
  const request = (method, threadId, payload) =>
    new Promise((resolve) => {
      if (pending.size >= 16) {
        resolve(unavailable());
        return;
      }
      const requestId = session + "_" + ++next;
      const timer = setTimeout(() => finish(requestId, unavailable()), 90000);
      pending.set(requestId, { resolve, timer });
      try {
        window.__lecturnNative.postMessage(
          JSON.stringify({ protocolVersion: 2, requestId, method, threadId, payload }),
        );
      } catch {
        finish(requestId, unavailable());
      }
    });
  window.addEventListener("pagehide", () => {
    for (const id of pending.keys()) finish(id, unavailable());
  });
  Object.defineProperty(window, "symbaHost", {
    value: Object.freeze({
      protocolVersion: 2,
      getAccessState: () => request("getAccessState"),
      requestFullAccess: (threadId) =>
        typeof threadId === "string" && threadId.trim() && threadId.length <= 256
          ? request("requestFullAccess", threadId)
          : Promise.resolve(unavailable()),
      openDeviceAccess: () => request("openDeviceAccess"),
      publishChatWidget: (payload) =>
        request("publishChatWidget", undefined, payload).then((state) => ({
          published: state.published === true,
        })),
    }),
    writable: false,
    configurable: false,
  });
})();

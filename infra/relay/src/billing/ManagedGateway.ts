/** Server-owned transport state. This snapshot must only enter through a service binding. */
export interface GatewaySnapshot {
  readonly userId: string;
  readonly generation: number;
  readonly accessUntilMs: number | null;
  readonly enabled: boolean;
  readonly guardVerified: boolean;
  readonly environments: ReadonlyArray<{
    readonly environmentId: string;
    readonly publicHostname: string;
    readonly originHostname: string;
  }>;
}

export const GATEWAY_ORIGIN_PATH = "/_lecturn_gateway_origin";
const AUTH_HEADER = "x-lecturn-gateway-auth";
const ORIGIN_HEADER = "x-lecturn-gateway-origin";
const PATH_HEADER = "x-lecturn-gateway-path";
const INTERNAL_HEADERS = [AUTH_HEADER, ORIGIN_HEADER, PATH_HEADER] as const;
const hostnamePattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const normalize = (input: GatewaySnapshot): GatewaySnapshot => {
  if (
    !input.userId ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 0 ||
    (input.accessUntilMs !== null &&
      (!Number.isSafeInteger(input.accessUntilMs) || input.accessUntilMs <= 0))
  ) {
    throw new Error("Invalid gateway snapshot");
  }
  const hosts = new Set<string>();
  const ids = new Set<string>();
  for (const env of input.environments) {
    if (
      !env.environmentId ||
      ids.has(env.environmentId) ||
      hosts.has(env.publicHostname) ||
      !hostnamePattern.test(env.publicHostname) ||
      !hostnamePattern.test(env.originHostname) ||
      env.publicHostname === env.originHostname
    )
      throw new Error("Invalid gateway environment");
    ids.add(env.environmentId);
    hosts.add(env.publicHostname);
  }
  return {
    ...input,
    environments: input.environments
      .map((env) => ({ ...env }))
      .sort((a, b) => a.environmentId.localeCompare(b.environmentId)),
  };
};

interface GatewayStorage {
  load(): Promise<GatewaySnapshot | null>;
  /** Persist the snapshot and its alarm atomically. */
  commit(snapshot: GatewaySnapshot, alarmMs: number | null): Promise<void>;
}
interface GatewayOptions {
  readonly storage: GatewayStorage;
  readonly fetch: typeof fetch;
  readonly secret: string;
  /** A Worker Custom Domain; same-zone Worker Routes cannot receive this subrequest. */
  readonly hopOrigin?: string;
  readonly now?: () => number;
  readonly createSocketPair?: () => { client: WebSocket; server: WebSocket };
  readonly webSocketResponse?: (client: WebSocket) => Response;
}
interface Connection {
  readonly hostname: string;
  readonly originHostname: string;
  close(): void;
}

export function createManagedGateway(options: GatewayOptions) {
  if (options.secret.length < 32)
    throw new Error("Gateway secret must contain at least 32 characters");
  const hopOrigin = options.hopOrigin ? new URL(options.hopOrigin) : null;
  if (
    hopOrigin &&
    (hopOrigin.protocol !== "https:" ||
      hopOrigin.port ||
      hopOrigin.username ||
      hopOrigin.password ||
      hopOrigin.pathname !== "/" ||
      hopOrigin.search ||
      hopOrigin.hash)
  )
    throw new Error("Gateway hop must use an HTTPS origin");
  const now = options.now ?? Date.now;
  const connections = new Set<Connection>();
  let snapshot: GatewaySnapshot | null = null;
  let updates = Promise.resolve();
  const active = (state = snapshot) =>
    state?.enabled === true &&
    state.guardVerified &&
    state.accessUntilMs !== null &&
    now() < state.accessUntilMs;
  const environment = (hostname: string) =>
    snapshot?.environments.find((env) => env.publicHostname === hostname);
  const sweep = (state = snapshot) => {
    for (const connection of connections) {
      if (
        !active(state) ||
        state?.environments.find((env) => env.publicHostname === connection.hostname)
          ?.originHostname !== connection.originHostname
      ) {
        connection.close();
        connections.delete(connection);
      }
    }
  };
  const ready = options.storage.load().then((value) => {
    snapshot = value ? normalize(value) : null;
  });
  const update = (input: GatewaySnapshot): Promise<"applied" | "unchanged" | "stale"> => {
    const next = normalize(input);
    const operation = updates.then(async () => {
      await ready;
      if (snapshot && snapshot.userId !== next.userId)
        throw new Error("Gateway owner cannot change");
      if (snapshot && next.generation < snapshot.generation) return "stale" as const;
      if (snapshot && next.generation === snapshot.generation) {
        if (JSON.stringify(snapshot) !== JSON.stringify(next))
          throw new Error("Conflicting gateway generation");
        return "unchanged" as const;
      }
      // Close elapsed windows before renewal, and apply restrictions before asynchronous persistence.
      const previous = snapshot;
      sweep();
      sweep(next);
      try {
        await options.storage.commit(next, active(next) ? next.accessUntilMs : null);
        // Never extend existing transport access using state that is not durable yet.
        snapshot = next;
        sweep();
      } catch (error) {
        snapshot = previous ? { ...previous, enabled: false } : null;
        sweep();
        throw error;
      }
      return "applied" as const;
    });
    updates = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };
  const alarm = async () => {
    await ready;
    sweep();
  };
  const gatewayFetch = async (request: Request): Promise<Response> => {
    await ready;
    await updates;
    sweep();
    const requested = new URL(request.url);
    const mapping = environment(requested.hostname);
    if (!active()) return new Response("Connect access expired", { status: 402 });
    if (requested.protocol !== "https:" || requested.port || !mapping)
      return new Response("Unknown managed environment", { status: 404 });
    const abort = new AbortController();
    const connection: Connection = {
      hostname: mapping.publicHostname,
      originHostname: mapping.originHostname,
      close: () => abort.abort(new Error("Connect access expired")),
    };
    connections.add(connection);
    const headers = new Headers(request.headers);
    headers.delete("host");
    for (const header of INTERNAL_HEADERS) headers.delete(header);
    headers.set(AUTH_HEADER, options.secret);
    headers.set(ORIGIN_HEADER, mapping.originHostname);
    headers.set(PATH_HEADER, requested.pathname + requested.search);
    requested.pathname = GATEWAY_ORIGIN_PATH;
    requested.search = "";
    if (hopOrigin) requested.hostname = hopOrigin.hostname;
    const requestAbort = () => connection.close();
    request.signal.addEventListener("abort", requestAbort, { once: true });
    if (request.signal.aborted) connection.close();
    const dispose = () => {
      connections.delete(connection);
      request.signal.removeEventListener("abort", requestAbort);
    };
    let upstream: Response;
    try {
      const init: RequestInit & { duplex?: "half" } = {
        method: request.method,
        headers,
        redirect: "manual",
        signal: abort.signal,
        ...(request.body ? { body: request.body, duplex: "half" as const } : {}),
      };
      upstream = await options.fetch.call(globalThis, requested, init);
    } catch {
      dispose();
      return new Response(active() ? "Origin unavailable" : "Connect access expired", {
        status: active() ? 502 : 402,
      });
    }
    sweep();
    if (abort.signal.aborted) {
      dispose();
      await upstream.body?.cancel().catch(() => undefined);
      upstream.webSocket?.close(4003, "Connect access expired");
      return new Response("Connect access expired", { status: 402 });
    }
    if (upstream.webSocket) {
      const origin = upstream.webSocket;
      origin.accept();
      const pair =
        options.createSocketPair?.() ??
        (() => {
          const sockets = new WebSocketPair();
          return { client: sockets[0], server: sockets[1] };
        })();
      pair.server.accept();
      let closed = false;
      const close = (code = 4003, reason = "Connect access expired") => {
        if (closed) return;
        closed = true;
        for (const socket of [pair.server, origin]) {
          try {
            socket.close(code, reason);
          } catch {
            /* Socket already gone. */
          }
        }
        dispose();
      };
      abort.signal.addEventListener("abort", () => close(), { once: true });
      const forward = (from: WebSocket, to: WebSocket) => {
        from.addEventListener("message", (event) => {
          sweep();
          if (closed) return;
          try {
            to.send(event.data);
          } catch {
            close(1011, "Transport closed");
          }
        });
        from.addEventListener("close", (event) =>
          close(event.code === 1005 || event.code === 1006 ? 1000 : event.code, event.reason),
        );
        from.addEventListener("error", () => close(1011, "Transport closed"));
      };
      forward(pair.server, origin);
      forward(origin, pair.server);
      return (
        options.webSocketResponse?.(pair.client) ??
        new Response(null, {
          status: 101,
          webSocket: pair.client,
          headers: upstream.headers.has("sec-websocket-protocol")
            ? { "sec-websocket-protocol": upstream.headers.get("sec-websocket-protocol")! }
            : {},
        })
      );
    }
    if (!upstream.body) {
      dispose();
      return upstream;
    }
    const reader = upstream.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const cancel = () => {
          void reader.cancel().catch(() => undefined);
          try {
            controller.error(new Error("Connect access expired"));
          } catch {
            /* Reader already gone. */
          }
          dispose();
        };
        abort.signal.addEventListener("abort", cancel, { once: true });
        if (abort.signal.aborted) cancel();
      },
      async pull(controller) {
        sweep();
        if (abort.signal.aborted) return;
        try {
          const chunk = await reader.read();
          sweep();
          if (abort.signal.aborted) return;
          if (chunk.done) {
            controller.close();
            dispose();
          } else controller.enqueue(chunk.value);
        } catch (error) {
          dispose();
          controller.error(error);
        }
      },
      async cancel() {
        connection.close();
        dispose();
        await reader.cancel().catch(() => undefined);
      },
    });
    return new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  };
  return { ready, update, alarm, fetch: gatewayFetch };
}

/** The public Worker performs this hop: DO-origin subrequests do not carry the required WAF zone. */
export async function managedGatewayOriginHop(
  request: Request,
  options: {
    readonly secret: string;
    readonly originSuffix: string;
    readonly fetch: typeof fetch;
  },
): Promise<Response> {
  const url = new URL(request.url);
  if (
    url.pathname !== GATEWAY_ORIGIN_PATH ||
    options.secret.length < 32 ||
    request.headers.get(AUTH_HEADER) !== options.secret
  )
    return new Response("Forbidden", { status: 403 });
  const origin = request.headers.get(ORIGIN_HEADER) ?? "";
  const path = request.headers.get(PATH_HEADER) ?? "";
  if (
    !hostnamePattern.test(origin) ||
    !origin.endsWith(`.${options.originSuffix}`) ||
    origin.slice(0, -(options.originSuffix.length + 1)).includes(".") ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\")
  )
    return new Response("Forbidden", { status: 403 });
  const destination = new URL(path, `https://${origin}`);
  if (destination.hostname !== origin) return new Response("Forbidden", { status: 403 });
  const headers = new Headers(request.headers);
  for (const header of INTERNAL_HEADERS) headers.delete(header);
  headers.delete("host");
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    redirect: "manual",
    signal: request.signal,
    ...(request.body ? { body: request.body, duplex: "half" as const } : {}),
  };
  return options.fetch.call(globalThis, destination, init);
}

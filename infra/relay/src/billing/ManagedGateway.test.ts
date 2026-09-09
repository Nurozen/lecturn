import { describe, expect, it, vi } from "vite-plus/test";
import {
  createManagedGateway,
  managedGatewayOriginHop,
  type GatewaySnapshot,
} from "./ManagedGateway.ts";

const environment = {
  environmentId: "env_a",
  publicHostname: "a.connect.example.com",
  originHostname: "a.origin.example.com",
};
const snapshot = (overrides: Partial<GatewaySnapshot> = {}): GatewaySnapshot => ({
  userId: "user_a",
  generation: 1,
  accessUntilMs: 20_000,
  enabled: true,
  guardVerified: true,
  environments: [environment],
  ...overrides,
});

function fixture(initial: GatewaySnapshot | null = null, upstream: typeof fetch = fetch) {
  let clock = 10_000;
  let saved = initial;
  const commits: { snapshot: GatewaySnapshot; alarmMs: number | null }[] = [];
  const gateway = createManagedGateway({
    storage: {
      load: async () => saved,
      commit: async (state, alarmMs) => {
        saved = state;
        commits.push({ snapshot: state, alarmMs });
      },
    },
    fetch: upstream,
    secret: "private-origin-hop-secret-with-32-characters",
    now: () => clock,
  });
  return { gateway, commits, setClock: (value: number) => (clock = value) };
}

const request = (hostname = environment.publicHostname) =>
  new Request(`https://${hostname}/api/health?check=1`);

describe("managed gateway access boundary", () => {
  it("forwards routed environment traffic through the fixed Worker custom domain", async () => {
    const upstream = vi.fn<typeof fetch>(async () => new Response("forwarded"));
    const gateway = createManagedGateway({
      storage: { load: async () => snapshot(), commit: async () => {} },
      fetch: upstream,
      secret: "private-origin-hop-secret-with-32-characters",
      hopOrigin: "https://relay.example.com",
      now: () => 10_000,
    });
    const response = await gateway.fetch(
      new Request(`https://${environment.publicHostname}/ws?ticket=opaque`, {
        headers: { host: environment.publicHostname },
      }),
    );
    expect(await response.text()).toBe("forwarded");
    const [target, init] = upstream.mock.calls[0]!;
    expect(String(target)).toBe("https://relay.example.com/_lecturn_gateway_origin");
    const headers = new Headers(init?.headers);
    expect(headers.has("host")).toBe(false);
    expect(headers.get("x-lecturn-gateway-path")).toBe("/ws?ticket=opaque");
    expect(headers.get("x-lecturn-gateway-origin")).toBe(environment.originHostname);
  });

  it("invokes the upstream fetch with the global receiver required by Cloudflare native fetch", async () => {
    const upstream: typeof fetch = async function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return new Response("origin reached");
    };
    const { gateway } = fixture(snapshot(), upstream);
    await gateway.ready;
    const response = await gateway.fetch(request());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("origin reached");
  });
  it.each([0, -1, Number.POSITIVE_INFINITY, Number.NaN])(
    "rejects malformed persisted deadlines (%s)",
    async (deadline) => {
      const upstream = vi.fn<typeof fetch>();
      const { gateway } = fixture(snapshot({ accessUntilMs: deadline }), upstream);
      await expect(gateway.ready).rejects.toThrow();
      await expect(gateway.fetch(request())).rejects.toThrow();
      expect(upstream).not.toHaveBeenCalled();
    },
  );
  it.each([
    null,
    snapshot({ enabled: false }),
    snapshot({ guardVerified: false }),
    snapshot({ accessUntilMs: null }),
    snapshot({ accessUntilMs: 10_000 }),
  ])("denies unavailable or non-finite access without reaching the origin (%#)", async (state) => {
    const upstream = vi.fn<typeof fetch>();
    const { gateway } = fixture(state, upstream);
    await gateway.ready;
    expect((await gateway.fetch(request())).status).toBe(402);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("only forwards the exact public hostname assigned to this user", async () => {
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
    const { gateway } = fixture(snapshot(), upstream);
    await gateway.ready;
    for (const hostname of [
      "other.connect.example.com",
      "a.connect.example.com.attacker.example",
      environment.originHostname,
    ]) {
      expect((await gateway.fetch(request(hostname))).status).not.toBe(200);
    }
    expect(upstream).not.toHaveBeenCalled();
    expect(await (await gateway.fetch(request())).text()).toBe("ok");
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("rejects cross-user updates, ignores stale generations, and rejects conflicting retries", async () => {
    const { gateway, commits } = fixture(snapshot());
    await gateway.ready;
    expect(await gateway.update(snapshot())).toBe("unchanged");
    expect(await gateway.update(snapshot({ generation: 0, enabled: false }))).toBe("stale");
    await expect(
      gateway.update(snapshot({ userId: "user_other", generation: 2 })),
    ).rejects.toThrow();
    await expect(gateway.update(snapshot({ enabled: false }))).rejects.toThrow();
    expect(commits).toHaveLength(0);
    expect(await gateway.update(snapshot({ generation: 2, accessUntilMs: 30_000 }))).toBe(
      "applied",
    );
    expect(commits.at(-1)).toMatchObject({
      snapshot: { generation: 2, accessUntilMs: 30_000 },
      alarmMs: 30_000,
    });
  });

  it("streams request bodies to the configured origin and preserves path, query and authorization", async () => {
    let received: Request | undefined;
    const upstream: typeof fetch = async (input, init) => {
      received = new Request(input, init);
      expect(received.url).toBe("https://a.connect.example.com/_lecturn_gateway_origin");
      expect(received.headers.get("x-lecturn-gateway-origin")).toBe(environment.originHostname);
      expect(received.headers.get("x-lecturn-gateway-path")).toBe("/api/write?mode=append");
      expect(received.headers.get("x-lecturn-gateway-auth")).toBe(
        "private-origin-hop-secret-with-32-characters",
      );
      expect(received.headers.get("authorization")).toBe("DPoP client-proof");
      expect(received.method).toBe("POST");
      expect(await received.text()).toBe("firstsecond");
      return new Response("written", { status: 201 });
    };
    const { gateway } = fixture(snapshot(), upstream);
    await gateway.ready;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first"));
        controller.enqueue(new TextEncoder().encode("second"));
        controller.close();
      },
    });
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: {
        authorization: "DPoP client-proof",
        "x-lecturn-gateway-auth": "attacker-secret",
        "x-lecturn-gateway-origin": "attacker.example.com",
        "x-lecturn-gateway-path": "/attacker",
      },
      body,
      duplex: "half",
    };
    const response = await gateway.fetch(
      new Request("https://a.connect.example.com/api/write?mode=append", init),
    );
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("written");
    expect(received).toBeDefined();
  });

  it("cuts off an already-open HTTP response when the deadline alarm fires", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const upstream: typeof fetch = async (input, init) => {
      upstreamSignal = new Request(input, init).signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("connected"));
          },
        }),
      );
    };
    const { gateway, setClock } = fixture(snapshot(), upstream);
    await gateway.ready;
    const response = await gateway.fetch(request());
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("connected");
    const ended = reader.read().then(
      (result) => result.done,
      () => true,
    );
    setClock(20_000);
    await gateway.alarm();
    expect(await ended).toBe(true);
    expect(upstreamSignal?.aborted).toBe(true);
    expect((await gateway.fetch(request())).status).toBe(402);
  });

  it("keeps a renewed stream open when an old deadline alarm arrives", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const upstream: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
          },
        }),
      );
    const { gateway, setClock } = fixture(snapshot(), upstream);
    await gateway.ready;
    const reader = (await gateway.fetch(request())).body!.getReader();
    await gateway.update(snapshot({ generation: 2, accessUntilMs: 40_000 }));
    setClock(20_000);
    await gateway.alarm();
    controller.enqueue(new TextEncoder().encode("still connected"));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("still connected");
    const ended = reader.read().then(
      (result) => result.done,
      () => true,
    );
    setClock(40_000);
    await gateway.alarm();
    expect(await ended).toBe(true);
  });

  it("closes the previous stream when renewal arrives after expiry but before the old alarm", async () => {
    const upstream: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>());
    const { gateway, setClock } = fixture(snapshot(), upstream);
    await gateway.ready;
    const reader = (await gateway.fetch(request())).body!.getReader();
    const ended = reader.read().then(
      (result) => result.done,
      () => true,
    );
    setClock(25_000);
    await gateway.update(snapshot({ generation: 2, accessUntilMs: 40_000 }));
    expect(await ended).toBe(true);
    const fresh = await gateway.fetch(request());
    expect(fresh.status).toBe(200);
    await fresh.body!.cancel();
  });

  it("does not forward beyond the old deadline while a renewal commit is still pending", async () => {
    let clock = 10_000;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let releaseCommit!: () => void;
    let enteredCommit!: () => void;
    const commitEntered = new Promise<void>((resolve) => {
      enteredCommit = resolve;
    });
    const commitReleased = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const gateway = createManagedGateway({
      storage: {
        load: async () => snapshot(),
        commit: async () => {
          enteredCommit();
          await commitReleased;
        },
      },
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(value) {
              controller = value;
            },
          }),
        ),
      secret: "private-origin-hop-secret-with-32-characters",
      now: () => clock,
    });
    await gateway.ready;
    const reader = (await gateway.fetch(request())).body!.getReader();
    const nextRead = reader.read().then(
      (result) => result.done,
      () => true,
    );
    const renewal = gateway.update(snapshot({ generation: 2, accessUntilMs: 40_000 }));
    await commitEntered;
    clock = 25_000;
    controller.enqueue(new TextEncoder().encode("must not reach the client"));
    try {
      expect(await nextRead).toBe(true);
    } finally {
      releaseCommit();
      await renewal;
    }
  });

  it("cuts off an idle HTTP stream on alarm without waiting for a stalled renewal commit", async () => {
    let clock = 10_000;
    let releaseCommit!: () => void;
    let enteredCommit!: () => void;
    const commitEntered = new Promise<void>((resolve) => {
      enteredCommit = resolve;
    });
    const commitReleased = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const gateway = createManagedGateway({
      storage: {
        load: async () => snapshot(),
        commit: async () => {
          enteredCommit();
          await commitReleased;
        },
      },
      fetch: async () => new Response(new ReadableStream<Uint8Array>()),
      secret: "private-origin-hop-secret-with-32-characters",
      now: () => clock,
    });
    await gateway.ready;
    const reader = (await gateway.fetch(request())).body!.getReader();
    const ended = reader.read().then(
      (result) => result.done,
      () => true,
    );
    const renewal = gateway.update(snapshot({ generation: 2, accessUntilMs: 40_000 }));
    await commitEntered;
    clock = 20_000;
    try {
      await gateway.alarm();
      expect(await ended).toBe(true);
    } finally {
      releaseCommit();
      await renewal;
    }
  });

  it.each(["removed mapping", "revoked access"])(
    "closes active streams after %s",
    async (cause) => {
      const upstream: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>());
      const { gateway } = fixture(snapshot(), upstream);
      await gateway.ready;
      const reader = (await gateway.fetch(request())).body!.getReader();
      const ended = reader.read().then(
        (result) => result.done,
        () => true,
      );
      await gateway.update(
        snapshot({
          generation: 2,
          ...(cause === "removed mapping" ? { environments: [] } : { enabled: false }),
        }),
      );
      expect(await ended).toBe(true);
      expect((await gateway.fetch(request())).status).not.toBe(200);
    },
  );
});

describe("managed gateway authenticated origin hop", () => {
  const secret = "private-origin-hop-secret-with-32-characters";
  const hop = (headers: Record<string, string> = {}) =>
    new Request("https://a.connect.example.com/_lecturn_gateway_origin", {
      headers: {
        "x-lecturn-gateway-auth": secret,
        "x-lecturn-gateway-origin": "a.origin.example.com",
        "x-lecturn-gateway-path": "/api/health?check=1",
        authorization: "DPoP client-proof",
        ...headers,
      },
    });

  it("preserves the global receiver on the final authenticated origin fetch", async () => {
    const upstream: typeof fetch = async function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return new Response("origin reached");
    };
    const response = await managedGatewayOriginHop(hop(), {
      secret,
      originSuffix: "origin.example.com",
      fetch: upstream,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("origin reached");
  });

  it.each([
    { "x-lecturn-gateway-auth": "guessed" },
    { "x-lecturn-gateway-origin": "origin.example.com.attacker.example" },
    { "x-lecturn-gateway-origin": "nested.a.origin.example.com" },
    { "x-lecturn-gateway-origin": "127.0.0.1" },
    { "x-lecturn-gateway-path": "//attacker.example/" },
    { "x-lecturn-gateway-path": "/\\attacker.example/" },
    { "x-lecturn-gateway-path": "https://attacker.example/" },
  ])("rejects unauthenticated or out-of-scope origin requests (%#)", async (headers) => {
    const upstream = vi.fn<typeof fetch>();
    const result = await managedGatewayOriginHop(hop(headers), {
      secret,
      originSuffix: "origin.example.com",
      fetch: upstream,
    });
    expect(result.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("removes hop credentials before the final origin request and preserves client authorization", async () => {
    const upstream: typeof fetch = async (input, init) => {
      const forwarded = new Request(input, init);
      expect(forwarded.url).toBe("https://a.origin.example.com/api/health?check=1");
      expect(forwarded.headers.get("authorization")).toBe("DPoP client-proof");
      expect(forwarded.headers.get("host")).toBeNull();
      expect(forwarded.headers.get("x-lecturn-gateway-auth")).toBeNull();
      expect(forwarded.headers.get("x-lecturn-gateway-origin")).toBeNull();
      expect(forwarded.headers.get("x-lecturn-gateway-path")).toBeNull();
      expect(forwarded.redirect).toBe("manual");
      return new Response("origin response");
    };
    const result = await managedGatewayOriginHop(hop({ host: "attacker.example" }), {
      secret,
      originSuffix: "origin.example.com",
      fetch: upstream,
    });
    expect(await result.text()).toBe("origin response");
  });
});

class TestSocket extends EventTarget {
  accept = vi.fn();
  send = vi.fn();
  close = vi.fn();
  asWebSocket() {
    return this as unknown as WebSocket;
  }
  message(data: string) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

it("relays WebSocket messages both ways and closes both endpoints at the access deadline", async () => {
  let clock = 10_000;
  const origin = new TestSocket();
  const server = new TestSocket();
  const client = new TestSocket();
  const upstream = new Response(null);
  Object.defineProperty(upstream, "webSocket", { value: origin.asWebSocket() });
  const gateway = createManagedGateway({
    storage: { load: async () => snapshot(), commit: async () => {} },
    fetch: async () => upstream,
    secret: "private-origin-hop-secret-with-32-characters",
    now: () => clock,
    createSocketPair: () => ({ client: client.asWebSocket(), server: server.asWebSocket() }),
    webSocketResponse: () => new Response(null),
  });
  await gateway.ready;
  await gateway.fetch(
    new Request("https://a.connect.example.com/ws", { headers: { upgrade: "websocket" } }),
  );

  expect(origin.accept).toHaveBeenCalledOnce();
  expect(server.accept).toHaveBeenCalledOnce();
  server.message("client request");
  origin.message("origin response");
  expect(origin.send).toHaveBeenCalledWith("client request");
  expect(server.send).toHaveBeenCalledWith("origin response");
  clock = 20_000;
  await gateway.alarm();
  expect(origin.close).toHaveBeenCalledWith(4003, "Connect access expired");
  expect(server.close).toHaveBeenCalledWith(4003, "Connect access expired");
  server.message("after expiry");
  origin.message("after expiry");
  expect(origin.send).toHaveBeenCalledTimes(1);
  expect(server.send).toHaveBeenCalledTimes(1);
});

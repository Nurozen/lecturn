// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalFetchInEffect:off - A real loopback HTTP server stands in for the app's live endpoint.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { AppId, AppLoopbackHttpUrl, AppRegistration, type AppsError } from "@lecturn/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AppLeaseServiceLayer from "./AppLeaseService.ts";
import * as AppRegistryServiceLayer from "./AppRegistryService.ts";
import * as LiveToolClientLayer from "./LiveToolClient.ts";
import {
  type AppLease,
  AppLeaseService,
  AppProjectService,
  AppRegistryService,
  type AppsFailure,
} from "./services.ts";

const BEARER = "live-bearer-secret";
const SESSION = "session-1";

interface RecordedRequest {
  readonly method: string;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: unknown;
}

interface FixtureOptions {
  /** Answer tools/list in two pages. */
  readonly paged?: boolean;
  /** Reply as an SSE stream instead of JSON. */
  readonly sse?: boolean;
  /** Never answer tools/call. */
  readonly hangOnCall?: boolean;
  /** Answer every request with this HTTP status. */
  readonly status?: number;
  readonly redirectTo?: string;
  readonly rpcErrorOn?: string;
}

const flash = { name: "window_flash", inputSchema: { type: "object" } };
const ping = { name: "ping", inputSchema: { type: "object" } };

/** A minimal stateful Streamable-HTTP MCP server, recording every request. */
const startFixture = (options: FixtureOptions = {}) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const requests: Array<RecordedRequest> = [];
      let markCallArrived = () => {};
      const callArrived = new Promise<void>((resolve) => {
        markCallArrived = resolve;
      });
      const server = NodeHttp.createServer(async (req, res) => {
        const chunks: Array<Buffer> = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const text = Buffer.concat(chunks).toString("utf8");
        const body: unknown = text.length > 0 ? JSON.parse(text) : undefined;
        requests.push({ method: req.method ?? "", headers: req.headers, body });

        if (options.redirectTo !== undefined) {
          res.writeHead(307, { location: options.redirectTo }).end();
          return;
        }
        if (options.status !== undefined) {
          res.writeHead(options.status).end("nope");
          return;
        }
        if (req.headers.authorization !== `Bearer ${BEARER}`) {
          res.writeHead(401).end();
          return;
        }
        if (req.method === "DELETE") {
          res.writeHead(200).end();
          return;
        }
        const message = body as { id?: number; method: string; params?: any };
        if (message.id === undefined) {
          res.writeHead(202).end();
          return;
        }
        if (message.method !== "initialize" && req.headers["mcp-session-id"] !== SESSION) {
          res.writeHead(404).end();
          return;
        }
        if (message.method === "tools/call") markCallArrived();
        if (message.method === "tools/call" && options.hangOnCall) return;

        const result = (() => {
          if (message.method === options.rpcErrorOn) return undefined;
          switch (message.method) {
            case "initialize":
              return {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "fixture", version: "1" },
              };
            case "tools/list":
              if (!options.paged) return { tools: [flash] };
              return message.params?.cursor === "page-2"
                ? { tools: [ping] }
                : { tools: [flash], nextCursor: "page-2" };
            case "tools/call":
              return {
                content: [{ type: "text", text: `flashed ${message.params.name}` }],
                structuredContent: { echoedMeta: message.params._meta },
                isError: false,
              };
            case "resources/read":
              return {
                contents: [{ uri: message.params.uri, mimeType: "text/html", text: "<p>card</p>" }],
              };
            default:
              return undefined;
          }
        })();
        const envelope =
          result === undefined
            ? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "No such method" } }
            : { jsonrpc: "2.0", id: message.id, result };
        const headers = message.method === "initialize" ? { "mcp-session-id": SESSION } : {};
        if (options.sse) {
          res.writeHead(200, { ...headers, "content-type": "text/event-stream" });
          // A server notification first: only the matching id is the answer.
          res.write(
            `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: {} })}\n\n`,
          );
          res.end(`data: ${JSON.stringify(envelope)}\n\n`);
          return;
        }
        res.writeHead(200, { ...headers, "content-type": "application/json" });
        res.end(JSON.stringify(envelope));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as NodeNet.AddressInfo;
      return { server, requests, callArrived, url: `http://127.0.0.1:${port}/mcp` };
    }),
    ({ server }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
  );

const appId = AppId.make("dev.example.app");
const leaseFor = (url: string, bearer = BEARER): AppLease => ({
  appId,
  url: AppLoopbackHttpUrl.make(url),
  bearer,
  expiresAt: DateTime.makeUnsafe("2100-01-01T00:00:00.000Z"),
});

const rpcMethods = (requests: ReadonlyArray<RecordedRequest>) =>
  requests.map((request) =>
    request.method === "DELETE" ? "DELETE" : (request.body as { method: string }).method,
  );

const failureMessage = <A>(exit: Exit.Exit<A, AppsFailure>) => {
  assert.isTrue(Exit.isFailure(exit));
  const error = Exit.isFailure(exit)
    ? Option.getOrUndefined(Exit.findErrorOption(exit))
    : undefined;
  assert.strictEqual((error as AppsError | undefined)?.code, "unavailable");
  return error?.message ?? "";
};

describe("LiveToolClient", () => {
  it.effect("lists every page over one session and ends it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* startFixture({ paged: true });
        const client = LiveToolClientLayer.make();

        const tools = yield* client.listTools(leaseFor(fixture.url));

        assert.deepEqual(
          tools.map((tool) => tool.name),
          ["window_flash", "ping"],
        );
        assert.deepEqual(rpcMethods(fixture.requests), [
          "initialize",
          "notifications/initialized",
          "tools/list",
          "tools/list",
          "DELETE",
        ]);
        for (const request of fixture.requests) {
          assert.strictEqual(request.headers.authorization, `Bearer ${BEARER}`);
        }
        // The session and the negotiated version follow initialize.
        for (const request of fixture.requests.slice(1)) {
          assert.strictEqual(request.headers["mcp-session-id"], SESSION);
          assert.strictEqual(request.headers["mcp-protocol-version"], "2025-06-18");
        }
        assert.strictEqual(
          (fixture.requests[0]!.body as { params: { protocolVersion: string } }).params
            .protocolVersion,
          LiveToolClientLayer.LIVE_MCP_PROTOCOL_VERSION,
        );
      }),
    ),
  );

  it.effect("forwards a call with Lecturn's meta and reads an SSE answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* startFixture({ sse: true });
        const client = LiveToolClientLayer.make();
        const meta = { "lecturn/approval": { approved: true, requestId: "r1" } };

        const result = yield* client.call(leaseFor(fixture.url), {
          name: "window_flash",
          arguments: { color: "gold" },
          meta,
        });

        assert.deepEqual(result.content, [{ type: "text", text: "flashed window_flash" }]);
        assert.deepEqual(result.structuredContent, { echoedMeta: meta });
        const call = fixture.requests.find(
          (request) => (request.body as { method?: string } | undefined)?.method === "tools/call",
        );
        assert.deepEqual((call!.body as { params: unknown }).params, {
          name: "window_flash",
          arguments: { color: "gold" },
          _meta: meta,
        });
      }),
    ),
  );

  it.effect("reads a ui:// resource from the live endpoint", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* startFixture();
        const result = yield* LiveToolClientLayer.make().readResource(
          leaseFor(fixture.url),
          "ui://ex/flash-card",
        );
        assert.deepEqual(result.contents, [
          { uri: "ui://ex/flash-card", mimeType: "text/html", text: "<p>card</p>" },
        ]);
      }),
    ),
  );

  it.effect("reports a refused bearer without repeating it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* startFixture();
        const exit = yield* Effect.exit(
          LiveToolClientLayer.make().listTools(leaseFor(fixture.url, "stale-bearer")),
        );
        const message = failureMessage(exit);
        assert.include(message, "HTTP 401");
        assert.notInclude(message, "stale-bearer");
      }),
    ),
  );

  it.effect("surfaces a JSON-RPC error from the app", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* startFixture({ rpcErrorOn: "tools/call" });
        const exit = yield* Effect.exit(
          LiveToolClientLayer.make().call(leaseFor(fixture.url), {
            name: "window_flash",
            arguments: {},
            meta: {},
          }),
        );
        assert.include(failureMessage(exit), "refused tools/call: No such method");
        // The session is still ended after a failure.
        assert.strictEqual(rpcMethods(fixture.requests).at(-1), "DELETE");
      }),
    ),
  );

  it.effect("does not follow a redirect away from the leased URL", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const target = yield* startFixture();
        const redirecting = yield* startFixture({ redirectTo: target.url });
        const exit = yield* Effect.exit(
          LiveToolClientLayer.make().listTools(leaseFor(redirecting.url)),
        );
        failureMessage(exit);
        assert.deepEqual(target.requests, []);
      }),
    ),
  );

  it.effect("names a closed endpoint as not answering", () =>
    Effect.gen(function* () {
      const url = yield* Effect.scoped(startFixture().pipe(Effect.map((fixture) => fixture.url)));
      const exit = yield* Effect.exit(LiveToolClientLayer.make().listTools(leaseFor(url)));
      assert.include(failureMessage(exit), "is not answering");
    }),
  );

  it.effect("gives up on a call the app never answers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* startFixture({ hangOnCall: true });
        const client = LiveToolClientLayer.make({ callTimeout: "30 seconds" });
        const pending = yield* client
          .call(leaseFor(fixture.url), { name: "window_flash", arguments: {}, meta: {} })
          .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => fixture.callArrived);
        yield* TestClock.adjust("30 seconds");
        assert.include(failureMessage(yield* Fiber.join(pending)), "did not answer tools/call");
      }),
    ),
  );
});

const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const registration = Schema.decodeUnknownSync(AppRegistration)({
  appId,
  name: "Example",
  iconDataUrl: PNG_1PX,
  toolPrefix: "ex",
  refPrefixes: ["ex:"],
  liveTools: true,
  gatedTools: ["window_flash"],
});

const registryLayer = () => {
  const config = ServerConfig.layerTest(process.cwd(), { prefix: "lecturn-live-tools-" });
  const projects = Layer.succeed(AppProjectService)({
    ensureWorkspace: () => Effect.die("unused"),
    resolveAppForProject: () => Effect.succeed(Option.none()),
    listThreads: () => Effect.die("unused"),
    streamThreads: () => Stream.die("unused"),
    setThreadAppData: () => Effect.die("unused"),
    createEmbedThread: () => Effect.die("unused"),
    markThreadsCopied: () => Effect.die("unused"),
  });
  const sessions = SessionStore.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(ServerEnvironment.layerIdentity),
  );
  return AppRegistryServiceLayer.layer.pipe(
    Layer.provideMerge(AppLeaseServiceLayer.layer),
    Layer.provideMerge(LiveToolClientLayer.layer),
    Layer.provide(sessions),
    Layer.provide(projects),
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(config),
    Layer.provide(NodeServices.layer),
  );
};

describe("live definitions follow the lease", () => {
  it.effect("an app that never held a lease has no live definitions; setLiveLease lists them", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* startFixture();
        const registry = yield* AppRegistryService;
        const leases = yield* AppLeaseService;
        yield* registry.seedSidecarGrant({
          mode: "app-sidecar",
          registration,
          appSeedToken: "seed",
        });
        assert.isTrue(Option.isNone((yield* registry.cachedTools(appId)).live));

        const statuses = yield* Queue.unbounded<boolean>();
        yield* registry.streamStatus.pipe(
          Stream.runForEach((event) =>
            event.type === "upsert" ? Queue.offer(statuses, event.app.live !== null) : Effect.void,
          ),
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* leases.set(appId, { url: fixture.url, bearer: BEARER, ttlSeconds: 60 });
        // The app reads as open only once its definitions are cached.
        while (!(yield* Queue.take(statuses))) {}

        const cached = yield* registry.cachedTools(appId);
        assert.deepEqual(
          Option.map(cached.live, (tools) => tools.map((tool) => tool.name)),
          Option.some(["window_flash"]),
        );
      }),
    ).pipe(Effect.provide(registryLayer())),
  );
});

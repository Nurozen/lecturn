/**
 * `POST /api/squire/hooks/:triggerId` over the real
 * SquireTriggers service and an in-memory database.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Tests sign bodies the way GitHub does.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { SquireError, SquireId } from "@lecturn/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as SqlClient from "effect/sql/SqlClient";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SquireHttp from "./http.ts";
import * as SquirePolicyLock from "./SquirePolicyLock.ts";
import * as SquireRepository from "./SquireRepository.ts";
import * as SquireSwitch from "./SquireSwitch.ts";
import * as SquireTriggers from "./SquireTriggers.ts";
import { squireRow } from "./testkit/scopeHarness.ts";

const release = SquireId.make("squire:release");
const BODY_MARKER = "BODY-MARKER-91c2";
const CAP = SquireHttp.SQUIRE_WEBHOOK_MAX_BODY_BYTES;

const memorySecrets = Layer.sync(ServerSecretStore.ServerSecretStore, () => {
  const store = new Map<string, Uint8Array>();
  return ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(store.get(name))),
    set: (name, value) => Effect.sync(() => void store.set(name, value)),
    create: (name, value) => Effect.sync(() => void store.set(name, value)),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: (name) => Effect.sync(() => void store.delete(name)),
  });
});

const layerConfig = Layer.merge(
  ServerConfig.layerTest(process.cwd(), { prefix: "lecturn-squire-webhook-" }),
  SquireSwitch.layerTest(true),
).pipe(Layer.provide(NodeServices.layer));

const layerTriggers = SquireTriggers.layer.pipe(
  Layer.provideMerge(SquirePolicyLock.layer),
  Layer.provideMerge(SquireRepository.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(memorySecrets),
  Layer.provideMerge(ServerSettings.layerTest({})),
  Layer.provideMerge(layerConfig),
);

interface CapturedLog {
  readonly message: unknown;
  readonly annotations: unknown;
}

/** The routes over `services`, with every log line the handlers write captured. */
const routeHandler = (services: Context.Context<never>) =>
  Effect.gen(function* () {
    const logs: Array<CapturedLog> = [];
    const logger = Logger.make(({ fiber, message }) => {
      logs.push({ message, annotations: fiber.getRef(References.CurrentLogAnnotations) });
    });
    const { handler, dispose } = HttpRouter.toWebHandler(
      SquireHttp.layer.pipe(
        Layer.provide(Layer.succeedContext(services)),
        Layer.provide(SquireSwitch.layerTest(true)),
        Layer.provideMerge(Layer.mock(EnvironmentAuth.EnvironmentAuth)({})),
        Layer.provideMerge(Logger.layer([logger], { mergeWithExisting: false })),
        Layer.provide(HttpPlatform.layer),
        Layer.provide(Etag.layerWeak),
        Layer.provide(NodeServices.layer),
      ),
      { disableLogger: true },
    );
    yield* Effect.addFinalizer(() => Effect.promise(dispose));
    const send = (path: string, init: RequestInit) =>
      Effect.promise(() => handler(new Request(`http://env.local${path}`, init)));
    return { send, logs };
  });

const hookPath = (triggerId: string) => `${SquireHttp.SQUIRE_WEBHOOK_ROUTE_PREFIX}/${triggerId}`;
const payload = new TextEncoder().encode(JSON.stringify({ note: BODY_MARKER }));
const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

/** A body that records whether anything pulled it; highWaterMark 0 keeps it from prefetching. */
const watchedBody = () => {
  const state = { pulled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        state.pulled = true;
        controller.enqueue(payload);
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  return { state, init: { body: stream, duplex: "half" } as RequestInit };
};

const setup = Effect.gen(function* () {
  const services = yield* Layer.build(layerTriggers);
  const provide = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      SquireTriggers.SquireTriggers | SquireRepository.SquireRepository | SqlClient.SqlClient
    >,
  ) => Effect.provideContext(effect, services);
  yield* provide(
    Effect.flatMap(SquireRepository.SquireRepository, (repository) =>
      repository.createSquire(squireRow(release)),
    ),
  );
  const created = yield* provide(
    Effect.flatMap(SquireTriggers.SquireTriggers, (triggers) =>
      triggers.create({
        requestId: "create-webhook",
        squireId: release,
        kind: "webhook",
        name: "When CI fails on main",
        instruction: "Look at the failing run",
      }),
    ),
  );
  if (created.webhook === null) return yield* Effect.die("no secret");
  const route = yield* routeHandler(services);
  return {
    ...route,
    provide,
    triggerId: created.trigger.id,
    secret: created.webhook.secret,
  };
});

const allLogText = (logs: ReadonlyArray<CapturedLog>) => JSON.stringify(logs);

describe("Squire webhook route", () => {
  it.effect("answers 202 for Bearer and HMAC requests and queues one event each", () =>
    Effect.gen(function* () {
      const { send, triggerId, secret, provide } = yield* setup;
      const viaBearer = yield* send(hookPath(triggerId), {
        method: "POST",
        body: payload,
        headers: { ...bearer(secret), "idempotency-key": "delivery-1" },
      });
      assert.equal(viaBearer.status, 202);
      assert.deepStrictEqual(yield* Effect.promise(() => viaBearer.json()), { status: "queued" });

      const signature = `sha256=${NodeCrypto.createHmac("sha256", secret).update(payload).digest("hex")}`;
      const viaHmac = yield* send(hookPath(triggerId), {
        method: "POST",
        body: payload,
        headers: { "x-hub-signature-256": signature, "x-github-delivery": "gh-1" },
      });
      assert.equal(viaHmac.status, 202);

      // A replayed delivery id is acknowledged without a second event.
      const replay = yield* send(hookPath(triggerId), {
        method: "POST",
        body: payload,
        headers: { ...bearer(secret), "idempotency-key": "delivery-1" },
      });
      assert.equal(replay.status, 202);
      assert.deepStrictEqual(yield* Effect.promise(() => replay.json()), { status: "duplicate" });

      const rows = yield* provide(
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) => sql<{ readonly state_key: string }>`SELECT state_key FROM squire_event`,
        ),
      );
      assert.deepStrictEqual(
        rows.map((row) => row.state_key),
        [`${triggerId}:delivery-1`, `${triggerId}:gh-1`],
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "answers 404 without reading the body for unknown, paused, revoked, or paused-Squire triggers",
    () =>
      Effect.gen(function* () {
        const { send, triggerId, secret, provide, logs } = yield* setup;
        const expectUnread404 = (path: string) =>
          Effect.gen(function* () {
            const body = watchedBody();
            const response = yield* send(path, {
              method: "POST",
              headers: bearer(secret),
              ...body.init,
            });
            assert.equal(response.status, 404);
            assert.isFalse(body.state.pulled);
          });

        yield* expectUnread404(hookPath("trigger-unknown"));

        const triggers = yield* provide(SquireTriggers.SquireTriggers);
        const repository = yield* provide(SquireRepository.SquireRepository);
        yield* provide(triggers.update({ requestId: "pause", triggerId, status: "paused" }));
        yield* expectUnread404(hookPath(triggerId));
        yield* provide(triggers.update({ requestId: "resume", triggerId, status: "active" }));

        yield* provide(
          repository.updateSquire({
            id: release,
            patch: { status: "paused" },
            updatedAt: "2026-11-02T08:00:00.000Z",
          }),
        );
        yield* expectUnread404(hookPath(triggerId));
        yield* provide(
          repository.updateSquire({
            id: release,
            patch: { status: "active" },
            updatedAt: "2026-11-02T08:00:00.000Z",
          }),
        );

        yield* provide(triggers.revoke({ requestId: "revoke", triggerId }));
        yield* expectUnread404(hookPath(triggerId));
        assert.notInclude(allLogText(logs), BODY_MARKER);
      }).pipe(Effect.scoped),
  );

  it.effect("answers 404 without reading the body when the switch is off", () =>
    Effect.gen(function* () {
      // Switch off: the Squire services are not built, so SquireTriggers is absent.
      const { send } = yield* routeHandler(Context.empty());
      const body = watchedBody();
      const response = yield* send(hookPath("trigger-any"), { method: "POST", ...body.init });
      assert.equal(response.status, 404);
      assert.isFalse(body.state.pulled);
    }).pipe(Effect.scoped),
  );

  it.effect("answers 401 on a failed check and logs no body", () =>
    Effect.gen(function* () {
      const { send, triggerId, logs, provide } = yield* setup;
      for (const headers of [
        bearer("not-the-secret"),
        { "x-hub-signature-256": "sha256=00" },
        {},
      ]) {
        const response = yield* send(hookPath(triggerId), {
          method: "POST",
          body: payload,
          headers,
        });
        assert.equal(response.status, 401);
      }
      assert.notInclude(allLogText(logs), BODY_MARKER);
      const stored = yield* provide(
        Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT * FROM squire_action_log`),
      );
      assert.notInclude(JSON.stringify(stored), BODY_MARKER);
    }).pipe(Effect.scoped),
  );

  it.effect("answers 413 over 64 KB by Content-Length and for a chunked body", () =>
    Effect.gen(function* () {
      const { send, triggerId, secret, logs } = yield* setup;
      const declared = yield* send(hookPath(triggerId), {
        method: "POST",
        body: new Uint8Array(CAP + 1),
        headers: bearer(secret),
      });
      assert.equal(declared.status, 413);

      const chunk = new TextEncoder().encode(BODY_MARKER.padEnd(16 * 1024, "x"));
      const chunked = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let sent = 0; sent <= CAP; sent += chunk.byteLength) controller.enqueue(chunk);
          controller.close();
        },
      });
      const streamed = yield* send(hookPath(triggerId), {
        method: "POST",
        body: chunked,
        headers: bearer(secret),
        duplex: "half",
      } as RequestInit);
      assert.equal(streamed.status, 413);
      assert.notInclude(allLogText(logs), BODY_MARKER);
    }).pipe(Effect.scoped),
  );

  it.effect("answers 429 with Retry-After once the trigger's hourly limit is spent", () =>
    Effect.gen(function* () {
      const { send, triggerId, secret } = yield* setup;
      const statuses: Array<number> = [];
      for (let index = 0; index < 7; index += 1) {
        const response = yield* send(hookPath(triggerId), {
          method: "POST",
          body: payload,
          headers: bearer(secret),
        });
        statuses.push(response.status);
        if (response.status === 429) {
          assert.isAtLeast(Number(response.headers.get("retry-after")), 1);
        }
      }
      assert.deepStrictEqual(statuses, [202, 202, 202, 202, 202, 202, 429]);
    }).pipe(Effect.scoped),
  );

  it.effect("answers 500 on a service failure and logs the trigger id, never the body", () =>
    Effect.gen(function* () {
      const failing = yield* Layer.build(
        Layer.mock(SquireTriggers.SquireTriggers)({
          receive: (_triggerId, _headers, body) =>
            Effect.flatMap(Effect.orDie(body), () =>
              Effect.fail(new SquireError({ code: "unknown", message: "database closed" })),
            ),
        }),
      );
      const { send, logs } = yield* routeHandler(failing);
      const response = yield* send(hookPath("trigger-x"), { method: "POST", body: payload });
      assert.equal(response.status, 500);
      const text = allLogText(logs);
      assert.include(text, "Squire webhook receipt failed");
      assert.include(text, "trigger-x");
      assert.notInclude(text, BODY_MARKER);
    }).pipe(Effect.scoped),
  );
});

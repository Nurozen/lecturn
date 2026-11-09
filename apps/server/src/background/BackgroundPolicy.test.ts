import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  RpcClientId,
  type ClientActivityLease,
  type HostPowerSnapshot,
  type ClientActivityReportInput,
} from "@lecturn/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../serverSettings.ts";
import * as BackgroundPolicy from "./BackgroundPolicy.ts";
import * as HostPowerMonitor from "./HostPowerMonitor.ts";

const TEST_NOW = DateTime.makeUnsafe("2026-05-13T00:00:00.000Z");

const nominalHostPower: HostPowerSnapshot = {
  source: "unknown",
  idle: "unknown",
  idleSeconds: null,
  locked: "unknown",
  suspended: false,
  onBattery: "unknown",
  lowPowerMode: "unknown",
  thermalState: "unknown",
  stale: true,
  updatedAt: TEST_NOW,
};

function makeReport(overrides: Partial<ClientActivityReportInput> = {}): ClientActivityReportInput {
  return {
    clientId: "client-1",
    clientKind: "web",
    visible: true,
    focused: true,
    recentlyInteracted: true,
    scopes: [{ type: "vcs-status", cwd: "/repo" }],
    ttlMs: 45_000,
    observedAt: TEST_NOW,
    ...overrides,
  };
}

function layerFor(
  hostPower: HostPowerSnapshot,
  settingsOverrides: Parameters<typeof ServerSettings.layerTest>[0] = {},
) {
  const layerHost = Layer.effect(
    HostPowerMonitor.HostPowerMonitor,
    Effect.gen(function* () {
      const changes = yield* PubSub.sliding<HostPowerSnapshot>(1);
      let snapshot = hostPower;
      return HostPowerMonitor.HostPowerMonitor.of({
        snapshot: Effect.sync(() => snapshot),
        report: (next) =>
          Effect.sync(() => {
            snapshot = next;
          }).pipe(Effect.andThen(PubSub.publish(changes, next)), Effect.asVoid),
        streamChanges: Stream.fromPubSub(changes),
      });
    }),
  );
  return BackgroundPolicy.layer.pipe(
    Layer.provide(Layer.merge(layerHost, ServerSettings.layerTest(settingsOverrides))),
  );
}

describe("BackgroundPolicy", () => {
  it.effect("runs durable queued work with no clients but respects host suspension", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      assert.isTrue(yield* policy.shouldRunDurableWork);
      assert.isFalse(yield* policy.shouldRunOpportunisticWork);
      yield* policy.reportHostPowerState({ ...nominalHostPower, suspended: true, stale: false });
      assert.isFalse(yield* policy.shouldRunDurableWork);
      yield* policy.reportHostPowerState({
        ...nominalHostPower,
        thermalState: "serious",
        stale: false,
      });
      assert.isFalse(yield* policy.shouldRunDurableWork);
      yield* policy.reportHostPowerState(nominalHostPower);
      assert.isTrue(yield* policy.shouldRunDurableWork);
    }).pipe(Effect.provide(layerFor(nominalHostPower))),
  );

  it.effect("removes all leases for a disconnected websocket connection", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        RpcClientId.make(1),
        makeReport(),
      );
      yield* policy.removeRpcClient(AuthSessionId.make("session-1"), RpcClientId.make(1));

      const snapshot = yield* policy.snapshot;
      assert.equal(snapshot.activeForegroundLeaseCount, 0);
      assert.deepStrictEqual(snapshot.activeScopeKeys, []);
      assert.equal(snapshot.shouldRunOpportunisticWork, false);
    }).pipe(Effect.provide(layerFor(nominalHostPower))),
  );

  it.effect("keeps leases from another session when rpc client ids are reused", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      const rpcClientId = RpcClientId.make(1);
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        rpcClientId,
        makeReport({ clientId: "client-1" }),
      );
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-2"),
        rpcClientId,
        makeReport({ clientId: "client-2" }),
      );

      yield* policy.removeRpcClient(AuthSessionId.make("session-1"), rpcClientId);

      const snapshot = yield* policy.snapshot;
      assert.equal(snapshot.activeForegroundLeaseCount, 1);
      assert.equal(snapshot.leases[0]?.sessionId, AuthSessionId.make("session-2"));
      assert.equal(snapshot.leases[0]?.clientId, "client-2");
    }).pipe(Effect.provide(layerFor(nominalHostPower))),
  );

  it.effect("serializes lease mutation publications", () =>
    Effect.gen(function* () {
      const blockNextSettingsRead = yield* Ref.make(false);
      const blockedSnapshotStarted = yield* Deferred.make<void>();
      const releaseBlockedSnapshot = yield* Deferred.make<void>();
      const layerHost = Layer.succeed(
        HostPowerMonitor.HostPowerMonitor,
        HostPowerMonitor.HostPowerMonitor.of({
          snapshot: Effect.succeed(nominalHostPower),
          report: () => Effect.void,
          streamChanges: Stream.empty,
        }),
      );
      // Settings are read after the leases, so a held read keeps a stale lease set in flight.
      const layerSettings = Layer.effect(
        ServerSettings.ServerSettingsService,
        Effect.gen(function* () {
          const settings = yield* ServerSettings.ServerSettingsService;
          const gate = Ref.getAndSet(blockNextSettingsRead, false).pipe(
            Effect.flatMap((block) =>
              block
                ? Deferred.succeed(blockedSnapshotStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseBlockedSnapshot)),
                  )
                : Effect.void,
            ),
          );
          return ServerSettings.ServerSettingsService.of({
            ...settings,
            getSettings: gate.pipe(Effect.andThen(settings.getSettings)),
          });
        }),
      ).pipe(Layer.provide(ServerSettings.layerTest()));
      const layer = BackgroundPolicy.layer.pipe(
        Layer.provide(Layer.merge(layerHost, layerSettings)),
      );

      yield* Effect.gen(function* () {
        const policy = yield* BackgroundPolicy.BackgroundPolicy;
        const subscription = yield* policy.subscribe;
        const updatesFiber = yield* subscription.changes.pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        // Hold the report's publication open while the removal queues behind it.
        yield* Ref.set(blockNextSettingsRead, true);
        const reportFiber = yield* policy
          .reportClientActivity(AuthSessionId.make("session-1"), RpcClientId.make(1), makeReport())
          .pipe(Effect.forkChild);
        yield* Deferred.await(blockedSnapshotStarted);
        const removeFiber = yield* policy
          .removeRpcClient(AuthSessionId.make("session-1"), RpcClientId.make(1))
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseBlockedSnapshot, undefined);
        yield* Fiber.join(reportFiber);
        yield* Fiber.join(removeFiber);
        const updates = Array.from(yield* Fiber.join(updatesFiber));

        assert.equal(subscription.latest.activeForegroundLeaseCount, 0);
        assert.equal(updates.at(-1)?.activeForegroundLeaseCount, 0);
        assert.deepStrictEqual(updates.at(-1)?.activeScopeKeys, []);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  it.effect("bounds client-id churn for one websocket connection", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      const sessionId = AuthSessionId.make("session-1");
      const rpcClientId = RpcClientId.make(1);
      for (
        let index = 0;
        index <= BackgroundPolicy.MAX_CLIENT_ACTIVITY_LEASES_PER_RPC_CLIENT;
        index += 1
      ) {
        yield* policy.reportClientActivity(
          sessionId,
          rpcClientId,
          makeReport({ clientId: `client-${index}` }),
        );
      }

      const snapshot = yield* policy.snapshot;
      assert.equal(
        snapshot.leases.length,
        BackgroundPolicy.MAX_CLIENT_ACTIVITY_LEASES_PER_RPC_CLIENT,
      );
      assert.isTrue(
        snapshot.leases.some(
          (lease) =>
            lease.clientId ===
            `client-${BackgroundPolicy.MAX_CLIENT_ACTIVITY_LEASES_PER_RPC_CLIENT}`,
        ),
      );
    }).pipe(Effect.provide(layerFor(nominalHostPower))),
  );

  it.effect("host suspension disables scoped and opportunistic work", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        RpcClientId.make(1),
        makeReport(),
      );

      const snapshot = yield* policy.snapshot;
      assert.equal(snapshot.activeForegroundLeaseCount, 1);
      assert.equal(snapshot.shouldRunOpportunisticWork, false);
      assert.equal(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/repo" }), false);
    }).pipe(
      Effect.provide(
        layerFor({
          ...nominalHostPower,
          suspended: true,
          stale: false,
        }),
      ),
    ),
  );

  it.effect("keeps background demand visible while preventing scoped work", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        RpcClientId.make(1),
        makeReport({ focused: false, visible: false }),
      );

      const snapshot = yield* policy.snapshot;
      assert.equal(snapshot.activeForegroundLeaseCount, 0);
      assert.deepStrictEqual(snapshot.activeScopeKeys, ["vcs-status:/repo"]);
      assert.equal(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/repo" }), false);
    }).pipe(Effect.provide(layerFor(nominalHostPower))),
  );

  it.effect("keeps scoped work active after a recently used visible window loses focus", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        RpcClientId.make(1),
        makeReport({ focused: false, recentlyInteracted: true }),
      );

      const snapshot = yield* policy.snapshot;
      assert.equal(snapshot.activeForegroundLeaseCount, 1);
      assert.equal(snapshot.shouldRunOpportunisticWork, true);
      assert.equal(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/repo" }), true);
    }).pipe(Effect.provide(layerFor(nominalHostPower))),
  );

  it.effect("battery saver profile pauses scoped work on battery", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        RpcClientId.make(1),
        makeReport(),
      );

      assert.equal(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/repo" }), false);
    }).pipe(
      Effect.provide(
        layerFor(
          {
            ...nominalHostPower,
            onBattery: "true",
            stale: false,
          },
          { backgroundActivityProfile: "battery-saver" },
        ),
      ),
    ),
  );

  it.effect("does not gate work on stale host power values", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        RpcClientId.make(1),
        makeReport(),
      );

      assert.equal(yield* policy.shouldRunScopeWork({ type: "vcs-status", cwd: "/repo" }), true);
    }).pipe(
      Effect.provide(
        layerFor(
          {
            ...nominalHostPower,
            locked: "true",
            onBattery: "true",
            lowPowerMode: "true",
            thermalState: "critical",
            stale: true,
          },
          { backgroundActivityProfile: "battery-saver" },
        ),
      ),
    ),
  );

  it("counts the user as present only while a live lease is visible, focused, and in use", () => {
    const lease: ClientActivityLease = {
      sessionId: AuthSessionId.make("session-1"),
      rpcClientId: RpcClientId.make(1),
      clientId: "client-1",
      clientKind: "mobile",
      visible: true,
      focused: true,
      recentlyInteracted: true,
      scopes: [],
      updatedAt: TEST_NOW,
      expiresAt: DateTime.add(TEST_NOW, { seconds: 45 }),
    };
    const isPresent = (overrides: Partial<ClientActivityLease>, now = TEST_NOW) =>
      BackgroundPolicy.isUserPresentLease({ ...lease, ...overrides }, now);

    assert.equal(isPresent({}), true);
    assert.equal(isPresent({ visible: false }), false);
    assert.equal(isPresent({ focused: false }), false);
    // Focused on a client but idle: the user may have walked away, so ring.
    assert.equal(isPresent({ recentlyInteracted: false }), false);
    assert.equal(isPresent({}, DateTime.add(TEST_NOW, { seconds: 45 })), false);
  });

  it.effect("stops reporting the user present once their lease expires, before any sweep", () =>
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.BackgroundPolicy;
      assert.equal(yield* policy.isUserPresent, false);

      yield* policy.reportClientActivity(
        AuthSessionId.make("session-1"),
        RpcClientId.make(1),
        makeReport({ clientId: "idle", recentlyInteracted: false }),
      );
      assert.equal(yield* policy.isUserPresent, false);

      yield* policy.reportClientActivity(
        AuthSessionId.make("session-2"),
        RpcClientId.make(2),
        makeReport({ clientId: "in-use", clientKind: "mobile", ttlMs: 1_000 }),
      );
      assert.equal(yield* policy.isUserPresent, true);

      yield* TestClock.adjust("1 second");
      assert.equal(yield* policy.isUserPresent, false);
    }).pipe(Effect.provide(layerFor(nominalHostPower))),
  );
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@lecturn/contracts";
import * as IdAllocator from "@lecturn/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@lecturn/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@lecturn/provider-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";
import { ScriptedDriver, withTestProviderDrivers } from "./Drivers/ScriptedDriver.ts";

const driverKinds = (environment: NodeJS.ProcessEnv) =>
  withTestProviderDrivers(BUILT_IN_DRIVERS, environment).map((driver) => String(driver.driverKind));

describe("ScriptedDriver", () => {
  it("is not registered unless LECTURN_TEST_PROVIDERS is 1", () => {
    assert.notInclude(driverKinds({}), "scripted");
    assert.notInclude(driverKinds({ LECTURN_TEST_PROVIDERS: "true" }), "scripted");
    assert.notInclude(driverKinds({ LECTURN_TEST_PROVIDERS: "0" }), "scripted");
    assert.deepEqual(driverKinds({ LECTURN_TEST_PROVIDERS: "1" }), [
      ...driverKinds({}),
      "scripted",
    ]);
  });

  it.effect("reports a ready snapshot offering every runtime mode", () =>
    Effect.gen(function* () {
      const instance = yield* ScriptedDriver.create({
        instanceId: ProviderInstanceId.make("scripted"),
        displayName: undefined,
        environment: [],
        enabled: true,
        config: ScriptedDriver.defaultConfig(),
      });
      const snapshot = yield* instance.snapshot.getSnapshot;
      assert.equal(snapshot.status, "ready");
      // RuntimePolicy downgrades any mode missing here to approval-required.
      assert.deepEqual(snapshot.supportedRuntimeModes, [
        "approval-required",
        "auto-accept-edits",
        "auto",
        "full-access",
      ]);
      assert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["scripted"],
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(TestProviderHost.layer(), IdAllocator.layer, McpProviderSessions.layer).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
});

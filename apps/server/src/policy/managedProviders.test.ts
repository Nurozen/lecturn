import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  type ServerSettings,
} from "@lecturn/contracts";

import { BUILT_IN_DRIVERS } from "../provider/builtInDrivers.ts";
import { makeManagedProviders } from "./managedProviders.ts";

const configFieldsOf = (schema: object): ReadonlyArray<string> =>
  "fields" in schema ? Object.keys(schema.fields as object) : [];

const driverKinds = BUILT_IN_DRIVERS.map((driver) => driver.driverKind);
const pathDriverKinds = BUILT_IN_DRIVERS.filter((driver) =>
  configFieldsOf(driver.configSchema).includes("binaryPath"),
).map((driver) => driver.driverKind);

// Every driver the server registers, fork drivers included, so a new one cannot slip the policy.
describe("makeManagedProviders covers every registered driver", () => {
  it("finds the drivers with a binary path", () => {
    assert.isAbove(pathDriverKinds.length, 3);
  });

  it.each(driverKinds)("lets allowedDrivers name %s", (kind) => {
    const result = makeManagedProviders({ allowedDrivers: [kind] }, undefined, "darwin");
    assert.equal(result._tag, "Valid");
    if (result._tag === "Valid") assert.isTrue(result.providers.isDriverAllowed(kind));
  });

  it.each(pathDriverKinds)("takes the %s binary path under maxRuntimeMode", (kind) => {
    const result = makeManagedProviders({}, "auto-accept-edits", "darwin");
    assert.equal(result._tag, "Valid");
    if (result._tag !== "Valid") return;
    const instanceId = ProviderInstanceId.make(`${kind}_wrapped`);
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: { driver: kind, config: { binaryPath: "/tmp/wrapper" } },
      },
    } as ServerSettings;
    const config = result.providers.applyLimits(settings).providerInstances[instanceId]?.config;
    assert.isUndefined((config as Record<string, unknown> | undefined)?.binaryPath);
  });
});

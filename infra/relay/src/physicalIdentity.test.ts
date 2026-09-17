import { describe, expect, it } from "vite-plus/test";
import {
  RELAY_STACK_NAME,
  RELAY_PRODUCTION_DATABASE_NAME,
  relayPhysicalName,
} from "./physicalIdentity.ts";
import { relayResourceNameForStage } from "./deploymentConfig.ts";

describe("production infrastructure upgrade identity", () => {
  it("retains the deployed state and storage namespace across the product rebrand", () => {
    expect(RELAY_STACK_NAME).toBe("T3CodeRelay");
    expect(RELAY_PRODUCTION_DATABASE_NAME).toBe("t3coderelay");
    expect(
      relayResourceNameForStage(relayPhysicalName("lecturn-relay-traces", "prod"), "prod"),
    ).toBe("t3-code-relay-traces-prod");
    expect(
      relayResourceNameForStage(relayPhysicalName("lecturn-mobile-otel-ingest", "prod"), "prod"),
    ).toBe("t3-code-mobile-otel-ingest-prod");
  });
  it("keeps new development observability resources isolated from production", () => {
    expect(
      relayResourceNameForStage(relayPhysicalName("lecturn-relay-traces", "dev_demo"), "dev_demo"),
    ).toBe("lecturn-relay-traces-dev-demo");
  });
});
